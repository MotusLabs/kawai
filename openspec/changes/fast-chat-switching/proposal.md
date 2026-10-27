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
  stop at 500 events or 512 KiB of serialized history — the UTF-8 encoded
  size of the delivered events array itself, counted separately from the
  snapshot envelope — whichever comes first, inside the existing 24-hour
  bound. History is delivered newest-first with whole-turn preference: the
  walk adds whole turn units while the complete selected suffix stays
  within both limits, and stops before the first older unit that would
  overflow either limit; only when the newest unit alone exceeds the
  budget is that unit delivered as its newest quiet parts, with the single
  newest part the one atomic exception. A part boundary never separates an
  open tool call from its result or a continuing assistant message. This
  amends the archived
  `chat-history-window` decision (D1) that rejected count/byte bounds and
  the rule that turns are never split.
- **Switching back sends only what changed.** A client that still holds a
  chat's transcript names its newest and oldest held events plus the opaque
  history generation the server issued alongside them; the server answers
  with only the newer events plus the window's new start while that
  generation still matches the memo the client held, and the client appends
  them and trims what fell out of the recomputed window. A replaced,
  released or replayed memo (server restart, kill, retry, release) issues a
  new generation, so a held transcript whose proof is missing, stale or
  unverifiable falls back to a full snapshot instead of resuming from
  guessed positions. The ordinary reconnect of a shown chat keeps today's
  `historyFrom` behaviour unchanged, and expansion is never inferred from
  the held marker alone. The reopen still slides the window as today.
- **Large non-terminal messages are compressed by default.** Per-message
  deflate is negotiated by default, and only messages whose full serialized
  outbound form is at least 16,384 encoded UTF-8 bytes and that are not
  terminal output are compressed (2.9 MB → 0.75 MB measured, 22 ms;
  author-supplied figures). Terminal frames stay uncompressed, so the
  keystroke-echo reason behind today's opt-in is kept.
  `AGENTBOARD_WS_DEFLATE=true` still compresses everything; a new `false`
  value disables negotiation entirely.
- **Eligible archived chats release their loaded history.** An archived chat
  that no client has subscribed to for 10 minutes drops its history memo
  when exact replay is safe — no driver output, in-flight load or retryable
  state could be lost, and the memo holds nothing that a replay would not
  reconstruct; a memo carrying live-only or partial state is kept intact
  instead. The next open replays the transcript again. One archived lead
  transcript (527 MB) held about 1 GB of heap for the rest of the server's
  run.

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
  (attach fields), `stores/chatHistoryPages.ts` (a page prepend carries the
  raw order, origins and first raw id it installs).
- Wire (additive): `chat-attach` gains an optional `held` object (newest and
  oldest held raw ids plus the server-issued history generation);
  `chat-snapshot` and `chat-history-page` replies gain an optional
  `historyEpoch` marker. Older clients send no `held` and receive full
  snapshots; older servers ignore `held`.
- Out of scope: tail-reading transcripts on first open after a restart
  (measured 0.1–0.2 s for most chats, 4.1 s for the 527 MB lead transcript;
  the owner reports the delay on every switch), list virtualization, and
  windowing nested worker transcripts.
- Coordination: `rename-agentboard-to-kawai` also modifies "WebSocket
  compression is opt-in" (renaming the variable to `KAWAI_WS_DEFLATE`).
  Whichever change archives second must rebase its delta onto the other's
  text.
