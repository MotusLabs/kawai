# External Claude Code executable verification

## 2.3 — Backend startup and terminal sessions without Claude Code

Verified 2026-10-06 on linux-x64, Bun 1.4.2, commit after `feat: gate chat
creation and spawns on the external executable check`.

Server run from the worktree as `bun src/server/index.ts` with a scratch
`LOG_FILE`/`AGENTBOARD_DB_PATH`, `KAWAI_CLAUDE_PATH=/nonexistent`, a `PATH`
containing bun (via symlink), `/usr/bin`, and `/bin` but no `claude`, and an
isolated `TMUX_SESSION=agentboard-verify`:

- The server started and logged `startup_state` normally.
- A terminal session created over the WebSocket (`session-create` with
  command `bash`) opened a tmux window (`session-created` with
  `tmuxWindow agentboard-verify:@17`). Note: the default window command is
  `claude`, which exits instantly when the binary is absent — expected on a
  host without Claude Code and unrelated to chat gating.
- Chat creation (`session-create` `kind: "chat"`) was refused with the exact
  executable error naming the checked path and the fix:
  `Claude Code executable not found at /nonexistent. Install Claude Code
  (https://claude.com/claude-code) so `claude` is on the server PATH, or set
  KAWAI_CLAUDE_PATH to the executable.`
- The host's real `agentboard` tmux session and other servers were untouched;
  the verify session was removed afterwards.

Conclusion: backend startup, terminal sessions, and chat-history serving do
not depend on the Claude Code executable; only chat creation refuses.

## 3.1 — Platform CLI packages excluded

Verified 2026-10-06 on linux-x64, Bun 1.4.2, commit `feat: stop installing
the SDK's bundled platform CLIs`.

- `packages/claude-agent-sdk-no-cli` stub added; all eight
  `@anthropic-ai/claude-agent-sdk-<platform>` names map to it under
  `overrides`; `bun.lock` regenerated.
- Clean-checkout `git clone` + `bun install --frozen-lockfile`: 711 packages
  installed, `node_modules` 596 MB (was 1008 MB with both linux variants).
- `node_modules/@anthropic-ai/` holds only `claude-agent-sdk` and `sdk`; no
  platform directory and no `claude` binary anywhere under it.
- lightningcss (gnu + musl), oxlint, and rolldown native packages remain.
- `bun run lint` and `bun run build` pass; full `bun run test` suite passes
  (1733 tests, 0 fail) on the trimmed install.
- `claudeSdkPlatformOverrides.test.ts` asserts every SDK
  `optionalDependencies` name is overridden, so an SDK upgrade that adds a
  platform package fails tests until the override list is updated.
