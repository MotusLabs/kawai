# Proposal

## Why

On 2026-10-18 the dev chat-e94dc0fc (glm-flash, middle-devs) had run for about 27 hours of PR A review rounds without compacting once. At 08:28Z the lead's "go" mail started a turn that ended 111 ms later with `Prompt is too long`.

The CLI did report the failure, in three ways:
- the result frame had `is_error: true` and `terminal_reason: "blocking_limit"`;
- the assistant message came from `model: "<synthetic>"` with zero usage;
- the mail's command was `cancelled`.

Kawai reads only `subtype`, which was `"success"`, so it recorded the outcome as follows:
- the mail as delivered;
- the turn as finished, `ok=1` in `chat_turn_ends` and the morning summary;
- no limit outcome;
- the session as idle and `waiting`.

Group routing prefers the longest-idle member, so the dead session would have taken, and dropped, every later message to its group. The failure was found only because an expected `task_acknowledge` never arrived. Recovery was manual: journal, `release_member`, then a new task mail that spawned a fresh dev.

## What Changes

- **Failed results are failures.** A result with `is_error: true` or a non-success `subtype` completes the turn as failed. `turn_completed` carries the CLI's `terminal_reason`, and the transcript shows an error. Every reader of turn success follows: mail turn outcomes, `chat_turn_ends` and the morning summary, turn usage, and process metrics.
- **Context exhaustion is a session state.** A turn ending in `prompt_too_long` or `blocking_limit` flags its session as context-exhausted:
  - the flag is persisted, and survives restart, archive and restore;
  - group routing and spawn accounting exclude the session;
  - the navigator and chat header show the flag;
  - the flag clears on a `compact_boundary` or a later successful turn (for example after the human runs `/compact`; the CLI's compaction drops the oldest history and retries when its own request is too long).
- **It is not a provider limit.** No `profile_limit_events` row is written, so no profile or provider cools, and no forward excludes the profile.
- **The work goes to a decision, not to routing.**
  - A flagged spawned member is released through member-release readiness, which frees its worktree writer slot.
  - The message its turn dropped is settled as not processed.
  - Kawai sends a decision request to the dispatcher of the task's outstanding assignment. The request names the holder, its worker, the progress digest, claim commit and HEAD, and whether the current revision was acknowledged. It also carries the group's provider usage, reset times and cooldowns from `dispatch-worker-choice`.
  - The dispatcher, typically the lead, decides: re-dispatch (possibly on another provider), park until a reset, reassign, or ask the human.
- **Fallbacks go to the human.** A human-dispatched task, no outstanding assignment, a dispatcher that is itself exhausted or cooling, or a human-created exhausted session, becomes a **Needs you** item in the attention queue.
- **Kawai never sends `/compact` on its own.** A compaction request can fail on a proxied provider, and every attempt costs a request the size of the full context.

## Decisions taken while specifying

- **Dropped message (the human's call):** it is dead-lettered `context-exhausted`, visible in the Mailbox. Retrying a group-addressed one requeues it to the group, where the flagged member is no candidate; retrying a session-addressed one is refused while the session is flagged.
- **Decision request (the human's call):** it is a normal-priority direct note. Every episode also produces an attention item, so the human sees the stall while the lead is busy.
- **Release timing (the human's call):** a flagged spawned member is released at once, through member-release readiness.
- **Direct mail to a flagged session:** it is refused at send, from agents and the human. Queued direct mail is dead-lettered `context-exhausted`, and mail never restores a flagged archived session. A human restore keeps the flag until `/compact` or a successful turn.
- **Terminal reasons:** `prompt_too_long`, `blocking_limit`, and `rapid_refill_breaker` flag the session. The last is the CLI's "autocompact thrashing" stop, which the CLI classifies with context limits.

## Dependencies

- `dispatch-worker-choice` supplies the usage facts in the decision request and the dispatcher's lever to start the work on another provider. It in turn builds on `providers-and-workers`.
- The result classification depends on neither, and may land first as its own step.

## Capabilities

### New Capabilities
- `context-exhaustion-recovery`: detecting an exhausted session, flagging it, settling its dropped work, and asking the dispatcher, or the human, to decide.

### Modified Capabilities
- `chat-sessions`: turn completion honors `is_error` and records `terminal_reason`; the context-exhausted flag and its display.
- `agent-mailbox`: settlement of a message dropped by an exhausted turn, and mail to a flagged session.
- `team-routing-rules`: flagged sessions are not candidates.
- `team-member-release`: a flagged spawned member is released.
- `team-workspace`: failed turns no longer count as finished in the morning summary; exhaustion items in the attention queue.

## Impact

- `src/server/chat/ChatSessionDriver.ts` (`handleResult`), `src/shared/chat.ts` (`turn_completed`), and `ChatSessionManager.ts` (the turn-end fan-out).
- `chat_sessions` gains a flag column through a new numbered migration.
- The mailbox, dispatcher and `limitOutcomes.ts` (or a sibling module for this outcome), member release, staffing and the router.
- `workspaceRead.ts` (the attention queue and summary), `chatTurnUsageStore.ts`, and process metrics.
- The navigator and the chat header.
