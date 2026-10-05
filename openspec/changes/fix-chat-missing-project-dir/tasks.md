# Tasks

## 1. Directory check seam

- [ ] 1.1 Add an `isExistingDirectory(path)` helper beside `resolveProjectPath` in `src/server/paths.ts` (`statSync(...).isDirectory()`, false on any error) and verify unit tests cover an existing directory, a file, a missing path, and a `<dir> (deleted)` path
- [ ] 1.2 Add optional `isDirectory?: (path: string) => boolean` to `ChatSessionManagerOptions`, defaulting to the helper (design D4). Pass `() => true` from the 12 `new ChatSessionManager` sites in `chatSessionManager.test.ts`, then verify `bun run test` still passes unchanged

## 2. Refuse at creation

- [ ] 2.1 In `ChatSessionManager.createSession`, resolve the path with `resolveProjectPath`, refuse with `Project directory does not exist: <resolved>` when `isDirectory` is false, and store the resolved path (design D2, D5). Verify with tests: a missing path is refused, no DB row or registry entry is written, a `~/…` path is stored as an absolute path, and the existing creation tests still pass
- [ ] 2.2 Verify through `createAvailableSession` that a missing directory is refused with the same error (no probe-dependent behavior is lost) and that the `session-create` WebSocket path sends the error back as `{ type: 'error' }`, with a test in the existing manager or connections suite

## 3. Refuse at send

- [ ] 3.1 In `ChatSessionManager.send`, when no live or pending driver exists and `isDirectory(record.projectPath)` is false, return the D5 missing-directory error before `ensureDriver`, next to the missing-transcript check (design D3). Verify with tests: no driver or query factory is invoked, no `turn_started` or `user_message` event is emitted, and the session, its history and its snapshot remain available
- [ ] 3.2 Verify with a test that sending to a session with a live driver is not blocked by the check (the check is skipped while a driver exists), and that a send succeeds again once `isDirectory` returns true

## 4. Integration check

- [ ] 4.1 Run `bun run lint && bun run typecheck && bun run test` and verify all pass
- [ ] 4.2 With `bun run dev`, try to create a chat session for a nonexistent path (e.g. `/tmp/nope (deleted)`) and verify the UI shows the "Project directory does not exist" error and no session appears. Create one in an existing temp directory, remove the directory, send `Hi`, and verify the missing-directory error appears instead of the libc message
