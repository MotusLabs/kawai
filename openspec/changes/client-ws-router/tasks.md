# Tasks

Each task ends with `bun run lint && bun run typecheck && bun run test` green and a commit;
tick the checkbox in the same commit.

## 1. Protocol modules (verbatim moves)

- [x] 1.1 Create `src/client/protocol/` with `serverMessages.ts`, `chatMessages.ts`,
  `teamMessages.ts` (the one-line store dispatches + dead-letter toast + terminal/error/
  host-status/config handling), each a plain `handle(message, deps)` keyed by message type
- [x] 1.2 Create `sessionMessages.ts` moving the session-lifecycle branches verbatim
  (sessions, session-update/created/removed/orphaned/activated, agent-sessions(-active),
  wake/hibernate/move-to-history results, kill-failed) with `pendingSessionOps` over the
  existing refs, and `workspaceMessages.ts` for snapshot/operation-result with
  `pendingWorkspaceOps`
- [x] 1.3 Create `messageRouter.ts` (`createMessageRouter(deps)` dispatching to the
  modules) and rewire App.tsx's WS effect to construct it from stable refs/callbacks and
  subscribe once (drop `selectedSessionId` from deps); App.tsx shrinks to ~700 LOC
- [x] 1.4 Run the full suite (`app.test.tsx` must pass unchanged); commit
  (`refactor: extract WS message router from App into protocol modules`)

## 2. Dedupe shared handlers

- [x] 2.1 Fold the repeated patterns now co-located in the modules: one
  `notifyStatusTransitions(prev, next)` (sound transitions), one `handleWorktreeResult`
  for the create-worktree result paths, one transient-error helper with timer cleanup;
  suite green; commit (`refactor: dedupe status, worktree, and error handling in protocol modules`)

## 3. Router unit tests + close-out

- [x] 3.1 Add `src/client/__tests__/messageRouter.test.ts` dispatching every ServerMessage
  type through the router against store spies (cheap now that handlers are plain
  functions); suite green; commit (`test: dispatch every message type through the protocol router`)
- [x] 3.2 Mark S3 done in `docs/refactor-analysis/synthesis.md` (status note with commit
  hashes, mirroring the P0/S1/S2/S6 notes); commit
  (`docs: mark P1/S3 complete in refactor synthesis`)
- [x] 3.3 Push `client-ws-router` and open the PR; wait for merge before starting S4

## Workflow follow-up

- After merge: sync master, remove the worktree/branch, archive the change; then propose S4
  (useTerminal composables).
