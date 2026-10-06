# Tasks

## 1. Start the agent on attach

- [x] 1.1 Extract the archived, missing-transcript, and missing-directory checks from `ChatSessionManager.send` into one start guard used by `send` with unchanged errors; verify existing manager send tests pass unchanged
- [x] 1.2 Add `ChatSessionDriver.start()` that spawns the query without pushing a turn, and is a no-op while a query runs; verify with driver tests that no user message reaches the fake query and a later send reuses the same query
- [x] 1.3 Add `ChatSessionManager.start` through the guard and `ensureDriver`, restarting a dead driver; verify with manager tests for normal, archived, missing directory, missing transcript, concurrent start plus send (one driver), and spawn failure reported as a session error
- [x] 1.4 Call `manager.start` after the snapshot on `chat-attach` in `ChatConnections`; verify with a connections test that attach sends the snapshot first and starts once for two attaching clients
- [x] 1.5 Check with a real Claude Code process whether `system/init` arrives before any prompt, and record the result in design.md Context; verify the note is present

## 2. Command list

- [x] 2.1 Add `ChatCommand` and `ChatCommandState` to `src/shared/chat.ts`, and `commands` on `chat-snapshot` and the `chat-commands` server message to `src/shared/types.ts`; verify with `bun run typecheck`
- [x] 2.2 Implement `src/server/chat/chatCommands.ts` normalization (source from `builtin` and the ` (project)` suffix, `__` and terminal-bound hiding with the fallback set, builtin-wins de-duplication) and state transitions; verify with unit tests using the recorded command list as a fixture
- [x] 2.3 Feed the state from the initialize response, `system/commands_changed`, and `system/init` in the driver, and mark it unavailable when the session is not started, blocked, dead, or archived; verify with driver tests for each source and transition
- [x] 2.4 Include the state in `getSnapshot` and push `chat-commands` to subscribed connections on change; verify with manager and connections tests for snapshot contents and push fan-out
- [ ] 2.5 Store the state per session in `chatStore` from snapshots and `chat-commands`; verify with store tests for replace semantics and reconnect

## 3. Local command output and replay

- [ ] 3.1 Add the `command_output` `ChatEvent`, map `system/local_command_output` to it in the active turn, and render it in `ChatMessages` as a muted markdown block; verify with driver and component tests
- [ ] 3.2 Map recorded `<command-name>`/`<command-args>` user records to `user_message` with the typed `/name args`, and `<local-command-stdout>` to `command_output`, in `transcriptReplay.ts`; verify with replay tests using fixtures from real transcripts, including an unknown markup shape falling back to current rendering

## 4. Composer menu

- [ ] 4.1 Implement the pure filter and ranking (name prefix, alias prefix, name substring, description substring); verify with unit tests
- [ ] 4.2 Implement `SlashCommandMenu.tsx` and wire it into `ChatView`: open on `^/\S*$`, loading and empty states, Up/Down/Enter/Tab/Escape and pointer selection, insert `/<name> ` with the argument hint, Enter not captured without matches, source tag for project and user commands; verify with component tests for each behavior
- [ ] 4.3 Keep the menu absent for archived chats (no composer); verify with a ChatView test

## 5. `/clear`, `/reset`, `/new`

- [ ] 5.1 Intercept `/clear`, `/reset`, and `/new [name]` in `ChatView` submit: send `session-create` with the session's project and profile and the name, then `chat-archive` for the previous session on the matching `session-created`; on `error` leave it untouched; never send the command to the agent; verify with ChatView tests for each alias, a name, and a creation error

## 6. Planning and docs

- [ ] 6.1 Confirm `replace-claude-sdk-with-cli` design Decisions 2 and 4 match the implemented behavior; verify with `openspec validate replace-claude-sdk-with-cli`
- [ ] 6.2 Update `CLAUDE.md` "How It Works" for start on attach, the command list, and `/clear`; verify the text matches the implemented behavior

## 7. Integration

- [ ] 7.1 Run `bun run lint && bun run typecheck && bun run test` and verify all pass
- [ ] 7.2 With the `dev-browser` skill against `bun run dev`: open a chat and see the menu populate without sending, filter and insert a project command, run `/context` and see its output, reload and see the command and output replayed, run `/new demo` and see a new chat selected with the old one in Archive; capture screenshots
