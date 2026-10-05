# Design

## Context

See proposal.md (Why). Relevant current state:

- `SessionManager.createWindow` resolves the path with `resolveProjectPath`
  (`src/server/paths.ts`) and throws `Project path does not exist: <path>`.
  Chat creation (`ChatSessionManager.createSession`) only trims and rejects
  an empty string, then persists the raw value.
- `ChatSessionManager.send` already refuses a turn before creating a driver
  when the stored SDK transcript is missing. The client shows that refusal as
  an error toast through `ChatConnections`.
- The driver spawns lazily on the first send. A spawn failure reaches the user
  only as the SDK's error text, which for a missing `cwd` is the libc message.
- Chat tests create sessions for fictitious paths (`/tmp/proj`, about 38
  call sites).

## Goals / Non-Goals

**Goals:**
- Refuse bad paths where they enter (creation), and catch paths that went
  bad afterwards (send) before anything is spawned.
- Keep chat tests independent of the real filesystem.

**Non-Goals:**
- Rewriting or reinterpreting SDK spawn errors.
- Changing terminal-session path handling or tmux discovery output.

## Decisions

**D1. Check for a directory, not just that the path exists.** Use `stat`
and `isDirectory()`, so a path that names a file is refused too (a file as
`cwd` fails the spawn the same way). The ` (deleted)` suffix needs no special
handling: the suffixed path does not exist, so the same check refuses it.
*Alternative:* strip ` (deleted)` and check the bare path. Rejected: the bare
directory is gone anyway, and stripping would hide where the bad path came
from.

**D2. Store the resolved path.** `createSession` stores
`resolveProjectPath(input)`, matching terminal sessions. That makes `~` paths
work and keeps the stored `cwd` absolute. Existing rows are not rewritten.

**D3. Check again in `send`, before `ensureDriver`.** The check sits next to
the missing-transcript refusal and returns `ChatActionResult { ok: false }`.
It runs whenever no live driver exists. If a driver is already running, its
process already has a `cwd` and keeps working even after the directory is
removed. A crashed driver respawns with the same `cwd`, so the check runs on
every send. It is a single `stat`, cheap next to a message round trip.
*Alternative:* check inside `ChatSessionDriver.spawnQuery`. Rejected: by then
`send` has already emitted `turn_started` and `user_message`, so a refusal
there would leave a turn open with no response.

**D4. Inject the directory check.** `ChatSessionManagerOptions` gains an
optional `isDirectory(path): boolean` that defaults to a real `fs.statSync`
check. Tests pass `() => true` through their shared manager factory, plus
targeted cases with `() => false`. The development fixture uses
`process.cwd()`, which exists, so it needs no change.
*Alternative:* create real temp directories in the tests. Rejected: it would
touch roughly 38 call sites and add filesystem setup to unrelated tests.

**D5. Error text.** Creation: `Project directory does not exist: <resolved
path>`, which mirrors the terminal message and names the path. Send: `Cannot
start the agent: the project directory <path> no longer exists. Create a new
chat session in an existing directory.`

## Risks / Trade-offs

- [The directory is removed between the check and the spawn] → The SDK's
  misleading error can still appear in that narrow window. This is accepted:
  the window is tiny, and the error is no worse than it is today.
- [A path that is temporarily missing, such as an unmounted network drive,
  refuses turns] → This is intended. The session is kept, and sending works
  again once the directory is back.
