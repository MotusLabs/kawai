# Design

## Context

See proposal.md (Why) for the gaps. The current state that shapes the approach:

- **Catalog.** Since `providers-and-workers`, `providers.json` groups models under providers (`catalogParse.ts`, `profileCatalog.ts`). A provider may set `label`, `env`, `limitResetTimeZone`, `executable` and `models`. `env` keys are limited to `PROFILE_CONTROLLED_ENV`, which deliberately leaves out credentials. Files have tiers: the shipped default, then the user level `~/.kawai`, which is operator-owned and trusted, then project levels, which agents can write. Only trusted tiers may name an `executable`.
- **Launch.** `resolveClaudeProfile` (`ClaudeProfiles.ts`) starts from `effectiveChatEnv(globalEnv)`, which is `process.env` plus Settings or `AGENTBOARD_CHAT_ENV`, credentials included. It then blanks and re-applies the controlled variables and passes the controlled set as flag-layer settings. A profile with no overrides returns no `env`, so the SDK child inherits `process.env` whole. Agents' Bash tools inherit whatever the CLI receives.
- **Auth gate.** `hasClaudeAuth` accepts an API key, an auth token, an OAuth token, or the host `.credentials.json`.
- **Usage.** `ChatSessionManager.claimProfileUsagePull` probes the Z.AI quota endpoint at the base URL's origin with the session's effective token. On success it suppresses the host-login SDK pull and refreshes every 10 minutes while a session of that provider has a started agent. `providers-and-workers` section 5 moves this keying from profile to provider. Reports are `ChatUsageReport { status, windows[], receivedAt, source }`, and window labels are server text.
- **Limits.** `limitSignals.ts` counts the classes `rate_limit`, `billing_error` and `overloaded`, plus status 429. Cooldown is the latest final event's reset, or one hour after the event when no reset is known. `providers-and-workers` section 4, landed in #219, adds `provider_id` and `limit_window` to `profile_limit_events`, plus provider-wide cooldown (`cooldownFor`).
- **Turn cost.** `ChatSessionDriver` maps the result's `total_cost_usd` into `turn_completed.totalCostUsd`, and `ChatMessages.tsx` prints it. The driver already runs with `includePartialMessages: true`, so raw `stream_event` frames reach it. Turn ends are not replayed (`chat_turn_ends` keeps no cost), so the cost line exists only for live turns.

Spike evidence (2026-10-18, Claude Code 2.1.302, one capped key deleted afterwards):

| Probe | Observation |
|---|---|
| `GET /api/v1/key`, inference key with a $0.05 cap | `limit`, `limit_remaining`, `limit_reset: null`, and `budgets[]` / `effective_budget` holding a `key_limit` budget (`limit_usd`, `spend_usd`, `remaining_usd`, `reset_interval: null`, `resets_at: null`). `is_management_key: false`. |
| `GET /api/v1/key`, management key | 200 with `is_management_key: true` and an `expires_at`. `limit` and the remaining fields are null, and `budgets` is empty. |
| `GET /api/v1/credits` | Management key: `{ data: { total_credits, total_usage } }`. Inference key: 403 "Only management keys can fetch credits for an account". |
| `POST /api/v1/messages` with a management key | 401 `authentication_error` "User not found." |
| Raw `/messages`, both streamed and not | `usage.cost` (USD), `cost_details`, `is_byok`, top-level `provider`, header `x-generation-id: gen-…`. The message id is `msg_…`. |
| One Claude Code turn | `stream_event` `message_delta.usage.cost = 0.001064075`. The result's `total_cost_usd = 0.042563`. stderr: `[claude-code:unrecognized_model]`. |
| A request over the cap | Raw: HTTP 402 `{type:"billing_error", message:"…can only afford 9957…", error_type:"payment_required"}`, with no `metadata` and no `Retry-After`. Through Claude Code: no `api_retry`; a synthetic assistant message with `error: "unknown"` and text `API Error: 402 …`; the result has `is_error: true`. |

## Goals / Non-Goals

**Goals:**
- One provider's key reaches only that provider's sessions, and no agent can read a balance key.
- The usage bar for OpenRouter shows OpenRouter's own figures, never the host login's.
- An exhausted balance stops routing to the provider promptly and never parks work.

**Non-Goals:**
- Per-session or per-group keys. The credential belongs to the provider, as cooldown and usage do.
- Storing secrets anywhere kawai writes: SQLite, catalog files, logs, wire capture.
- Spend analytics. `chat_turn_usage` and process metrics stay tokens-only.
- Automatic recovery from the reservation 402 by retrying with fewer tokens. The owner sets `CLAUDE_CODE_MAX_OUTPUT_TOKENS` instead.
- MiMo balance, which has no API, and LiteLLM.
- OpenRouter routing preferences (`provider.order`/`only`) and fast mode.

## Decisions

### D1. Credentials by environment variable name, on trusted providers only

A provider gains two optional fields: `authTokenEnv` and `balanceKeyEnv`. Each takes the name of a server environment variable, matching `^[A-Z_][A-Z0-9_]*$`. They are accepted only in the shipped default and user-level `providers.json`. In a project-level file, or in any `profiles.json`, they reject the file with an actionable error, the same way `executable` does. The value is read from the effective server environment at each launch, with Settings or `AGENTBOARD_CHAT_ENV` applied over `process.env`. The catalog never holds a secret, so the existing rule that catalog files carry no credentials still holds.

- *Alternative: inline keys in user-level files.* Rejected. It breaks the "safe to commit and mount" property, and the files are displayed and diffed.
- *Alternative: an executable wrapper.* This keeps working, but it puts the empty-`ANTHROPIC_API_KEY` requirement on every operator, and kawai cannot then withhold the key from other sessions.
- *Alternative: a secrets store or keychain.* No such store exists in kawai yet, and it is out of scope.

### D2. A credentialed provider's route is fixed by trusted tiers

Once a provider has `authTokenEnv` or `balanceKeyEnv` from a trusted tier, a project-level file may not set its `ANTHROPIC_BASE_URL`. Such a file is rejected whole, naming the provider and the reason, and the rest of the catalog still resolves. Model mappings and labels stay overlayable.

Without this rule, an agent-written `.kawai/providers.json` could point `openrouter` at a host the agent controls and receive the key in `Authorization`. The same logic is why D1 refuses the name fields in project files: naming `GITHUB_TOKEN` would make a secret travel to the provider's host.

The rule covers every value, the empty string included. An overlay setting `ANTHROPIC_BASE_URL: ""` is rejected like any other value, never read as "not set": a blank base URL would send the key to the CLI's default host.

Two trusted-tier rules close the remaining routes:

- **A credentialed provider must have a base URL.** A trusted file that gives a provider `authTokenEnv` or `balanceKeyEnv` while the merged trusted tiers leave its `ANTHROPIC_BASE_URL` absent or empty is rejected, naming the provider. The key then always has one known destination, which D3 pins.
- **A credentialed provider cannot name an executable.** A file that sets `executable` on such a provider, or on one of its models, is rejected, naming the provider and the field. This is a refusal, not a pin. An executable-backed profile deliberately gets no flag settings layer (`ClaudeProfiles.ts`), because the wrapper owns provider configuration and inline settings would override its exports. Pinning the base URL there would defeat that delegation, and leaving it unpinned would let a settings file, or the wrapper itself, send the key anywhere. An operator who needs a wrapper keeps today's option: the wrapper sets its own key, and the provider names no `authTokenEnv`.

### D3. Withholding named credentials from every agent

Every launch, under every profile, builds an explicit `env` and removes from it every variable named by any `authTokenEnv` or `balanceKeyEnv` in the catalog resolved for that project path. A launch that would otherwise inherit `process.env` (the no-override default) passes the filtered copy instead. Executable-backed profiles are filtered too; a wrapper that needs a key sets its own.

For a credentialed provider's sessions, after filtering, kawai sets:
- `ANTHROPIC_AUTH_TOKEN` to the named variable's value;
- `ANTHROPIC_API_KEY` to the empty string;
- `CLAUDE_CODE_OAUTH_TOKEN` to the empty string.

The two blanks go in both the process env and the flag-layer `settings.env`. That is the same mechanism that already neutralizes user and project settings for controlled variables, so a settings file cannot reintroduce them. The balance key is never set in any agent environment.

**The base URL is pinned on every launch that carries the key.** Any launch that sets `ANTHROPIC_AUTH_TOKEN` from an `authTokenEnv` value also sets `ANTHROPIC_BASE_URL` to the provider's trusted base URL (D2), in both the process env and the flag-layer `settings.env`. This holds whatever path `resolveClaudeProfile` takes. Today only the overrides path builds a settings layer, and the no-override path returns none. A launch that receives a key always builds the layer, even when the profile sets nothing else, and the executable path never receives a key (D2). Without the pin, user or project Claude settings `env.ANTHROPIC_BASE_URL` would outrank the process env and send the bearer token to a host an agent chose. Any agent can write a project's `.claude/settings.json`, including an agent in a GLM session that never sees the key, and the next `openrouter` session would then deliver it.

The transport variables are pinned the same way, because a settings file could otherwise route or intercept the same request: `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY`, `NODE_TLS_REJECT_UNAUTHORIZED` and `NODE_EXTRA_CA_CERTS`. Each is pinned to the server environment's own value, or to empty when that is unset, so an operator's proxy keeps working. Task 1.1 confirms which of them Claude Code reads from settings `env`; the set is recorded here before code lands.

The token itself is never put in the flag layer. That layer is a launch argument the SDK builds, and a token there could show up in the host's process list. A settings file that sets `ANTHROPIC_AUTH_TOKEN` can at worst replace the token with another one. It cannot read this one or move it to another host.

A credentialed session's own agent can still read its inference key as `ANTHROPIC_AUTH_TOKEN` through its Bash tool. That is inherent in giving the CLI the key, and it is why the key should be capped. Withholding protects every other session and the balance key; the pin protects the key against redirection by files that other agents write.

The name set comes from the resolved catalog, never from Settings. Removing a provider's entry therefore stops withholding its variables, and that is documented. `chatProviderEnv.ts` gains one helper, `withheldCredentialNames(catalog)`. Both the launch path and the availability probe use it, so a probe never sees more than a launch does.

### D4. Auth for a credentialed provider is its own variable

`authOk` for a session whose provider has `authTokenEnv` is true exactly when that variable is non-empty. It never falls back to the host login or another credential, because that would send the wrong secret to OpenRouter, or none at all. The refusal names the variable: "Provider OpenRouter needs OPENROUTER_API_KEY in the server environment." Account notices (login expiry) are skipped for these sessions, since the host `.credentials.json` is not their login.

### D5. Shipped provider

```json
"openrouter": {
  "label": "OpenRouter",
  "authTokenEnv": "OPENROUTER_API_KEY",
  "balanceKeyEnv": "OPENROUTER_MANAGEMENT_KEY",
  "env": {
    "ANTHROPIC_BASE_URL": "https://openrouter.ai/api",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "~anthropic/claude-opus-latest[1m]",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "~anthropic/claude-sonnet-latest[1m]",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "~anthropic/claude-haiku-latest",
    "ANTHROPIC_DEFAULT_FABLE_MODEL": "~anthropic/claude-opus-latest[1m]"
  },
  "models": {
    "openrouter-opus": { "label": "OpenRouter Opus", "model": "opus" },
    "openrouter-sonnet": { "label": "OpenRouter Sonnet", "model": "sonnet" },
    "openrouter-haiku": { "label": "OpenRouter Haiku", "model": "haiku" }
  }
}
```

- `[1m]` affects only Claude Code's assumption about the context window; OpenRouter strips it before routing.
- Fable maps to Opus because OpenRouter documents no Fable slug. This is the same pin-every-tier rule the GLM entries follow.
- The picker always lists the provider. Creating a session without the key gives D4's refusal, never a half-started agent.
- *Alternative: don't ship it, and document an example instead.* Rejected. The trust rules (D1, D2) are easiest to get right in the shipped file, and the base URL is public.

### D6. The OpenRouter usage adapter

`openRouterUsage.ts` sits beside `zaiUsage.ts`. It is SDK-free and checks response shapes strictly. It is chosen when the provider's effective base URL host is `openrouter.ai` or one of its subdomains. For such a provider the Z.AI probe is never made, and the host-login SDK pull is suppressed for good, even when the pull is refused.

The current `chat-usage-limits` text says the opposite for any provider with a base URL: it always probes the quota endpoint and falls back to the host login when no quota data comes. This change therefore MODIFIES two requirements, "Usage is refreshed when no report has arrived" and "Provider plan usage is pulled from the provider quota endpoint", with a carve-out for "a provider whose own usage endpoint is selected". The ADDED requirement "OpenRouter providers are pulled from the OpenRouter key endpoint" defines that term and stays the specific source.

"Quota failures distinguish missing routes from authentication refusals" is not modified. Its rules govern responses from the quota endpoint, which is never requested for such a provider. The ADDED requirement states that carve-out explicitly: the quota-failure fallback rules do not apply, and no failure of the provider's own pulls enables the host-login pull. A missing `/api/v1/key` route, a 5xx response or a transport error therefore leaves the bar empty rather than showing the Claude plan.

- **The key pull.** `GET <origin>/api/v1/key` with the session's effective `ANTHROPIC_AUTH_TOKEN`.
  - Each entry of `budgets[]` becomes one meter:
    - key `openrouter:<scope>[:<budget_id|guardrail_id>]`;
    - label "Key cap", "Daily budget", "Weekly budget", "Monthly budget" or "Workspace budget", followed by ` · $<remaining> left`;
    - `percentUsed = spend_usd / limit_usd × 100`, clamped to 0–100;
    - `resetsAt` from `resets_at`;
    - `periodMs` of 24 h for `daily` and 7 d for `weekly`. It is absent for `monthly` (variable length, never guessed) and for a `null` interval.
  - If `budgets` is missing but `limit` is set, one "Key cap" meter comes from `limit` and `limit_remaining`.
  - An uncapped key yields no key meters.
- **The credits pull.** This runs only when `balanceKeyEnv` is set and non-empty: `GET <origin>/api/v1/credits` with that value, made from the server process.
  - The meter is "Credits · $<total_credits − total_usage> left", with `percentUsed = total_usage / total_credits × 100`. It has no reset and no period.
  - A 401 or 403 from this call is logged once per value and drops only the credits meter.
- **Status.** The report is `limited` when any meter's remaining amount is ≤ 0, otherwise `allowed`. Its source is `provider`.
- **No meters at all** (an uncapped key and no balance key) records the existing no-data verdict, so no bar shows.
- **A key-pull 401/403** records no data and keeps the host-login pull suppressed.

The report also carries, in memory only, the smallest remaining amount over its meters (`remainingUsd`). D8 uses it.

The pulls run once per provider. While a non-archived session of the provider has a started agent, they refresh on the same 10-minute cadence as quota-serving providers, and they stop when no session qualifies. Per-provider keying comes from `providers-and-workers`. The cadence is stated in the ADDED requirement "OpenRouter usage refreshes while sessions are live and after a costed turn", because "Provider usage stays fresh while sessions are live" covers only quota-serving providers, in master's text and in both active rewrites. That requirement is left unmodified. `process-observability`'s background quota observation for configured team workers is not extended to these pulls; a later change can add an OpenRouter standalone reader. In addition, a completed turn that carried `providerCostUsd` (D9) schedules one extra pull for its provider 30 s later, at most one per provider per minute.

- *Alternative: compute remaining from summed turn costs.* Rejected. It misses spend outside kawai and Claude Code's unstreamed side calls; the pull is the truth.
- *Alternative: poll `/generation`.* Rejected. It needs the `gen-` id, which Claude Code never shows, and the stream already carries the cost.

### D7. A 402 is a final credit limit, whatever the error class

`assistantLimitSignal` and `retryLimitSignal` treat HTTP status 402 as a limit. The status is read from the class or from the `API Error: <status>` text, as 429 is today. A 402 signal is always final; a 402 that Claude Code retries (none observed) still counts as final, because waiting does not create credit. The event is recorded with `limit_window = 'credit'` and no reset.

Detection depends only on the status, not on OpenRouter's message. MiMo pay-as-you-go returns a 402 on a negative balance too (unverified), and any other prepaid gateway will be caught the same way.

### D8. A credit cooldown is bounded and never parks

A final `credit` event cools the provider through `providers-and-workers`' `cooldownFor`. It uses the existing rule when no reset is known: one hour after the event. It ends earlier once a usage pull completed after the event reports a `remainingUsd` greater than the lowest `remainingUsd` seen for that provider since the event, or greater than zero when no pull came between.

The early end is an in-memory overlay on the cooldown computation, keyed by provider and event time. After a restart the plain one-hour rule applies, so no state can leave a provider cooling forever.

Limit outcomes treat a credit event as having no reset within any `parkIfResetWithin`, and take the group's `otherwise` branch. Forwards skip the cooling provider, as `providers-and-workers` D9 already does. The waiting reason and the urgent-mail refusal say "out of credit" instead of naming a reset time.

- *Alternative: an open-ended cooldown until credit returns.* Rejected. After a restart, or for a provider with no balance source, nothing would ever end it.
- *Alternative: let the human clear it.* That would need new UI. The one-hour bound plus the pull overlay covers it.

### D9. The provider-reported turn cost

The driver keeps a per-turn accumulator. Each `stream_event` whose event is `message_delta` with a finite, non-negative `usage.cost` adds to it, including subagent streams when they are streamed. On the result, `turn_completed` gains an optional `providerCostUsd` when at least one delta carried a cost. `ChatMessages.tsx` shows `$<providerCostUsd>` in place of `totalCostUsd` when it is present, with hover text saying it is the provider-reported charge, and that calls Claude Code did not stream (such as session titles) are not included. The field is additive and the SDK estimate stays on the event.

## Risks / Trade-offs

- **[Risk] Claude Code may prefer the host claude.ai login over `ANTHROPIC_AUTH_TOKEN`.** The spike used a fresh `CLAUDE_CONFIG_DIR`. → Task 1.1 verifies under the host config dir, with a login present, that the request reaches OpenRouter and is charged to the key (`/key` usage grows). If the login wins, D3 also points `CLAUDE_CONFIG_DIR` at a per-provider config directory, and that is recorded in this design before any code lands.
- **[Risk] A withheld variable still reaches processes kawai does not launch through the SDK**, such as terminal sessions in tmux and kawai's own git or `gh` spawns. → Document that the keys belong in the kawai server's environment only, not the shell profile tmux reads. Kawai's own spawns run kawai code, not agent code.
- **[Risk] `unrecognized_model` aliases** give Claude Code a 200k window for Haiku and a wrong cost estimate. → D9 replaces the cost. The window affects only compaction timing, and `[1m]` covers Opus and Sonnet.
- **[Trade-off] Account balance needs a management key**, which can create and delete keys. → It is optional, read only by the server, never placed in an agent environment, and never logged.
- **[Trade-off] A key with no cap shows no key meter.** → The docs advise setting a cap or budget on the inference key; with a balance key, the credits meter still shows.
- **[Risk] OpenRouter's response shapes are partly undocumented** (the `budgets` scopes, `is_management_key`). → A strict shape check; an unknown scope is labelled by its raw value, and anything malformed records no data rather than guessing.
- **[Risk] Ordering with `providers-and-workers` and `process-observability`.** → Implementation starts once `providers-and-workers` section 5 (per-provider usage) is on master; section 4 (provider cooldown, `limit_window`, `cooldownFor`) landed in #219. Adding requirements alone does not avoid overlap: an ADDED rule cannot override an unconditional SHALL elsewhere in the same capability. So the two `chat-usage-limits` requirements this change contradicts are MODIFIED (D6).
  - Both `providers-and-workers` and `process-observability` also MODIFY those requirements. `process-observability`'s text is written on top of `providers-and-workers`', which archives first.
  - Each MODIFIED block here therefore restates `process-observability`'s text for the requirement, with the carve-out added. That is the composition of both changes' edits against master, and the two do not contradict each other.
  - **Archive order:** `providers-and-workers`, then `process-observability`, then `openrouter-provider`. Archiving this change earlier would drop the per-provider and background-observation wording when its block replaces the requirement.
  - The prose was condensed to stay within the 500-character requirement limit. `process-observability`'s texts for the two requirements are 545 and 501 characters, and the main spec would refuse that length after archive. Every normative clause is kept; only connective wording ("instead of waiting for one", "not the session's provider routing") is dropped, and its scenarios still carry those cases.
  - If either change rewrites these requirements again before this change archives, re-derive the blocks from the new text.

## Migration Plan

- No database migration. The `credit` value uses the `limit_window` column from `providers-and-workers`.
- Deploy: put the inference key in `OPENROUTER_API_KEY`, and optionally a management key in `OPENROUTER_MANAGEMENT_KEY`, in the kawai server's environment, then restart the server. Nothing changes for existing profiles. Today's `.env` holds a management key under `OPENROUTER_API_KEY`, so the owner renames it to `OPENROUTER_MANAGEMENT_KEY` and adds an inference key.
- A user-level `profiles.json` or `providers.json` replaces both shipped files, so on such a server, this workspace included, the shipped `openrouter` entry is not offered. The owner copies D5's entry into the user-level `providers.json`; the docs carry it verbatim, and a test resolves it.
- Rollback: older servers reject a user-level `providers.json` that uses the new fields. The shipped entry goes away with the build. Stop OpenRouter sessions before rolling back, because an older server would resume them without their key.

## Open Questions

- Does MiMo pay-as-you-go also answer 402 when its balance is negative, and through which error class? D7 catches it either way. The answer only adds a scenario to the docs.
- Should the transcript also show a session's running total of provider-reported cost? This is deferred, and is display only.
