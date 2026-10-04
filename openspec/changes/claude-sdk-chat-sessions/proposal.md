# Proposal

## Why

Agentboard sessions today are tmux windows: interaction goes through a terminal
emulator, and status is inferred by re-parsing Claude Code JSONL logs after the
fact. The Claude Agent SDK now offers first-class programmatic control —
structured streaming events, in-process permission handling, interrupts, and
session resume — so a Claude Code session can be driven directly from a web chat
interface with no terminal and no log scraping, giving precise status, approval
prompts surfaced as UI, and full control (send, interrupt, resume) from any
browser.

## What Changes

- Add a second session kind: **chat sessions** backed by the Claude Agent SDK
  (`@anthropic-ai/claude-agent-sdk`) instead of a tmux window. Existing
  terminal (tmux) sessions are unchanged; the new-session form gains a way to
  choose between them.
- Server: a chat-session driver owns one SDK `query()` (streaming-input mode)
  per session — sends user turns, streams structured events over the existing
  WebSocket, handles approvals via `canUseTool`, supports interrupt and resume
  by SDK session id.
- Client: a chat view (message list with markdown, tool-call summaries,
  approval cards with Allow/Deny, composer, stop button) replaces the xterm
  pane for chat sessions.
- Status for chat sessions is derived directly from SDK events
  (working / waiting / permission) instead of log polling; chat sessions
  appear in the existing session list, sorting, and activity cadence.
- Chat sessions persist across server restarts (SDK session transcripts are
  resumable) and are killable like any session.
- New dependency: `@anthropic-ai/claude-agent-sdk`; auth via
  `ANTHROPIC_API_KEY` (or the CLI's existing login under `CLAUDE_CONFIG_DIR`).
- Non-goal (for this change): Codex/other agent drivers. The driver boundary
  is shaped so a Codex driver can be added later, but only the Claude driver
  ships here. Terminal sessions, remote hosts, and hibernate/wake for chat
  sessions are also out of scope.

## Capabilities

### New Capabilities
- `chat-sessions`: Sessions driven by an agent SDK over a chat interface —
  lifecycle (create/kill/resume), event streaming to the client, permission
  approvals, interruption, and event-derived status.

### Modified Capabilities
<!-- None: session-updates and terminal-streaming requirements apply to chat
sessions as-is; the WebSocket additions are additive and do not change
existing requirements. -->

## Impact

- **Dependencies**: add `@anthropic-ai/claude-agent-sdk` (bundled Claude Code
  binary; runtime is Bun — officially documented for Node 18+, so a startup
  smoke test gates the feature).
- **Server**: new `src/server/chat/` module (driver + WS message handling);
  `src/server/index.ts` session-create routing; `SessionRegistry` broadcasts
  chat sessions alongside terminal ones; config additions for API key and
  feature enablement.
- **Shared types**: `Session` gains an optional kind field; `ClientMessage` /
  `ServerMessage` gain additive chat messages (older clients ignore unknown
  message types).
- **Client**: new chat view components and store slice; `NewSessionModal`
  gains the session-kind choice; `App.tsx` renders chat view for chat
  sessions.
- **Data**: SDK transcripts continue to be written under
  `~/.claude/projects/` (existing log discovery may observe them; they must
  not be double-counted as terminal sessions).
