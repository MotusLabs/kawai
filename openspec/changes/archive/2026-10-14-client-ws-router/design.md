# Design

## Context

App.tsx:220–640 is one passive effect subscribing to `lastMessage$` with ~35 `if
(message.type === …)` branches closing over: `selectedSessionId`, `pendingKillsRef`,
selection/wake pending refs, sound-transition state, worktree-modal pending refs, transient
error state, and the `sendMessage` callback. The report (client-architecture.md §4 P1-1)
verified the protocol union is complete and typed (F15) and recommends `chatStore`'s pure
reducer style as the template. `app.test.tsx` (2,395 LOC) covers the router end-to-end.

## Goals / Non-Goals

**Goals:**

- App.tsx stops owning message routing; the router subscribes once for the app lifetime.
- Handlers are plain functions over `{ deps, stores-via-getState }`, unit-testable without
  React rendering.
- Message handling order and store call sequences byte-identical to today.

**Non-Goals:**

- No store redesign, no protocol changes, no new message types.
- Not extracting App.tsx's non-WS concerns (modals, keyboard) — that rides S5/S4.
- Not touching `useWebSocket.ts` (its manager class is S4's neighbor, verified healthy).

## Decisions

### D1: One router function built once per connection epoch

`createMessageRouter(deps)` returns a dispatch function; App's effect constructs it from
refs/stable callbacks and subscribes it to `lastMessage$`. Because handlers read stores via
`getState()` and pending state lives in refs, the effect's dep array drops to
`[lastMessage$]`-equivalent — one subscription for the app's lifetime, killing the
resubscribe-on-selection-change stale-closure window (F1/F16a).

### D2: Deps are refs + stable callbacks only

`deps = { sendMessage, getConnectionEpoch, notifyStatusTransitions, openNewSessionPrefilled,
setTransientError, pendingSessionOps, pendingWorkspaceOps }` — all stable across renders
(refs and useCallback fns). Any handler needing "selected session" reads
`useSessionStore.getState()`, never a prop.

### D3: Verbatim moves, then dedupe as a second commit

Commit 1 moves each branch body into its module unchanged (mechanical, reviewable by diff
shape). Commit 2 applies the F7 dedupes (shared `notifyStatusTransitions`, shared
`handleWorktreeResult`, shared transient-error helper) inside the new modules where the
duplicates now sit next to each other. Behavior parity is checked by `app.test.tsx` between
commits.

### D4: pendingSessionOps is a plain object over refs

`{ pendingKills: Map, pendingSelection: {…} | null, pendingWake: … }` lives in a ref App
creates and passes in — ref ownership stays with the hook lifetime, modules only read/write
through it. Same for `pendingWorkspaceOps` (worktree-create result matching).

## Risks / Trade-offs

- [Ordering regression in epoch-sensitive handlers] → Mitigation: D3 verbatim-first; the
  pendingKills discard-on-snapshot and pending-wake match blocks move as-is with their
  comments; `app.test.tsx` runs per commit.
- [A handler silently keeps reading stale hook state] → Mitigation: D2 bans non-stable deps;
  the new `messageRouter.test.ts` dispatches every type against store spies, catching
  handlers that touch anything but stores+deps.
- [App.tsx still large after S3] → Expected (~700 LOC); S4/S5 own the rest.

## Migration Plan

Branch `client-ws-router`, three commits (router extraction; dedupes; router unit tests +
synthesis note), each suite-green; PR after implementation, next backlog item only after
merge. Rollback is revert; no protocol/config/data changes.

## Open Questions

None blocking.
