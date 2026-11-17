# Proposal

## Why

When Codex ends a turn with `serverOverloaded`, Kawai stops the conversation instead of recovering from temporary model capacity pressure. It also treats capacity as a shared-login quota failure, potentially cooling every profile on the same Codex home for an hour.

## What Changes

- Continue the same Codex thread automatically after a terminal `serverOverloaded`, keeping one logical Kawai turn and preserving completed work.
- Bound recovery to a ten-minute retry window, using exponential backoff with jitter and delays capped at sixty seconds.
- Show retry attempt, next retry time, and the window deadline; allow Stop to cancel recovery immediately.
- Leave Codex's own `willRetry: true` attempts to Codex; never start a competing attempt.
- Exclude Codex capacity errors from quota limit events, shared-home cooldowns, and quota-driven mailbox parking or forwarding, including after retry exhaustion.
- Cancel pending retries on interruption, lifecycle termination, or superseding human input, and reject stale timer and protocol callbacks.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `codex-chat-sessions`: bounded capacity recovery, logical turn continuity, cancellation, and visible retry state.
- `profile-limit-handling`: distinguish Codex model capacity from account/session quota limits while retaining existing handling of actual quotas.

## Impact

Retargeted 2026-11-18 (proposed): the Codex driver moved into the in-tree package `@motuslabs/agent-runtime` (extract-agent-runtime), so the paths of the 2026-10-26 plan are obsolete (`CodexSessionDriver.ts` no longer exists).

- **Package (owner of the logical turn and its attempts).** `packages/agent-runtime/src/usage/limits.ts` (`codexLimitScope` drops `serverOverloaded`), `src/codex/facts.ts` (no limit failure for capacity), a new pure policy `src/codex/capacityRetry.ts`, a new effect owner `src/codex/capacityRecovery.ts` hooked from `src/codex/session.ts` and `src/codex/turns.ts`, `src/codex/activity.ts` and `src/common/activity.ts` (additive retry fields), additive public event and option types, and the continuation wrapper constant.
- **Kawai (projection).** `src/server/chat/provider/codexRuntimeSupport.ts` and `codexRuntime.ts` pass the option and project the additive activity into `ChatActivity` (`src/shared/chat.ts`); `src/client/components/chat/ChatActivityRow.tsx` shows the countdown; `src/server/chat/codex/codexRollout.ts` (the real rollout replay path) renders recovery input as an internal notice; `src/server/chat/codex/codexLimits.ts` keeps attributing real quota kinds.
- **No publication.** Kawai consumes the package in-tree (`package.json`: `"@motuslabs/agent-runtime": "workspace:0.1.1"`), and the root checks run the package's tests. The change keeps the package version at 0.1.1 and publishes nothing; a later release is the owner's separate decision.
- Tests cover the package session with a scripted app-server and the production Kawai manager/mailbox composition, not only a standalone scheduler. No model fallback, dependency, database migration, or user setting; retry state is ephemeral and is not resumed after backend restart. Existing persisted cooldown events are left intact.
