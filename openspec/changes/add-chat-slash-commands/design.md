# Design

## Context

See proposal.md for motivation; requirements are in `specs/chat-sessions`.

- `ChatSessionManager.send` holds the start guards: archived (`ARCHIVED_SESSION_ERROR`), missing transcript for a stored conversation ID, and missing project directory. `ensureDriver` refuses archived sessions and de-duplicates concurrent creation through `driverPromises`. `ChatSessionDriver.send` calls `spawnQuery` lazily; the SDK input queue only yields when a turn is pushed, so a query can run with no prompt.
- `chat-attach` (`ChatConnections`) sends `manager.getSnapshot` and subscribes the connection; it never touches the driver.
- `handleSystem` handles only `init` and `compact_boundary`. `local_command_output`, `commands_changed`, and the `init` terminal list are dropped.
- A recorded wire log (`~/.agentboard/chat-wire/`, Claude Code bundled with SDK 0.3.289) shows: the initialize `control_response` carries 60 `commands` about 180 ms after spawn, each with `name`, `description`, `argumentHint`, and optional `aliases` and `builtin`; project commands end their description with ` (project)`; `system/init` carried `terminal_slash_commands: [doctor, color, focus, reload-plugins]`; entries such as `__remote-workflow` are internal; `clear` has aliases `reset` and `new` and hint `[name]`. In that log a user message was sent before `init`, so whether `init` arrives without a prompt is unverified.
- `ChatSessionManager.ts` (584 lines) and `ChatSessionDriver.ts` (620 lines) already exceed the project's 500-line guideline.
- `session-created` selects the new session on the client that created it.

## Goals / Non-Goals

**Goals:** a command list that matches what the running agent will execute; one place that decides whether a chat may start; no extra processes beyond one per opened, startable chat.

**Non-Goals:** executing commands in Kawai (other than `/clear`); interactive pickers for commands that open a picker in the terminal; changing the debug view; stopping idle processes (a later change may add an idle timeout).

## Decisions

### 1. One start guard, used by send and attach

Extract the three send-time guards into `startBlocker(record): string | null` in the manager and call it from both `send` (unchanged errors) and a new `manager.start(sessionId)`. `ChatConnections` calls `start` after sending the snapshot on `chat-attach`, fire-and-forget. `start` goes through `ensureDriver`, so concurrent attaches and sends share one driver, then calls `driver.start()`, which spawns the query only if none is running. A blocked or failed start sets the command state to `unavailable`; a failed spawn emits the existing session `error` event. A dead driver is restarted on attach the same way `send` restarts it today.

Alternative: start inside `getSnapshot` — rejected because snapshots are also built for reconnects and debug flows that must stay side-effect free.

### 2. Command state lives in a new module

Add `src/server/chat/chatCommands.ts` owning the per-session command state `{ status: 'loading' | 'ready' | 'unavailable', commands: ChatCommand[] }` and pure normalization:

- source: `builtin` → `builtin`; description ending ` (project)` → `project` (suffix stripped); otherwise `user`.
- hidden: names starting with `__`, and terminal-bound names. Until `init` reports `terminal_slash_commands`, use the fallback set observed in the spike; replace it when `init` arrives and re-publish.
- de-duplication follows the SDK rule: when names collide, keep the `builtin` row.

The driver feeds it from three sources: the initialize response (via the query's initialization result), `system/commands_changed` (replace), and `system/init`. The driver only forwards raw inputs; the module holds the logic, keeping the driver from growing. `ChatCommand` is `{ name, description, argumentHint, aliases, source }` in `src/shared/chat.ts`.

### 3. Delivery: snapshot field plus `chat-commands` push

`chat-snapshot` gains `commands: ChatCommandState`. A new server message `{ type: 'chat-commands', sessionId, state }` is sent to subscribed connections whenever the state changes. The client stores it per session in `chatStore`. Archived chats and sessions never started report `unavailable`, so the client needs no special case.

Alternative: send commands as a `ChatEvent` — rejected because events are transcript history with sequence numbers, and the list is replaceable state.

### 4. Local command output is a transcript event

Add `ChatEvent` `{ type: 'command_output', turnId, text }`. The driver maps `system/local_command_output` to it within the active turn. Transcript replay maps Claude Code's recorded `<local-command-stdout>` content to the same event and maps `<command-name>`/`<command-args>` user records to a `user_message` with the typed `/name args`; records holding only the expanded command prompt (marked `isMeta`) are already skipped. The client renders `command_output` as a muted monospace block with markdown rendering.

### 5. Composer menu as its own component

Add `src/client/components/chat/SlashCommandMenu.tsx` and a small pure filter function. `ChatView` passes text, commands, and callbacks; the menu is shown while the text matches `^/\S*$`. Ranking: name prefix, alias prefix, name substring, description substring. Keys: Up/Down move, Enter/Tab choose, Escape closes. Enter is captured only while the menu shows at least one match, so unknown commands still send. Choosing sets text to `/<name> ` and shows the hint as a placeholder-style suffix until the user types arguments.

### 6. `/clear` is client-side composition of existing messages

`ChatView`'s submit handler recognizes `^/(clear|reset|new)(\s+(.*))?$`. It sends `session-create` with `kind: 'chat'`, the session's project path and profile, and the optional name, and records the pending clear. When the matching `session-created` arrives (the client already selects it), it sends `chat-archive` for the previous session. An `error` reply leaves the old chat untouched and shows the error. The command is never sent to the agent, so Claude Code's own `/clear` (which would change the conversation ID under one Kawai session) cannot run.

Alternative: a server-side `chat-clear` message — atomic, but adds protocol for something two existing messages already express, and selection would still be a client concern.

### 7. Reconcile the transport change

`replace-claude-sdk-with-cli` Decisions 2 and 4 are updated in this change's branch: the handshake runs on attach, and the transport keeps the initialize `commands` and surfaces `commands_changed`, `init`, and `local_command_output`.

## Risks / Trade-offs

- [Idle processes] Every opened chat now keeps an agent process until kill, archive, or server restart. → Accepted by the user; archive stops it; a later change can add an idle timeout.
- [`init` before first prompt unverified] Terminal-only commands might be listed from the fallback set only. → The fallback covers the observed set; task 1.5 checks it against a real process, and the behavior is correct either way.
- [Description suffix as source] ` (project)` is a display convention, not a contract. → Isolated in one normalization function with tests; worst case the tag is wrong, not the command.
- [Replay markup format] Claude Code's recorded command markup may vary by version. → Unknown shapes fall back to current rendering; fixtures from real transcripts in tests.
- [Commands that need a terminal UI] Some commands may print an error in non-interactive mode. → Their output now appears in the transcript, so the user sees the reason.

## Migration Plan

No data migration. Old clients ignore the new snapshot field and message. Rollback restores lazy start; nothing persisted changes.
