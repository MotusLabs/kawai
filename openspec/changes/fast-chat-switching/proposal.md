# Proposal

## Why

Switching to a chat with a long history is slow every time, not only on first
open, and the owner reaches Kawai over a remote link. Measured on 2026-10-26
against real transcripts: every switch re-sends the whole recent window
uncompressed — up to 2.9 MB and 2,322 events for one dev chat, because one
busy day fills the 24-hour window — and the browser then re-mounts it all
(about 80–110 ms of React work plus 80–100 ms of layout in headless Chromium
on the server host; a laptop is slower). The server side is not the cost on a
warm switch: the history memo answers from memory, and JSON parsing and
folding on the client take under 10 ms. The window must be bounded by size
as well as time, and a switch should send only what the client lacks.

## What Changes

- **Size budget on the history window.** Attach and each load-earlier page
  stop at 500 events or 512 KiB of serialized events, whichever comes first,
  inside the existing 24-hour bound. A turn larger than the budget may be cut
  inside, at a point where no tool call is open and no assistant message
  continues, so a tool entry is never shown without its call or result. This
  amends the archived `chat-history-window` decision (D1) that rejected
  count/byte bounds and the rule that turns are never split.
- **Switching back sends only what changed.** A client that still holds a
  chat's transcript names its newest and oldest held events on attach; the
  server answers with only the newer events plus the window's new start, and
  the client appends them and trims what fell out of the recomputed window.
  The reopen still slides the window as today. Anything the server cannot
  match (restart, kill, released memo) falls back to a full snapshot.
- **Large non-terminal messages are compressed by default.** Per-message
  deflate is negotiated by default, and only messages of at least 16 KiB
  that are not terminal output are compressed (2.9 MB → 0.75 MB measured,
  22 ms). Terminal frames stay uncompressed, so the keystroke-echo reason
  behind today's opt-in is kept. `AGENTBOARD_WS_DEFLATE=true` still
  compresses everything; a new `false` value disables negotiation entirely.
- **Archived chats release their loaded history.** An archived chat that no
  client has subscribed to for 10 minutes drops its history memo; the next
  open replays its transcript again. One archived lead transcript (527 MB)
  held about 1 GB of heap for the rest of the server's run.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `chat-sessions`: the recent window and each page gain the size budget
  and the in-turn cut rule; a new requirement for resuming a held transcript
  on reopen; a new requirement for releasing an archived chat's loaded
  history.
- `terminal-streaming`: "WebSocket compression is opt-in" becomes compression
  of large non-terminal messages by default, with terminal output never
  compressed.

## Impact

- Server: `src/server/chat/historyWindow.ts` (budget, in-turn cut points),
  `ChatSessionManager.ts` (`getSnapshot` resume, memo release),
  `ChatConnections.ts` (`chat-attach` resume fields), `ws/ConnectionHub.ts`
  and `ws/socketHandlers.ts` (per-message compression),
  `TerminalOutputCoalescer` sends, `config.ts` (`AGENTBOARD_WS_DEFLATE`
  values).
- Client: `stores/chatTranscript.ts` (entry origins for trimming),
  `stores/chatStore.ts` (resume snapshot), `stores/chatAttachment.ts`
  (attach fields).
- Wire (additive): `chat-attach` gains an optional `held` object;
  `chat-snapshot` gains an optional `resume` marker. Older clients send no
  `held` and receive full snapshots; older servers ignore `held`.
- Out of scope: tail-reading transcripts on first open after a restart
  (measured 0.1–0.2 s for most chats, 4.1 s for the 527 MB lead transcript;
  the owner reports the delay on every switch), list virtualization, and
  windowing nested worker transcripts.
- Coordination: `rename-agentboard-to-kawai` also modifies "WebSocket
  compression is opt-in" (renaming the variable to `KAWAI_WS_DEFLATE`).
  Whichever change archives second must rebase its delta onto the other's
  text.
