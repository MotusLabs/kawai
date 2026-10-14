# Proposal

## Why

`App.tsx`'s WebSocket-subscribe effect (src/client/App.tsx:220–640, ~420 lines) routes every
`ServerMessage` type inline — session lifecycle with pendingKills/wake matching and sound
transitions, workspace operations, chat and team store dispatches, server/error handling —
through a closure over dozens of hooks state/refs, and it re-subscribes whenever
`selectedSessionId` changes. This is P1/S3 of the refactor analysis
(docs/refactor-analysis/phase2/client-architecture.md, P1-1): the last god-unit logic in the
client's root component, and the natural place to consolidate shared session-op handling.

## What Changes

- New `src/client/protocol/` package:
  - `messageRouter.ts` — `createMessageRouter(deps)` returning `(message: ServerMessage) => void`;
    deps = `{ sendMessage, getConnectionEpoch, ui }` plus the pending-ops refs.
  - `sessionMessages.ts` — sessions/session-update/created/removed/orphaned/activated/
    agent-sessions(-active)/wake-result/hibernate-result/kill-failed/move-to-history-result,
    with pendingKills epoch handling and pending selection/wake matching owned in a small
    `pendingSessionOps` object.
  - `workspaceMessages.ts` — workspace-snapshot/operation-result (+ launch refs).
  - `chatMessages.ts` — the one-line store dispatches for chat-* (+ chat-debug-frames).
  - `teamMessages.ts` — team-mailbox-*/team-task-* dispatches and the dead-letter toast.
  - `serverMessages.ts` — host-status/server-config/update-state/error/terminal-error/
    terminal-ready.
- Handlers read stores via `getState()` exclusively; the effect no longer depends on
  `selectedSessionId`, so the router subscribes once for the app's lifetime.
- F7 dedupes fold in: one `notifyStatusTransitions(prev, next)`, one
  `handleWorktreeResult`, one transient-error helper with timer cleanup.
- `App.tsx` keeps layout, keyboard shortcuts, and mounting; the WS effect becomes
  construction + subscribe (~30 lines).

No behavior changes — message handling order and store dispatch sequences are preserved
verbatim. Marked `skip_specs: true`.

## Capabilities

### New Capabilities

None — pure refactor (`skip_specs: true`).

### Modified Capabilities

None.

## Impact

- Code: `src/client/App.tsx` (~1,372 → ~700 LOC), six new protocol modules each well under
  the 500-LOC norm; no server or shared-type changes.
- Tests: `app.test.tsx` already exercises the router end-to-end and must pass unchanged;
  add `protocol/messageRouter.test.ts` dispatching every message type against store spies.
- Risk: medium — ordering-sensitive handlers (pendingKills epoch discard, pending-wake
  matching) move verbatim; mitigated by identical store-method call order and the app test
  suite.
