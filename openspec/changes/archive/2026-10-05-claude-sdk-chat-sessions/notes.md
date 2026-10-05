# Implementation validation — 2026-10-05

The user's `CLAUDE_CODE_OAUTH_TOKEN` from `.env` supplied authentication for
real-SDK verification instead of `ANTHROPIC_API_KEY`. Bun loaded it automatically.
The token was never printed. The server auth gate now recognizes OAuth tokens
alongside API keys and CLI credentials.

## Automated checks

- `bun run lint && bun run typecheck && bun run test`: passed.
- `bun run build`: passed.
- The repository's Playwright setup replaced the unavailable dev-browser
  skill, as explicitly authorized by the user.
- The development fixture Playwright suite passed both tests: session-kind
  toggling, hidden chat command/host fields, creation and kill, markdown/tool
  transcript, Allow/Deny, structured questions, reconnect during streaming
  and a pending approval, resolution synchronized across two clients, and Stop.
- Screenshots of the modal, pending approval, and completed/stopped transcript
  were captured under `test-results/` and visually inspected.
- The SDK control-handshake probe passed under Bun, without a model turn.
- A minimal real SDK turn returned the requested authentication smoke reply.

## Real SDK browser walkthrough

The opt-in `chat-real.spec.ts` passed against a separately managed development
server, with a private tmux socket, temporary project, SQLite database, and
Claude transcript directory. It verified actual assistant responses rather
than matching text in the submitted user prompts.

1. Created an OAuth-authenticated chat session through the modal.
2. Requested a real Write tool call, reloaded while approval was pending,
   allowed it, and observed the assistant's completion.
3. Answered a real AskUserQuestion request through the question form.
4. Interrupted a real turn while Write approval was pending and observed
   request cancellation and waiting status.
5. Reloaded while a real assistant response streamed and retained the output.
6. Restarted the server, replayed prior conversation, and resumed with an
   answer recalling the earlier file content.
7. Temporarily removed the SDK transcript, restarted, observed the history
   fallback and actionable send error, and restored the original transcript.
8. Killed the session, restarted again, and confirmed it stayed removed.

Run the real walkthrough with configured server auth and a built frontend:

```bash
bun run build
KAWAI_REAL_CHAT_TEST=1 bunx playwright test --config playwright.chat-real.config.ts
```

This command makes real model requests. Playwright's browser binaries were
installed in `/tmp/kawai-playwright` in this workspace; its runs used
`PLAYWRIGHT_BROWSERS_PATH=/tmp/kawai-playwright`.

`CLAUDE.md` is a symlink to `AGENTS.md`; its How It Works and Structure sections
were updated through that target, preserving the symlink.
