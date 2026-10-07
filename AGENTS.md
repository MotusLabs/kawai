# AGENTS.md

- Bun 1.x, TypeScript 5.x, React 18, Hono, xterm.js, Zustand, Tailwind.

## Commands

```
bun run dev        # frontend + backend
bun run build      # production build
bun run lint       # oxlint
bun run typecheck  # tsc --noEmit
bun run test       # unit tests
```

Run `bun run lint && bun run typecheck && bun run test` after changes.

## How It Works

- Single tmux session (default: `agentboard`) with one window per project
- Backend discovers windows, streams terminal output via WebSocket
- Parses Claude/Codex JSONL logs from `~/.claude/projects/` and `~/.codex/sessions/` for status
- Status: unknown -> working -> waiting (derived from log events)
- Chat sessions use the Claude Agent SDK without tmux, driving a separately installed Claude Code executable (`KAWAI_CLAUDE_PATH` or `claude` on the server PATH; version-checked against the SDK-pinned baseline 2.1.289 before creation — the SDK's platform CLI packages are stubbed out of the install, so Claude Code must be installed on the host). Turns and pending approvals/questions determine status directly. WebSocket snapshots restore history and pending requests on reconnect; SQLite rows and SDK transcripts allow restart/resume.
- Each chat session has a per-session approval policy (`approval_policy` in `chat_sessions`: `manual` by default, or `auto`): auto grants tool approvals without cards — AskUserQuestion still asks, and Claude Code settings deny rules still apply. Toggled live from the chat header (`chat-set-approval-policy`); persisted across restart, resume, archive, and restore.
- During an in-flight chat turn, a live activity row ends the transcript (`Waiting for model…` / `Thinking…` / `Writing <tool> input…` / `Running <tool>…` / `Retrying (a/m, status)…` plus a client-ticked elapsed timer). Derived server-side from protocol frames by the pure reducer in `src/server/chat/chatActivity.ts`, delivered on phase changes via the additive `chat-activity` message and `chat-snapshot.activity`; ephemeral (never a sequenced, persisted ChatEvent nor part of the session-list status) and hidden client-side while text streams, a request awaits the user, or the chat is archived.
- Chat sessions can be archived (`archived_at` in `chat_sessions`): archiving stops the agent but keeps the record, conversation, and protocol log; archived chats open read-only (no agent starts; Restore resumes the same conversation) and are exempt from the history lookback. Kill is still the only permanent removal.
- Navigator: live sessions sit in OpenSpec change/worktree sections; hibernating, history, and archived sessions collect in the docked `Archive` pane (newest first, collapsed until first expanded). `Remote` holds only live sessions on other hosts.

## Structure

- src/server/     Hono backend, WebSocket, tmux/pty management, log parsing
  - `src/server/SessionManager.ts` - tmux window discovery, log parsing, status detection
  - `src/server/index.ts` - Hono routes, WebSocket handling
  - `src/server/chat/` - SDK driver, session lifecycle, transcript replay, subscriptions, and development fixture
  - `src/server/chat/wireTap.ts`, `ChatWireLog.ts`, `ChatWireLogs.ts` - always-on raw protocol capture for the chat debug view
- src/client/     React frontend, xterm.js terminal, Zustand stores
  - `src/client/App.tsx` - main UI, keyboard shortcuts
  - `src/client/components/Terminal.tsx` - xterm.js wrapper
  - `src/client/components/chat/` - transcript, approvals, questions, and composer
  - `src/client/stores/chatStore.ts` - ordered transcript and pending requests
  - `src/client/components/chat/ChatDebugPanel.tsx`, `src/client/stores/chatDebugStore.ts` - Debug toggle's protocol-frame panel
- src/shared/     Shared types
  - `src/shared/chat.ts` - SDK-independent chat events and request contracts

- Data directory: `~/.agentboard/` contains `agentboard.db` (session data), `agentboard.log`, and `chat-wire/` (per-chat-session raw protocol logs, beside the DB)

## Git

- Check `git status`/`git diff` before commits
- Atomic commits; push only when asked
- Never destructive ops (`reset --hard`, `force push`) without explicit consent
- Conventional Commits: `feat:`, `fix:`, `docs:`, `refactor:`
- Commit early and often — make small, incremental commits as you work rather than one large commit at the end.

## Critical Thinking

- Read more code when stuck
- Document unexpected behavior
- Call out conflicts between instructions

## Engineering

- Small files (<500 LOC), descriptive paths, current header comments
- Fix root causes, not symptoms
- Simplicity > cleverness (even if it means bigger refactors)
- Aim for 100% test coverage

## UI Testing

- Use the `dev-browser` skill for testing web UI changes. Headless browser
automation with Playwright. Start server, take screenshots, verify DOM state.
