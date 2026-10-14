# Tasks

Prerequisite: `chat-session-spawned-subagents` (PR #72) is merged. Branch from the resulting master, because every server and strip edit below builds on #72's versions of `ChatSessionDriver.ts`, `ChatSessionManager.ts`, `ChatConnections.ts` and `ChatWorkersStrip.tsx`.

## 1. Wire fixtures

- [x] 1.1 In a scratch chat session, capture the wire frames for a backgrounded `Bash` call, a `Monitor` call that emits at least one event, a foreground `Bash` call, a `stopTask` of a running shell, a `getTaskOutput` reply, and the self-started turn that follows a background completion. Save trimmed copies as fixtures under `src/server/__tests__/fixtures/`. Verify that the Monitor's `task_started` `task_type` and `is_backgrounded` values are recorded in the fixture and noted in design.md's Open Questions, and whether the baseline CLI (2.1.289) answers `get_task_output`

## 2. Agent-started turns (driver + replay)

- [x] 2.1 Add the optional `trigger` field (`{ kind: 'task', tasks: [...] } | { kind: 'resumed' }`) to `turn_started` in `src/shared/chat.ts`. Verify `bun run typecheck` passes
- [x] 2.2 In `ChatSessionDriver.ts`, buffer `task_notification`s that arrive while no turn is active, and open a turn on a `system/init` frame when `activeTurnId` is null (`session_state_changed` is `sdk_host_only` and never reaches consumers — design D5), emitting `turn_started` with the trigger and clearing the buffer. Verify with driver tests replaying the captured self-start sequence: assistant text and tool rows are emitted, status goes `working` → `waiting`, interrupt ends the turn, a `send()` racing the self-start joins the open turn, and a self-start with no preceding notification carries `{ kind: 'resumed' }`
- [x] 2.3 In `transcriptReplay.ts`, turn `user` records with `origin.kind === 'task-notification'` (or wholly `<task-notification>` content) into a turn trigger parsed from `<task-id>`, `<tool-use-id>`, `<status>` and `<summary>`, never a `user_message`. Verify with replay tests built from the SDK transcript record shape in design.md Context
- [x] 2.4 Render the trigger line in place of the user bubble in `ChatMessages.tsx`, showing the summary per task or a generic "Continued on its own" line. Verify with a client test for both trigger kinds and a check that no raw `<task-notification>` text renders

## 3. Background-task roster (server)

- [x] 3.1 Add `ChatBackgroundTask` and `ChatBackgroundTaskKind` to `src/shared/chat.ts`, plus the `chat-background-tasks` push, `chat-snapshot.backgroundTasks`, the `chat-task-output` request/reply and `chat-task-stop` to `src/shared/types.ts`. Verify `bun run typecheck` passes
- [x] 3.2 Create the pure reducer `src/server/chat/chatBackgroundTasks.ts` (header comment) implementing design D1: candidates, promotion by `is_backgrounded` / patch / level set, kind from the tool-call join or `monitor_mcp` / `monitor_ws`, `live` separate from `status`, `killed` → `stopped`, and process end settling as stopped. Verify with `src/server/__tests__/chatBackgroundTasks.test.ts` covering every scenario in "Background shell and Monitor tasks are tracked per chat session", frame-order permutations (level set before or after notification), and that `local_agent` and ambient tasks never appear
- [x] 3.3 Feed `task_*` and `background_tasks_changed` frames and `Bash` / `Monitor` `tool_call`s into the reducer from `ChatSessionDriver.ts` alongside #72's worker reducer, publishing the projection on change. Verify with driver tests using the 1.1 fixtures, and that the existing worker tests still pass
- [x] 3.4 Hold the roster per session in `ChatSessionManager.ts`, include it in snapshots, and fan out `chat-background-tasks` through `ChatConnections.ts`. Verify with manager/connections tests that a reconnecting client gets the running task in its snapshot and later changes as pushes
- [x] 3.5 Confirm `refreshStatus` ignores the background-task roster (design D7). Verify with a manager test where a turn ends while a shell is live and the session reports `waiting`

## 4. Persistence

- [x] 4.1 Add a `chat-tasks/` sidecar store (design D6), reusing or generalizing `ChatWorkerStore`'s safe-id check and per-session operation chain. Write on promotion and settle, recover running entries as stopped, delete on kill, keep on archive. Verify with store tests for each, plus a manager test showing restart → replay keeps a completed task's summary on its tool row
- [x] 4.2 Document `chat-tasks/` in the data-directory line of `CLAUDE.md`. Verify the line lists `chat-wire/`, `chat-workers/` and `chat-tasks/`

## 5. Output tail and stop (server)

- [x] 5.1 Handle `chat-task-output` in `ChatSessionManager.ts` per design D3: guarded `getTaskOutput` on a live query, falling back to the recorded `outputFile` tail (absolute path, `tasks/<taskId>.output` under the OS temp dir, last 8 KiB, UTF-8-safe), otherwise `unavailable`, with concurrent requests coalesced. Verify with tests for live, fallback, missing file, rejected path (traversal, wrong name, outside temp dir), a throwing or missing `getTaskOutput`, and the truncated flag
- [x] 5.2 Handle `chat-task-stop` per design D4: accept it only for a live non-archived session and a `live` task, call `stopTask`, and log and drop rejections. Verify with tests that stop settles via the notification, that archived or unknown or ended tasks are refused without a transcript error, and that the in-flight turn is untouched
- [x] 5.3 Add a background-shell scenario to `developmentFixture.ts` that starts, prints output, and completes and wakes the agent, plus a long-running one that can be stopped. Verify the fixture test exercises both

## 6. Client UI

- [x] 6.1 Store the roster per session in `chatStore.ts`, indexed by `toolCallId`, from snapshot and push. Verify with store tests for replacement semantics and session switching
- [x] 6.2 Extend the tool row in `ChatMessages.tsx`: running mark plus ticking elapsed, or the outcome mark and summary (`✗` on failed). On expand, show the output panel below the result (plain `<pre>`, ANSI stripped, truncation note, `unavailable` message), polling every 2 s only while expanded and live and fetching once when ended. Add a Stop button while live and not archived. Verify with component tests for each scenario in "A background task's tool entry shows its state", "Users can read a background task's recent output" and "Users can stop a single background task", including that polling stops on collapse and on settle
- [ ] 6.3 Add background-task rows (`Shell` / `Monitor` label, description, elapsed, Stop) to the live strip from #72, showing the strip when any worker or task is live and hiding it when archived. Verify with strip tests for mixed worker/task membership and a task leaving the strip when it settles

## 7. Integration checks

- [ ] 7.1 Run `bun run lint && bun run typecheck && bun run test` and confirm all pass
- [ ] 7.2 Headlessly over WebSocket against a dev server (not `test:e2e` while the user's kawai is live), run a chat turn that starts `sleep 20; echo done` in the background. Confirm the task appears in the snapshot and push, the output tail returns `done` after completion, the self-started turn streams with a trigger, and the session is `waiting` while the task runs. Repeat with a Stop mid-run
- [ ] 7.3 Use the `dev-browser` skill to screenshot the tool row (running, expanded with output, completed), the live strip with a shell row, and the trigger line. Check them against the spec scenarios
- [ ] 7.4 Update the `CLAUDE.md` "How It Works" list with a background-tasks bullet and an agent-started-turns note. Verify both read correctly against the shipped behavior

## Workflow follow-up

- Archive the change after review, syncing `chat-session-background-tasks` and the `chat-sessions` delta into the main specs.
