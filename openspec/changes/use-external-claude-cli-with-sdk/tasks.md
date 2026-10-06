# Tasks

## 1. Executable resolution and compatibility

- [x] 1.1 Add `src/server/chat/claudeExecutable.ts` with `KAWAI_CLAUDE_PATH`/`PATH` resolution, file and execute-permission checks, a bounded `--version` probe, the `CLAUDE_CODE_MIN_VERSION` baseline, `ClaudeExecutableError` kinds, and a success-only cache keyed by path, realpath, and mtime; verify unit tests cover the explicit path, PATH lookup, an unset or blank override, a value with spaces or arguments, a missing path, a directory, a non-executable file, an old version, a newer version, unparsable output, a timeout that kills the probe, re-check after a failure, re-check after mtime changes, and a baseline equal to the SDK's `claudeCodeVersion`.

## 2. Chat launch wiring

- [x] 2.1 Pass the resolved path as `pathToClaudeCodeExecutable` in `probeSdkAvailability` and `ChatSessionDriver.spawnQuery`, leaving options unchanged when no path is given; verify driver tests assert the option is present with a path and absent without one, and `chatWireTap` tests still record the spawned command's frames.
- [x] 2.2 Add the injectable `executableCheck` to `ChatSessionManager`, change the check to return `{ path, identity }` (identity = path + realpath + mtime), run it before the handshake probe with the identity included in the handshake cache key and in `ensureDriver` for new and dead drivers, and report `ClaudeExecutableError` messages verbatim; verify manager tests cover refused creation with no persisted record, the error text, recovery after a failure, an upgrade at the same path (new mtime or symlink target) rerunning both the version check and the handshake while an unchanged executable reuses both, a send refused after the executable disappears with the record and `sdkSessionId` intact, and an injected `queryFactory` still skipping the check.
- [x] 2.3 Confirm backend startup and terminal sessions do not depend on the executable; verify by starting the server with `KAWAI_CLAUDE_PATH=/nonexistent` and `PATH` without `claude`, checking the `startup_state` log and that a terminal session opens, and recording the result.

## 3. Dependency trimming

- [x] 3.1 Add `packages/claude-agent-sdk-no-cli/package.json`, add `overrides` for all eight SDK platform packages, and regenerate `bun.lock`; verify `bun install --frozen-lockfile` succeeds in a clean checkout, no `@anthropic-ai/claude-agent-sdk-*` directory holds a binary, lightningcss/oxlint/rolldown bindings remain, `bun run build` and `bun run lint` pass, `node_modules` size is recorded, and a test asserts that every SDK `optionalDependencies` name is overridden.
- [x] 3.2 Verify a compiled release-style binary runs chat: run `bun build --compile` as `release.yml` does, run the binary from an empty directory with `claude` on PATH, create a chat session, and complete an approval round trip through the API or UI; record the result next to the earlier compiled-probe failure in the decision note.

## 4. Documentation

- [ ] 4.1 Update the README chat setup, `docs/claude-session-profiles.md`, and `CLAUDE.md` with the separate Claude Code install, the 2.1.289 baseline, `KAWAI_CLAUDE_PATH`, error meanings, upgrading the SDK and CLI together, and rollback; verify no text implies a bundled CLI (`grep -rn -i "bundled\|claude-agent-sdk-linux" README.md docs CLAUDE.md`) and the documented variable name matches the tests.

## 5. Acceptance

- [ ] 5.1 Use the dev-browser skill to verify chat against the installed CLI (reporting its absence before falling back to Playwright): streaming, approval allow/deny, AskUserQuestion, interrupt, kill, server restart and resume of a pre-change conversation, and debug frames; also verify a missing-executable error on the new-session form. Keep screenshots and DOM assertions.
- [ ] 5.2 Run `bun run lint && bun run typecheck && bun run test` and `openspec validate use-external-claude-cli-with-sdk --strict`; verify all pass or record actionable blockers.

## Workflow follow-up

- Archive this change after acceptance.
- Withdraw `replace-claude-sdk-with-cli`. Its decision note records why it is superseded; do not archive it as implemented.
