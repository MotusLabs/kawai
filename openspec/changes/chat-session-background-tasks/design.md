# Design

## Context

See proposal.md (Why) for motivation. These are the facts that shape the approach, all confirmed against SDK 0.3.289 / CLI 2.1.296 and the wire captures in `~/.agentboard/chat-wire/`:

- **Every `Bash` call is a task.** The CLI emits `task_started` with `task_type: "local_bash"` for foreground calls too, with `is_backgrounded: false`. The captures hold 269 `local_bash` starts, and only a handful were backgrounded. "Is a task" is therefore not the visibility test. "Is in the background" is.
- **A Monitor is a `local_bash` task too.** In the CLI it is a shell task with an internal `kind: "monitor"` that never reaches the wire. The only reliable way to tell a Monitor from a backgrounded Bash call is the `tool_use_id` → `tool_call.tool` join (`Monitor` vs `Bash`). MCP-backed monitors (`monitor_mcp`, `monitor_ws`) carry their own `task_type`.
- **The settle sequence is `task_updated` (`patch.status`, `end_time`) → `task_notification` → `background_tasks_changed`.** `task_notification` carries the outcome (`completed` / `failed` / `stopped`), the `summary` the model read (`Background command "…" completed (exit code 0)`) and the `output_file` path, which is only known once the task settles.
- **The agent wakes itself.** After a background `task_notification` on an idle session, the CLI emits `session_state_changed: running` → `init` → `status: requesting`, then streams a full turn and ends it with `result`. No `user` frame is echoed on the wire. The SDK transcript records the trigger as a `type: "user"` record whose content is `<task-notification>…</task-notification>` with `origin.kind: "task-notification"`. Today `ChatSessionDriver` drops every assistant/user frame while `activeTurnId` is null, so the woken turn is lost live. On replay `transcriptReplay.ts` would show the raw markup as a user message.
- **`query.getTaskOutput(taskId)` exists at runtime but is not declared in `sdk.d.ts`.** It sends the `get_task_output` control request and returns `{ output, total_bytes, truncated }`, at most 8 KiB, for shell and Monitor tasks, running or ended. `query.stopTask(taskId)` is declared.
- **The worker change (PR #72) already provides most of the plumbing.** It has a pure frame reducer (`chatWorkers.ts`), a full-set roster channel (`chat-workers` + `chat-snapshot.workers`), a sidecar store (`chatWorkerStore.ts`, `chat-workers/`) and the live strip (`ChatWorkersStrip.tsx`). It explicitly rejects `local_bash` starts. The compact tool rows from `compact-chat-tool-rows` (on master) render one entry per tool use.

## Goals / Non-Goals

**Goals:**
- Reuse #72's patterns (pure reducer, full-set channel, sidecar) instead of inventing new ones. The background-task roster is a sibling of the worker roster, not a variant of it.
- Fix agent-started turns at the driver level, so they work for every wake source: background shells, Monitors, workers from #72, and scheduled wakeups.

**Non-Goals:**
- Merging workers and background tasks into one roster type. They join to different rows, have different bodies (JSONL transcript vs output tail) and different status semantics (workers hold `working`; tasks don't).
- Persisting output contents. Only the path is kept, and the file belongs to the CLI.

## Decisions

### D1. Visibility is "backgrounded", decided by the edge stream

A pure reducer, `src/server/chat/chatBackgroundTasks.ts`, keeps a per-session roster of entries `{ taskId, toolCallId?, kind, description, status, live, startedAt, endedAt?, summary?, outputFile? }`.

- `task_started` with a `task_type` other than `local_agent`, not `ambient` and not `skip_transcript`, is recorded as a *candidate*. It becomes a visible entry only when `is_backgrounded` is true. A candidate is promoted later by `task_updated.patch.is_backgrounded: true`, or by appearing in a `background_tasks_changed` set. A candidate that settles while still foreground is discarded.
- `kind` is `monitor` when the joined tool call is `Monitor` or `task_type` is `monitor_mcp` / `monitor_ws`, and `shell` when the joined call is `Bash`. Other task types (`mcp_task`, `local_workflow`, `in_process_teammate`, `dream`, …) are ignored, per the proposal's non-goals. The tool-call join uses the driver's existing `tool_call` events. The tool name is known before `task_started`, because the `tool_use` block streams first.
- As in #72, `live` (in the level set right now) and `status` (outcome) are separate fields. `task_notification` is the only source of an outcome. `task_updated.patch.status` is provisional, and `killed` maps to `stopped`. `background_tasks_changed` only toggles `live`. Process end (driver death, interrupt-kill, archive, kill) settles every unresolved entry as `stopped`.

*Alternative considered:* extending `chatWorkers.ts` with a `kind` field. Rejected. The worker reducer's anchor is the `Agent` tool call and its spawn/nesting rules, and folding shells in would add a `kind !== 'agent'` branch to most of its cases. Two small reducers that share a test-fixture style are simpler.

### D2. Delivery: a full-set channel beside `chat-workers`

There is an additive `chat-background-tasks { sessionId, tasks: ChatBackgroundTask[] }` push and a `chat-snapshot.backgroundTasks` field. Like the worker roster, it is a level signal: the full set on every change, and never sequenced `ChatEvent`s. Elapsed time is client-ticked from `startedAt` / `endedAt`, as in `chatElapsed.ts`.

The client keeps the roster per session in `chatStore`, indexed by `toolCallId` for the tool-row lookup.

### D3. Output tail: request/reply, live via the SDK, ended via the recorded file

Request: `chat-task-output { sessionId, taskId }`. Reply: `chat-task-output { sessionId, taskId, state: 'ok' | 'unavailable', output?, totalBytes?, truncated? }`.

- While the driver's query is alive, the manager calls `getTaskOutput(taskId)` behind a `typeof` guard, the same way `getContextUsage` is used. This covers running tasks and ended tasks of the current process.
- With no live query, or when `getTaskOutput` throws or is missing, the manager reads the tail of the task's recorded `outputFile`: at most the last 8 KiB, decoded as UTF-8 (a split leading code point is replaced). This covers restarts, archived chats, and CLIs below the version that supports the request. The path comes only from that task's own `task_notification`. It must be absolute, be named `<taskId>.output`, and sit in a `tasks/` directory under the OS temp dir. Anything else answers `unavailable`. A client can never supply a path.
- The client polls every 2 s only while the entry is expanded *and* the task is `live`, with at most one request in flight per entry. It fetches once on expand when the task has ended. The server coalesces concurrent requests for the same task.
- The output is rendered in a `<pre>` as text. ANSI escape sequences are stripped for display (the CLI says "render as plain text") and never interpreted.

*Alternative considered:* reading the output file for running tasks as well. Rejected. The path is unknown until the task settles, and reconstructing `/tmp/claude-<uid>/<project-slug>/<sessionId>/tasks/<id>.output` would depend on undocumented CLI layout.

### D4. Stop: `chat-task-stop` → `query.stopTask`

`chat-task-stop { sessionId, taskId }` is accepted only for a live, non-archived session and a task the roster knows as `live`. The manager calls `stopTask(taskId)`. The resulting `task_notification` (status `stopped`) settles the entry through the normal path, so there is no optimistic client state beyond disabling the button while the request is pending. A rejection from `stopTask` for a task that has just ended is logged and dropped, never surfaced as a transcript error.

We do not declare `perTaskStopAffordance`. That flag changes interrupt semantics for agents and workflows, which PR #72 deliberately left alone. The header Stop keeps its current behavior.

### D5. Agent-started turns open on `session_state_changed: running`

In `handleSystem`, `session_state_changed` with `state: "running"` while `activeTurnId === null` opens a turn. It increments `turnCounter`, sets `activeTurnId`, and emits `turn_started` with a new optional field, `trigger`. Every existing path then applies unchanged: streaming, tool rows, approvals, the activity reducer, `result` → `turn_completed`, interrupt, and status (`working` follows `activeTurnId`, as it does today).

- `trigger` is `{ kind: 'task', tasks: { taskId, toolCallId?, status, summary }[] }` when one or more background `task_notification`s (shell, Monitor or worker) arrived since the last turn ended, with one entry per notification. Otherwise it is `{ kind: 'resumed' }`. The driver keeps a small "notifications since last turn end" buffer and clears it on `turn_started`.
- The client renders the trigger in place of the user bubble as a muted line, for example `⟲ Background command "Wait for CI" completed (exit code 0)`.
- **Replay:** `transcriptReplay.ts` treats a `type: "user"` record whose `origin.kind === "task-notification"`, or whose string content is wholly `<task-notification>` markup, as a turn trigger. It parses `<task-id>`, `<tool-use-id>`, `<status>` and `<summary>` into the same `trigger` shape, and never emits it as `user_message`.
- **Guard against double turns:** if `send()` races a self-start, the existing "turn already active" branch absorbs the user message into the open turn, which is today's behavior for queued sends.

*Alternative considered:* opening the turn lazily on the first assistant frame. Rejected. Approvals (`canUseTool`) can arrive before any assistant frame is processed, and the activity row should show "Waiting for model…" from the moment the CLI reports `running`.

### D6. Persistence: `chat-tasks/` sidecar mirroring `chat-workers/`

Each session gets one JSON file holding `{ taskId, toolCallId?, kind, description, status, summary?, outputFile?, startedAt, endedAt? }`. It is written at promotion and at settle, keyed on the persisted shape so `live` toggles don't touch the disk. On recovery, a `running` entry becomes `stopped`. Kill deletes the file. Archive keeps it. The store copies `ChatWorkerStore`'s safe-id check and per-session operation chain. If the two classes end up identical apart from the row type, implementation may extract a generic `SidecarRosterStore<T>`, but that is not required.

### D7. Status is untouched

`refreshStatus` does not consult the background-task roster. A session whose turn ended reports `waiting` even with live shells or Monitors. When a task finishes and the agent wakes, D5 makes the session `working` for that turn, so the user is notified of the result through the normal idle transition afterwards.

## Risks / Trade-offs

- **[`getTaskOutput` is undeclared in the SDK types]** → It is called through a structural guard and falls back to the recorded file or `unavailable`. A unit test pins the guard. If a future SDK declares it, the guard becomes a normal call.
- **[The baseline CLI (2.1.289) may predate `get_task_output`]** → A refusal or error degrades to the file fallback, then to `unavailable`. Nothing else depends on it.
- **[`session_state_changed` is marked `sdk_host_only` and could change shape]** → The driver matches only `subtype` + `state === 'running'`. Missing frames leave today's behavior (the turn is dropped) rather than breaking anything. A fixture test pins the captured sequence.
- **[Monitors that fire often wake the agent many times]** → Each wake is a real turn and is shown as one. Collapsing them is out of scope.
- **[Polling cost]** → It runs only while expanded and live, every 2 s, coalesced server-side. The 8 KiB cap bounds the payload.
- **[Output files in `/tmp` can be cleaned by the OS]** → The panel shows `unavailable`. The outcome and summary still persist in the sidecar.
- **[Merge conflicts with #72]** → This change is sequenced strictly after #72 merges, and its driver, manager and strip edits are written against #72's versions.

## Migration Plan

All additive. Older clients ignore `chat-background-tasks`, `chat-snapshot.backgroundTasks` and `turn_started.trigger`. No DB migration. Sessions created before this change have no sidecar and recover with an empty task roster. Their replayed history still gets trigger lines (D5 replay). Rollback is reverting the change. Stray `chat-tasks/` files are inert.

## Open Questions

- Does CLI 2.1.289, the pinned baseline, answer `get_task_output`? This decides only whether the fallback path is hit in practice, not the design. Check during implementation with a fixture or a live probe.
- The exact `task_started` shape for a `Monitor` call has not been captured (no Monitor in the existing wire logs). The design relies only on `tool_use_id` + `task_type`. The first implementation task captures one to confirm.
