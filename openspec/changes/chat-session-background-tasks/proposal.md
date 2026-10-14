# Proposal

## Why

Claude Code often leaves work running after a turn ends. `Bash` with `run_in_background` covers CI waits, dev servers and long test runs, and `Monitor` streams events from a watched command. In a kawai chat this work can't be seen. The tool row shows only the launch receipt ("Command running in background with ID: …"). The user can't tell whether the task is still running, see its output, or stop it. When the task finishes, the CLI wakes the agent and starts a new turn on its own. Kawai drops every frame of that turn because no user-started turn is active. Wire captures in `~/.agentboard/chat-wire/` show the sequence `task_notification` → `session_state_changed: running` → a full assistant turn, and none of it reaches the transcript. The wire already carries everything needed: `task_started` / `task_updated` / `task_notification`, the `background_tasks_changed` level set, a `get_task_output` control request that returns the last 8 KiB, and `stopTask`. The driver ignores all of it.

The spawned-workers change (`chat-session-spawned-subagents`, PR #72) does the same job for `Agent` workers, and it excludes shell tasks on purpose. This change covers the rest: background shells and Monitors.

## What Changes

- Track every background shell and Monitor task of a chat session, keyed by its SDK task id and joined to the `Bash`/`Monitor` tool call that started it. Foreground `Bash` calls also emit `task_started` (`is_backgrounded: false`). They stay invisible unless they are later moved to the background.
- Show the task on its tool row: a status mark (running / completed / failed / stopped), elapsed time, and the one-line outcome the CLI reports, such as `… completed (exit code 0)`. Expanding the row adds the task's **output tail** below the receipt: the last 8 KiB, refreshed while the task runs and the row is open.
- Add a **Stop** control, on the row and in the live strip, that stops that one task. The rest of the session is unaffected.
- List running background tasks in the live strip above the transcript, next to the running workers from PR #72, labelled `Shell` or `Monitor`, so long-lived processes stay visible.
- Background tasks do **not** change session status. Once its turn ends, a session with only background shells or Monitors running reports `waiting`. Idle sounds and notifications still fire, and a dev server never pins a session to `working`.
- Render **agent-started turns**. When the CLI starts a turn on its own, for example because a background task finished or a Monitor produced an event, the transcript opens a new turn that names its trigger, streams the assistant output, and reports `working` until the turn completes.
- Keep task outcomes across server restart, resume, archive and restore. An ended task's output tail can still be read from its recorded output file while that file exists.

Non-goals:
- Background task types other than shells and Monitors, such as MCP tasks, workflows and teammates.
- Declaring `perTaskStopAffordance`, so interrupt semantics stay unchanged.
- Moving a running foreground command to the background from the UI (`backgroundTasks()` / Ctrl+B).
- Streaming the full output beyond the 8 KiB tail.
- Any change to `Agent` worker rows.

## Capabilities

### New Capabilities

- `chat-session-background-tasks`: how a chat session surfaces its background shell and Monitor tasks. This covers task identity and lifecycle, the tool-row status and output tail, the live-strip entry, per-task stop, persistence of outcomes, and the rule that background tasks don't affect session status.

### Modified Capabilities

- `chat-sessions`: adds a requirement that turns the agent starts on its own are streamed to the chat view, with their trigger, rather than dropped.

## Impact

- Server: `src/server/chat/ChatSessionDriver.ts` consumes `task_*` and `background_tasks_changed` frames for non-agent tasks, opens a turn on a `system/init` frame when none is active (`session_state_changed` never reaches SDK consumers), and calls `getTaskOutput` / `stopTask`. A new pure reducer, `src/server/chat/chatBackgroundTasks.ts`, holds the task roster. `ChatSessionManager.ts` adds the roster to snapshots and persists outcomes in a sidecar. `ChatConnections.ts` fans updates out. `developmentFixture.ts` gets a background-shell scenario.
- Shared: `src/shared/chat.ts` gets the `ChatBackgroundTask` type and an optional trigger on `turn_started`. `src/shared/types.ts` gets the `chat-background-tasks` push, `chat-snapshot.backgroundTasks`, `chat-task-output` request/reply and `chat-task-stop`. All additive.
- Client: the tool row in `src/client/components/chat/ChatMessages.tsx` gains a task status mark, output tail and Stop control. The live strip from PR #72 lists tasks. `src/client/stores/chatStore.ts` stores the task roster.
- Storage: no DB schema change. Outcomes and output-file paths go in a `chat-tasks/` sidecar beside `chat-wire/` and `chat-workers/`.
- Dependency: lands after `chat-session-spawned-subagents` (#72). It reuses that change's live strip and roster-channel pattern, and edits the same driver code.
