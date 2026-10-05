# Proposal

## Why

A chat session can be created for a project directory that does not exist,
and the first message then fails with the Claude Agent SDK's misleading
"native binary … failed to launch … does not match this system's libc"
error. The real cause is the spawn's `cwd`: Node/Bun report a missing working
directory as `ENOENT`, and the SDK attributes any `ENOENT` on an existing
binary to a libc mismatch. It happened in practice because the new-session
form prefills the selected session's path, and tmux reports a pane whose
directory was removed (here, a deleted git worktree) as
`/path/to/worktree (deleted)`. Terminal creation already refuses such paths;
chat creation only refuses an empty string.

## What Changes

- Chat session creation resolves the project path the same way terminal
  creation does (trim, `~` expansion, absolute) and refuses a path that is
  not an existing directory, with an error naming the path. No session is
  stored on refusal.
- Sending a message to an existing chat session whose project directory no
  longer exists (removed after creation, or a session persisted before this
  fix) is refused before any agent process is spawned, with an error that
  says the directory is missing and suggests creating a new session there.
  The session and its history are kept.
- Non-goals: making the SDK use a system-installed `claude` binary
  (`pathToClaudeCodeExecutable`), and changing how tmux discovery displays
  ` (deleted)` paths for terminal sessions. The bundled binary works; it was
  never the problem.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `chat-sessions`: "Users can start a Claude Code chat session" gains
  refusal of a missing project directory at creation, and refusal of turns
  when the session's directory has since disappeared.

## Impact

- `src/server/chat/ChatSessionManager.ts`: path resolution and directory
  check in `createSession`; a directory check in `send` before the driver is
  created, next to the existing missing-transcript refusal.
- `src/server/paths.ts`: reused (`resolveProjectPath`); a small directory
  check helper may live beside it.
- `src/server/__tests__/chatSessionManager.test.ts` and other chat tests that
  create sessions for fictitious paths such as `/tmp/proj`: they inject the
  directory check, so tests keep running without real directories.
- No protocol, client, database schema, or dependency changes. Refusals use
  the existing `ChatCreateResult` / `ChatActionResult` errors, which the
  client already shows.
