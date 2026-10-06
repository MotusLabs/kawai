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
