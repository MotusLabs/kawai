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

Primary areas are `src/server/chat/codex/CodexSessionDriver.ts`, `codexLimits.ts`, Codex activity projection, shared activity types, and `src/client/components/chat/ChatActivityRow.tsx`. Tests must cover the actual driver and manager/mailbox composition, not only a standalone scheduler. Codex rollout replay needs coverage for continuation turns and internal continuation input. No model fallback, dependency, database migration, or user setting is planned; retry state is ephemeral and is not resumed automatically after backend restart. Existing persisted cooldown events are left intact.
