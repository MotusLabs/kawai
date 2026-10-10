# Design

## Context

Builds on `agent-teams` (dispatcher, atomic claims, scheduled messages) and `team-tasks` (worktree staffing, spawn with group settings). Profiles come from layered `.kawai/profiles.json` catalogs; `executable` is already restricted to user-level files because project `.kawai/` is agent-writable. Usage data (`usageLimits.ts`) is per profile, in memory only, and misattributed for gateway profiles (the pull follows the host claude.ai login). Claude Code classifies API errors as `SDKAssistantMessageError` (`rate_limit`, `billing_error`, `overloaded`, …) on both `system/api_retry` frames and failed assistant messages; gateways sometimes report quota exhaustion as 400/403 with a provider-specific message, which may classify as `invalid_request` or `unknown`.

## Goals / Non-Goals

**Goals:** user-owned routing policy with a typed contract; a limit signal that works for every provider; no stuck work when a provider runs out.

**Non-Goals:** a sandbox against filesystem access by rules (rules are trusted user code; isolation targets credentials and accidental activation); per-message token accounting.

## Decisions

### D1. Rules run in a Bun Worker with an explicit env
One Worker per loaded rule file, created with `env: {}` plus the rule's declared `env` keys. The host posts a structured-clone `RouteContext` and awaits the reply with a timeout. Module-level state in the Worker persists between calls (rules may cache quota lookups). *Alternative:* in-process `import()` — exposes `process.env` and every provider credential. *Alternative:* subprocess per call — too slow for a per-message path.

### D2. Declared env is read before the Worker starts
`env` must be known before execution, so the loader reads it by importing the module once in a bootstrap Worker with an empty env, collects `default.env`, then starts the serving Worker with those variables. A rule cannot obtain more variables than it declares.

### D3. Manual reload only
Load at server start; reload via an authenticated UI action that rebuilds all Workers and reports per-rule results. No file watching: a rule planted by an agent in `~/.kawai/routing/` needs a human action to run.

### D4. Candidates are pre-filtered by kawai
The context contains only candidates that delivery, staffing, caps, and parking already allow, as `{ id, kind: 'member' | 'spawn', profileId, sessionId?, cwd, idleForMs? }`. Rules cannot violate safety rules by construction; picks outside the list fall back.

### D5. Per-group decision serialization and claim re-validation
The dispatcher keeps one in-flight decision per group; others wait. After the rule returns, the claim transaction re-checks eligibility (see `agent-teams` D5). On failure: re-run once, then built-in strategy.

### D6. Limit events from classified errors, with raw details
Capture `api_retry` frames (`final: false`) and failed assistant messages / error results (`final: true`) whose error class is `rate_limit`, `billing_error`, or `overloaded`, and also any final error whose status is 429. Store status and message so rules can recognize provider-specific quota errors classified otherwise. Table `profile_limit_events(id, profile_id, session_id, group_id, at, kind, final, status, message, resets_at)`, pruned after 24h.

### D7. Cooldown is computed, not stored
Built-in cooldown = latest final event's `resets_at`, else `at + 1h`. Rules compute their own from `ctx.profiles[id].limitEvents`. Nothing is written when a cooldown "ends", so changing the policy needs no migration.

### D8. Progress = tool calls since claim
The driver counts completed tool calls in turns handling a claimed message. `onLimit` receives `{ profileId, sessionId, message, kind, status, resetsAt, progress: { toolCalls, filesTouched }, parkCount }`.

### D9. Park via scheduled self-message
Park sets `team_messages.state = 'parked'`, `parked_until`, increments `park_count`, and inserts a scheduled resume message (`agent-teams` scheduling) linked to it. The member is excluded from pickup while it holds a parked message. A successful human-driven turn cancels the resume.

### D10. Handoff package built from kawai's own records
Digest = tool-call names and file paths from the chat event log since `claimed_at`; claim commit = `git rev-parse HEAD` in the member's cwd recorded at claim time. The package is a fixed-format section of the delivered envelope plus the instruction to run `git status`, `git diff <claim-commit>`, and `git log <claim-commit>..` before acting.

## Risks / Trade-offs

- [Gateway quota errors misclassified] → raw status/message exposed to rules; 429 always counts.
- [A rule hangs or loops] → timeout; Worker terminated and restarted after repeated timeouts.
- [Agent edits `~/.kawai/routing/` (same OS user)] → no effect until a human reloads; reload shows which files changed since the last load.
- [Parked work blocks a member for hours] → park only within `parkIfResetWithin`; manual Hand off; 3-park cap.
- [Handoff loses reasoning not written down] → the task journal and the instruction to inspect the working tree; agents are prompted to journal decisions.

## Migration Plan

Additive table and columns. Groups without `profiles` or rules behave as in `team-tasks`.
