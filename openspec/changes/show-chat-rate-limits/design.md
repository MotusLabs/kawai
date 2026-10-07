# Design

## Context

See proposal.md for motivation; requirements are in `specs/chat-usage-limits`.

- Kawai chat sessions run Claude Code through the Agent SDK (0.3.289). Claude Code makes the model HTTP requests itself; Kawai only sees its stream-json messages. `ChatSessionDriver.handleSdkMessage` switches on known message types and ignores the rest, including `rate_limit_event`.
- The SDK exposes three distinct sources of plan usage, and nothing in `src/` consumes any of them today:
  - **Push — `rate_limit_event`** (`SDKRateLimitInfo`): `status` (`allowed` | `allowed_warning` | `rejected`), one `rateLimitType` (`five_hour`, `seven_day`, `seven_day_opus`, `seven_day_sonnet`, …), `utilization`, `resetsAt`, and overage fields. A 2026-10-07 probe also showed an undocumented `unifiedWindows: { five_hour, seven_day }` sibling carrying both windows in one event.
  - **Push — `SDKUsageReport`** on an assistant message: the structured twin of `/usage`, with `rate_limits.limits[]` rows (`kind`, `group`, `percent` 0–100, `resets_at` ISO, `scope.model.display_name`, `severity`, `is_active`). Present only on `/usage` results from new enough CLIs and claude.ai-subscriber sessions.
  - **Pull — `query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true })`** → `SDKControlGetUsageResponse`: `subscription_type`, `rate_limits_available`, and typed `rate_limits` (`five_hour`, `seven_day`, `seven_day_opus`, `seven_day_sonnet`, `seven_day_oauth_apps`, `model_scoped[]`, `extra_usage`). The name and its doc comment state the API is unstable and may change or be removed in any release.
- `ChatSessionDriver.send()` spawns the SDK query lazily on the first turn; `ChatSessionManager` documents this as deliberate ("the first turn pays the spawn cost, creation never"). No query means no pull.
- `add-chat-activity-indicator` (landed) is the delivery precedent: an additive `ChatActivity` type in `src/shared/chat.ts`, a pure SDK-free reducer in `src/server/chat/chatActivity.ts`, a `chat-snapshot.activity` field plus an ephemeral `chat-activity` server message, and `ChatActivityRow.tsx` in the chat view. This change mirrors that shape.
- Probes on 2026-10-07 found no usage or rate-limit headers from the GLM, MiMo, and Kimi endpoints; recorded GLM sessions received only `{ status: 'allowed', isUsingOverage: false }`. MiniMax could not be checked without a key.
- Profiles are server-owned (`ClaudeProfiles.ts`); every driver knows its `claudeProfileId`.

## Goals / Non-Goals

**Goals:** show plan allowance from data Claude Code already emits, filling gaps from the SDK pull request; normalize three differently-shaped sources into one report; degrade to showing nothing when a provider sends nothing.

**Non-Goals:** token-count headers (`anthropic-ratelimit-*-tokens-*`); provider-specific quota APIs; usage for terminal sessions; session cost or token totals (already on `turn_completed`); the full `/usage` twin (extra-usage spend, behaviors attribution); persisting reports across restarts; budget alerts or blocking sends.

## Decisions

### 1. Push first, pull as fallback

Accept pushed reports whenever they arrive and treat the pull request as gap-filling, not as a poll. The pull runs once per profile per server lifetime: when a query first spawns for a profile that holds neither a report nor a recorded "no data" verdict. A pull that returns `rate_limits_available: false`, or no windows, or throws, records that verdict so later turns do not retry it — a provider that reports nothing (GLM, MiMo, …) would otherwise pay a wasted control round-trip on every turn. Any later push still overwrites the verdict.

`skipBehaviors: true` keeps the call off the local-transcript scan; this change only needs the plan windows.

Alternatives considered:
- **Poll the pull API on a timer.** Rejected: it spends control round-trips on sessions whose providers will never answer, and pushed data is already fresher.
- **Pull only.** Rejected: it depends wholly on an API whose name says not to rely on it.
- **Push only (the previous revision of this change).** Rejected: a report arrives only after a turn has run, so the bar stays empty until then even when the account has a live plan.
- **Read HTTP headers through a Kawai proxy** set as `ANTHROPIC_BASE_URL`, or **call Anthropic's OAuth usage endpoint with the stored credential**. Both rejected as before: the token headers are not sent for subscription traffic, proxying streamed model traffic is security-sensitive, and reading the user's OAuth credential against an undocumented endpoint is ruled out by `replace-claude-sdk-with-cli`.

### 2. One normalized report shape

Parse every source into a Kawai-owned `ChatUsageReport { status, windows: ChatUsageWindow[], receivedAt }` where `ChatUsageWindow` is `{ key, label, percentUsed, resetsAt }` (`key` is the meter kind such as `five_hour` or `seven_day_opus`; `label` is the display text; `resetsAt` is ISO or null). `status` is `allowed` | `warning` | `limited`.

The three sources disagree on both vocabulary and scale — `SDKRateLimitInfo.utilization` and the probe's `unifiedWindows` are 0–1 fractions, `SDKUsageReport.limits[].percent` and the pull's `rate_limits.*.utilization` are 0–100. The parser normalizes to percent 0–100 and rejects values that are not finite numbers or fall outside 0–100 after normalization, treating a bare 0–1 fraction as a percent only when the source is known to report fractions. Unknown `status` values map to `allowed`. Windows are keyed by meter kind, never by display label, so a new server meter needs no client release to render. A report without windows updates `status` and `receivedAt` but keeps the windows already held.

The parser lives in a new `src/server/chat/usageLimits.ts` with fixture tests from all three source shapes: the 2026-10-07 probe payload, an `SDKUsageReport` `limits[]` array, a pull response, the GLM status-only payload, and malformed values. Keeping it SDK-free and structurally matched (as `chatActivity.ts` is) lets `replace-claude-sdk-with-cli` reuse it.

### 3. Latest report per profile, in memory

`usageLimits.ts` also holds `UsageLimitStore`: profile id → latest report or a "no data" verdict, a merge rule (a report without windows keeps earlier windows; older data never overwrites newer), and a change listener. The driver gets `onRateLimit`/`onUsageReport` options alongside `onActivity`, and the manager wires them to `store.record(profileId, …)`. Memory only: a report from before a restart could be hours stale and mislead, and the spec allows the bar to be absent after a restart.

### 4. Delivery mirrors `chat-activity`

`chat-snapshot` gains `usage: ChatUsageReport | null` for the session's profile, and a new `{ type: 'chat-usage'; profileId; report: ChatUsageReport | null }` server message goes once to each connection subscribed to at least one session of that profile. The client keeps reports per profile in `chatStore`, so every session of a profile renders the same data. Older clients ignore the new field and message; the messages are documented as additive.

Scoped by profile rather than session because the underlying allowance is per account and provider.

### 5. Usage bar under the chat header

A new `src/client/components/chat/UsageBar.tsx` renders directly under the `ChatView` `<header>`, above the error banner and the transcript column. One thin utilization meter per known window: label, fill width from `percentUsed`, the rounded percent, and the reset time in the browser's locale (weekday name when more than a day away). `warning` uses the warning colour and `limited` the error colour from the chat palette. The bar renders only when the profile has window data — it is "always-visible" in the sense of glanceable chrome that never has to be opened, not a placeholder shown when there is nothing to report.

Both the bar and its meters are omitted when a window is missing rather than shown as empty, so a provider that reports only the 5-hour window gets a one-meter bar.

## Risks / Trade-offs

- [Experimental pull API] It may change or be removed in any release. → It is only a fallback behind pushed data; the call is wrapped so a throw or a shape change records the "no data" verdict instead of failing the session; tests pin today's shape and the display hides missing windows rather than erroring. If the method disappears, typecheck fails loudly rather than the chat breaking at runtime.
- [Fraction vs percent ambiguity] The sources disagree on scale. → Normalization is explicit per source and covered by fixtures; out-of-range values are dropped rather than rendered wrong.
- [Nothing before the first turn] Lazy spawn means no query, so no pull and no bar, until a turn begins. → Accepted and stated in the spec; paying a spawn at open time just for usage would contradict the deliberate lazy-spawn cost decision.
- [Push may be sparse] `rate_limit_event` carries one window at a time unless `unifiedWindows` is present, and `SDKUsageReport` only arrives with `/usage`. → The merge rule keeps the best of both, and the pull fills the initial gap.
- [Shared account across profiles] Two profiles using the same Anthropic account would track separately. → Only `default` uses Anthropic auth today; acceptable.
- [Transport replacement] `replace-claude-sdk-with-cli` must keep forwarding `rate_limit_event` and the pull request. → Task 4.1 records it in that change's design; the parser is transport-agnostic for the same reason `chatActivity.ts` is.
- [Snapshot/header overlap] `add-chat-slash-commands` also touches the snapshot type and chat chrome. → Follow the already-landed `chat-activity` additive pattern; whichever of this change and `add-chat-slash-commands` lands second rebases.

## Migration Plan

No data migration. Old clients ignore the new snapshot field and message. Rollback removes the bar and the store; nothing is persisted, so there is nothing to clean up.
