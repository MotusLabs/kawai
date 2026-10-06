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
the SDK's platform CLIs` (dependency-trimming commit).

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

## 3.2 — Compiled release-style binary runs chat

Verified 2026-10-06 on linux-x64, Bun 1.4.2, `claude` 2.1.291.

Built `bun build src/server/index.ts src/server/sessionRefreshWorker.ts
src/server/logMatchWorker.ts --define 'process.env.KAWAI_BUILD_VERSION="…"'
--compile --target bun-linux-x64` (84 MB) with the stubbed install, then ran
the binary from an empty directory with `claude` on `PATH` (no
`KAWAI_CLAUDE_PATH`, so PATH resolution was exercised), a scratch
`LOG_FILE`/`AGENTBOARD_DB_PATH`/`CLAUDE_CONFIG_DIR`, and
`AGENTBOARD_CHAT_ENV` pointing at a loopback mock Anthropic endpoint with a
synthetic API key (no real credentials or provider):

- Chat creation passed the executable check and SDK handshake probe — the
  wire log shows the spawn used `/home/coder/.local/bin/claude` from PATH.
- The first turn streamed, the CLI sent a `can_use_tool` control request,
  and the client received the `approval_request` card.
- Answering `allow` over the WebSocket ran the real Bash tool
  (`node -e "console.log('profile-smoke-approved")"`); the tool_result
  carried the command's output.
- The turn completed with subtype `success` and final text.

This is the release configuration that previously failed its availability
probe with "Native CLI binary for linux-x64 not found"; the result is
recorded next to that failure in
`openspec/changes/replace-claude-sdk-with-cli/decision.md`.

Verification quirks hit along the way (expected, not defects): the mock must
answer auxiliary CLI calls (title generation) without consuming the scripted
tool_use, and the first attempt's `node` command was absent from the
stripped server `PATH` until `/usr/local/bin` was included.

## 5.1 — Browser regression against the installed CLI

Verified 2026-10-06, Playwright (Chromium headless shell build 1200).

The `dev-browser` skill was searched for (user and project `.claude/skills`,
filesystem) and is not installed here, so the planned Playwright fallback was
used. The spec is `tests/e2e/chat-external-cli.spec.ts`; it is opt-in because
CI has no `claude` on PATH:

```
KAWAI_EXTERNAL_CLI_TEST=1 \
KAWAI_PRECHANGE_CLAUDE_PATH=<pre-change checkout>/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude \
bunx playwright test tests/e2e/chat-external-cli.spec.ts --workers=1
```

Result: 1 passed (15.5 s). All model traffic went to a loopback mock
Anthropic endpoint with a synthetic key; tools (Bash, AskUserQuestion) ran
for real in the Claude Code CLI.

- Conversation created on the pre-change runtime: the SDK's formerly bundled
  CLI 2.1.289 via `KAWAI_CLAUDE_PATH` (`created.png`).
- Streaming: delayed text deltas rendered progressively (`streaming.png`).
- Approval allow: card shown (`approval.png`); Allow ran the Bash tool, whose
  marker file appeared; `Tool: Bash` and `Request allowed` in the transcript.
- Approval deny: Deny left the marker absent; `Request denied`
  (`denied.png`).
- AskUserQuestion: the question card rendered; the answer resolved it
  (`Request answered`; `question.png`).
- Debug: the protocol panel showed live frames including
  `control_request · can_use_tool` and `result · success`
  (`debug-frames.png`).
- Interrupt: Stop mid-stream produced `Turn stopped` (`interrupted.png`).
- Server restart and resume: after a restart, the server ran the PATH
  `claude` 2.1.291. The transcript replayed, a new turn completed, the stored
  conversation ID was unchanged, and the wire log's spawns show the first on
  2.1.289 and the resume on the PATH executable with `--resume=<id>`
  (`resumed.png`).
- Kill removed the session (`killed.png`).
- Missing executable: with `KAWAI_CLAUDE_PATH=/nonexistent` and a PATH without
  `claude`, submitting the new-session form created no session row. The
  actionable error ("Claude Code executable not found at /nonexistent …
  KAWAI_CLAUDE_PATH …") appeared in the app's error banner
  (`missing-executable.png`).

Observed pre-existing behavior (not changed here):

- A message sent after a turn's final text has streamed, but before its
  `result` arrives, folds into that turn. The finished turn's result then
  clears the active turn, and the following turn's tool and result events
  are dropped. This happens with any CLI build. The spec waits for each
  `Turn complete` before sending again.
- Transcript replay shows the CLI's `[Request interrupted by user]` marker as
  a user message.

## 5.2 — Required checks

Run 2026-10-06 on the final implementation:

- `bun run lint`: 0 warnings, 0 errors (one unused import in the new e2e spec
  fixed first).
- `bun run typecheck`: passed.
- `bun run test`: 1733 passed, 0 failed (including isolated and real-tmux
  suites). The pre-commit run of the real-tmux integration suite failed once
  while a Playwright run had just loaded the host, then passed on retry.
- `openspec validate use-external-claude-cli-with-sdk --strict`: valid.
