# Tasks

## 1. Worker model and roster reducer

- [ ] 1.1 Add `ChatWorker`, `ChatWorkerStatus`, the `chat-workers` server message, and `workers` on `chat-snapshot` to `src/shared/chat.ts` and `src/shared/types.ts`, and verify `bun run typecheck` passes with the new shapes unused
- [ ] 1.2 Create `src/server/chat/chatWorkers.ts` with `reduceWorkers` and the D3 input table, and verify unit tests pin `task_started` / `task_progress` / `task_updated` / `task_notification` / `background_tasks_changed` / `process_end` transitions plus the dropping of `ambient` and `skip_transcript` tasks
- [ ] 1.3 Reuse `chatActivity.ts`'s structural-frame convention in `chatWorkers.ts`, and verify tests match frame shapes copied from `sdk.d.ts` without importing the SDK

## 2. Driver consumes task frames and excludes worker inner traffic

- [ ] 2.1 Narrow `isSubagentFrame` in `ChatSessionDriver.ts` to subagent content frames in `handleAssistant` / `handleUser`, and verify worker `tool_call` / `tool_result` events are no longer emitted while parent tool calls still are
- [ ] 2.2 Feed `task_*` and `background_tasks_changed` frames into `reduceWorkers` and a new `onWorkers` option where `handleSdkMessage` currently drops them, and verify driver tests cover a spawn, a last-tool update, and a settle
- [ ] 2.3 Settle still-running workers as `stopped` on driver death, interrupt, archive, and kill, and verify tests cover each of those four exits

## 3. Outcomes, status, and delivery

- [ ] 3.1 Persist settled workers to `resolveDataDir()/chat-workers/<sessionId>.json` on every settle and read them back at snapshot time, and verify a unit test round-trips a completed and a failed worker and settles an orphan whose file lists it as running
- [ ] 3.2 Extend `refreshStatus` so `working` covers a running worker as well as an in-flight turn, and verify status tests cover workers-only, turn-plus-workers, and the return to `waiting` when the last worker settles
- [ ] 3.3 Include `workers` in `chat-snapshot` and fan out `chat-workers` from `ChatConnections` beside `chat-activity`, and verify a reconnect mid-run receives the running roster and a reconnect after settle receives the persisted outcomes with nothing marked running

## 4. Client: worker row, live strip, and expand

- [ ] 4.1 Render `tool_call` events for `Agent` / `Task` as a worker summary row in `ChatMessages.tsx`, joining live state by `workerId` and falling back to the collapsed tool card when no roster entry exists, and verify the row shows agent type, description, status, elapsed, and last tool
- [ ] 4.2 Add the depth badge for `depth > 1` and omit it when depth is unknown, and verify a nested spawn renders marked and a top-level spawn does not
- [ ] 4.3 Add `ChatWorkersStrip.tsx` above the transcript listing running workers, hiding itself when none run or the chat is archived, and verify two running workers each show their own last tool and elapsed time and the strip disappears when the last one settles
- [ ] 4.4 Fetch a worker's body over `chat-worker-transcript` on first expand and cache it in `chatStore`, and verify expanding a running worker and a finished worker both show that worker's transcript and a missing file reports the body unavailable
- [ ] 4.5 Render the persisted outcome and summary on the row in archived chats, with expand still available and no strip or running state, and verify an archived chat with workers shows exactly that

## 5. Fixture and integration verification

- [ ] 5.1 Add the D9 keyword turn to `developmentFixture.ts` (Agent call, `task_started`, `task_progress`, `task_notification`, and one subagent `tool_use`), and verify the fixture's unit tests assert the subagent tool call is absent from the transcript
- [ ] 5.2 Walk the fixture in the browser via the `dev-browser` skill and verify the row, the live strip, the expanded body, and the settled outcome render and that the strip leaves when the worker settles
- [ ] 5.3 Run `bun run lint && bun run typecheck && bun run test` and verify the full suite is green

## Workflow follow-up

- Archive the change after the project's review requirements are satisfied.
- Sync `chat-sessions` and add the new `chat-session-workers` capability into `openspec/specs/` and verify the archived result.
