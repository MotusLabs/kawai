# Tasks

## 1. Worker model and roster reducer

- [ ] 1.1 Add `ChatWorker`, `ChatWorkerStatus`, the `chat-workers` server message, and `workers` on `chat-snapshot` to `src/shared/chat.ts` and `src/shared/types.ts`, and verify `bun run typecheck` passes with the new shapes unused
- [ ] 1.2 Create `src/server/chat/chatWorkers.ts` with `reduceWorkers` and the D3 input table, and verify unit tests pin `task_started` / `task_progress` / `task_updated` / `task_notification` / `background_tasks_changed` / `process_end` transitions — including that `task_notification` overwrites a provisional outcome and that `background_tasks_changed` writes `live` only — plus the dropping of `ambient` and `skip_transcript` tasks
- [ ] 1.3 Reuse `chatActivity.ts`'s structural-frame convention in `chatWorkers.ts`, and verify tests match frame shapes copied from `sdk.d.ts` without importing the SDK

## 2. Driver consumes task frames and excludes worker inner traffic

- [ ] 2.1 Narrow `isSubagentFrame` in `ChatSessionDriver.ts` to subagent content frames in `handleAssistant` / `handleUser`, keeping a worker's `Agent`/`Task` tool_use and its tool_result so nested spawns have a row anchor, and verify worker Bash/Read calls are no longer emitted while parent tool calls and nested Agent calls still are
- [ ] 2.2 Feed the `task_*` edge frames into `reduceWorkers` and a new `onWorkers` option where `handleSdkMessage` currently drops them, and verify driver tests cover a spawn, a last-tool update, and a settle
- [ ] 2.3 Set `live` from membership in `background_tasks_changed.tasks` by `task_id` — never writing `status`, creating rows, or touching foreground workers — and verify a test leaves a running foreground worker in place when the level set omits it, and that a `task_notification` arriving after the worker left the set still writes its real outcome
- [ ] 2.4 Write `stopped` on driver death, interrupt, archive, and kill for any worker still without an outcome, and verify tests cover each of those four exits

## 3. Outcomes, status, and delivery

- [ ] 3.1 Persist a worker to `resolveDataDir()/chat-workers/<sessionId>.json` when it spawns and rewrite it on every settle, and verify a unit test round-trips a completed and a failed worker, keeps a running worker's row after an abrupt stop, and recovers it as `stopped`
- [ ] 3.2 Extend `refreshStatus` so `working` covers a live worker as well as an in-flight turn, and verify status tests cover workers-only, turn-plus-workers, and the return to `waiting` when no worker is live any more — including a worker that has left the running set before its result
- [ ] 3.3 Include `workers` in `chat-snapshot` and fan out `chat-workers` from `ChatConnections` beside `chat-activity`, and verify a reconnect mid-run receives the running roster and a reconnect after settle receives the persisted outcomes with nothing marked running

## 4. Client: worker row, live strip, and expand

- [ ] 4.1 Render `tool_call` events for `Agent` / `Task` as a worker summary row in `ChatMessages.tsx`, joining live state by `workerId` and falling back to the collapsed tool card when no roster entry exists, and verify the row shows agent type, description, status, elapsed, and last tool
- [ ] 4.2 Add the depth badge for `depth > 1` and omit it when depth is unknown, and verify a nested spawn renders marked and a top-level spawn does not
- [ ] 4.3 Add `ChatWorkersStrip.tsx` above the transcript listing live workers (`workers.filter(w => w.live)`), hiding itself when none are live or the chat is archived, and verify two running workers each show their own last tool and elapsed time and the strip disappears once none are live
- [ ] 4.4 Fetch a worker's body over `chat-worker-transcript` on first expand and cache it in `chatStore`, and verify expanding a running worker and a finished worker both show that worker's transcript and a missing file reports the body unavailable
- [ ] 4.5 Render the persisted outcome and summary on the row in archived chats, with expand still available and no strip or running state, and verify an archived chat with workers shows exactly that

## 5. Fixture and integration verification

- [ ] 5.1 Add the D9 keyword turn to `developmentFixture.ts` (Agent call, `task_started`, `task_progress`, a `background_tasks_changed` that drops the task before its `task_notification`, one nested `Agent` call with its `task_started`, and one subagent `tool_use`), and verify the fixture's unit tests assert the subagent tool call is absent from the transcript while the nested `Agent` call is present and the settled outcome is the notification's, not `stopped`
- [ ] 5.2 Walk the fixture in the browser via the `dev-browser` skill and verify the row, the live strip, the expanded body, and the settled outcome render and that the strip leaves when the worker settles
- [ ] 5.3 Run `bun run lint && bun run typecheck && bun run test` and verify the full suite is green

## Workflow follow-up

- Archive the change after the project's review requirements are satisfied.
- Sync `chat-sessions` and add the new `chat-session-workers` capability into `openspec/specs/` and verify the archived result.
