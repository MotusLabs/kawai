# Proposal

## Why

Chat sessions talk to Claude Code through the Agent SDK, which runs the CLI as
a subprocess and exchanges newline-delimited JSON with it. The chat view
shows only the mapped `ChatEvent`s, so when a turn misbehaves (a dropped tool
result, a stuck approval, an unexpected result subtype, a resume that starts
fresh) there is no way to see what Claude Code actually sent or received.
Debugging now means adding ad-hoc logging and restarting the server. A
built-in view of the raw protocol traffic, available for every session after
the fact, removes that loop.

## What Changes

- Every chat session's Claude Code subprocess is spawned through the SDK's
  `spawnClaudeCodeProcess` hook with a tap that records each stdin line
  (Agentboard → Claude Code), each stdout line (Claude Code → Agentboard),
  stderr output, and process lifecycle (spawn command/args without the
  environment, exit code/signal). This includes the SDK control traffic
  (`initialize`, `can_use_tool`, `interrupt`, and their responses) that the
  SDK otherwise hides.
- Capture is always on. Frames are appended to a per-session JSONL file in
  the Agentboard data directory, so the full wire history of any existing
  session survives browser reloads, driver respawns, and server restarts.
  Each session's log is size-capped with one rotated generation; killing a
  session deletes its log.
- The chat view gets a **Debug** toggle that opens a panel listing the
  session's wire frames in order (direction, timestamp, message type), with
  each frame expandable to pretty-printed JSON and copyable as raw text.
  Older frames load on demand; new frames stream in live while the panel is
  open.
- The development chat fixture records synthetic frames for the messages it
  exchanges, so the panel can be exercised without a real Claude login.
- Sessions created before this change, and sessions that never started a
  turn, show an empty-state message instead of frames.

## Capabilities

### New Capabilities
- `chat-debug`: Always-on capture of the raw JSON protocol exchanged between
  Agentboard and each chat session's Claude Code process, its retention, and
  the per-session debug panel that displays it.

### Modified Capabilities
<!-- None: existing chat-sessions requirements (streaming, approvals, status,
     persistence, kill) keep their behavior; the debug log is additive. -->

## Impact

- **Server**: new wire-tap spawner and per-session frame log under
  `src/server/chat/`; `ChatSessionDriver` passes `spawnClaudeCodeProcess` into
  SDK options; `ChatSessionManager` owns log lifecycle
  (create, read, delete on kill); new WebSocket messages to open/close the
  debug view, page older frames, and receive live frames — the same channel
  that already carries chat transcripts, with no new HTTP route.
- **Shared**: new `ChatWireFrame` type and additive `ServerMessage` /
  `ClientMessage` members in `src/shared/`. Older clients ignore the new
  message types.
- **Client**: Debug toggle and frame panel in `src/client/components/chat/`,
  frame state in a small store.
- **Disk**: new `chat-wire/` directory beside `agentboard.db`; bounded per
  session.
- **Security**: logs contain full prompts, tool inputs, and file contents —
  the same data already present in Claude transcripts under `~/.claude/` and
  already streamed to any chat client — and are served only over the existing
  chat WebSocket, so they reach exactly the clients that can see the chat. The spawn
  environment (which may carry `ANTHROPIC_API_KEY` / OAuth tokens) is never
  recorded.
- **Dependencies**: none new. Relies on the SDK's public
  `spawnClaudeCodeProcess` option (present in the installed 0.3.x).
