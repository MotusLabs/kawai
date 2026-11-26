# Proposal

## Why

A chat whose in-memory history holds large tool outputs never opens over a
slow link. In one earlier incident a long-running lead chat sent a single
`chat-snapshot` of tens of MB, almost all of it full `tool_result` output
kept since the server's restart (mostly repeated multi-MB task results),
while a replay of the same day from the rollout file was about 2 MB. The
client's heartbeat expired after 30 s, it reconnected, the server re-sent
the same frame, and the loop never ended. The owner now sees the same on a
phone: a long-running lead chat never loads and Kawai shows a lost
connection, while small chats open fine. The exact chats and measurements
are held in owner-controlled records.
Three faults combine: one message too large for the link, a heartbeat that
only the matching `pong` can satisfy, and a server that silently drops
sends once a socket buffer passes Bun's 16 MiB limit (`ConnectionHub`
ignores the `ws.send` status).

`fast-chat-switching` already designs the fix, bundled with compression,
resume-on-reattach and idle memo release, and none of it is built (0 of 26
tasks; only task 2.1, `src/shared/chatTranscriptMerge.ts`, is on master).
This change takes the slice that stops the failure and can ship alone.

## What Changes

- **Size budget on the history window.** Attach and each load-earlier page
  stop at 500 events or 512 KiB of serialized delivered events, whichever
  comes first, inside the existing 24-hour bound. Whole turn units fill
  newest-first; only an oversized newest unit is cut, at quiet part
  boundaries; its single newest part is the one atomic exception. A cut
  never separates a tool call from its result within a turn. A result whose
  call lies in an earlier turn is not a pair the cut protects: the call
  never widens the 24-hour or size selection, and a result delivered
  without its call shows as a standalone result marked "call not loaded"
  until loading earlier history brings the call, when the pair folds once.
- **Large tool outputs are elided on the wire.** Every `tool_result`
  delivered in a snapshot, a history page or live `chat-events` whose
  serialized output exceeds 65,536 UTF-8 bytes carries a prefix within that
  size plus `outputElided` with the full size. Stored history, search and
  the agent keep the full output. The budget is priced on elided events.
- **The full output comes over HTTP.** Expanding an elided result downloads
  it from the new read-only route
  `GET /api/chat/sessions/:sessionId/tool-output/:eventId`, never over the
  ordinary WebSocket delivery. The route changes no chat state, even for a
  cold archived chat, and answers 404 for another session's event. The
  download can be cancelled and survives a reconnect. The Debug view's raw
  frames keep their own contract.
- **Live batches are capped as sent.** A `chat-events` message is at most
  256 KiB, except a single event that alone is larger.
- **Messages are never dropped silently.** The server sets
  `closeOnBackpressureLimit` and closes, with a log line, any connection
  whose `ws.send` is rejected; frames accepted earlier may still arrive as
  one contiguous prefix, and none is delivered after the rejected one.
- **Any inbound message proves the connection alive.** After a heartbeat or
  resume-verification ping, any message that arrives before the deadline
  keeps the connection, not only the matching `pong`. Only a matching `pong`
  still samples the round-trip time, so the clamped resume deadline keeps
  its measured value.

**Not in this change** (they stay in `fast-chat-switching`): per-message
compression (its section 4), resume of a held transcript on reattach
(section 3) and idle release of archived memos (section 5), plus its Bun
probe 1.1 for compression. This change runs only the backpressure half of
that probe.

**Overlap (recorded for Lead; nothing of `fast-chat-switching` is edited
here).** `fast-chat-switching` is held, and its artifacts and task status stay
exactly as they are. The overlap, by name:

- Both MODIFIED `chat-sessions` requirements, "Attaching delivers the recent
  history window" and "Users load earlier history on request".
- Four ADDED `chat-sessions` requirements: the size budget, elision of large
  tool outputs, the full-output route, and bounded live batches.
- Two ADDED `terminal-streaming` requirements, "Outbound messages are never
  silently dropped" and "Any inbound message proves the connection alive",
  with different text here (first rejected send, round-trip sampling).
- Its tasks 2.1–2.3, 6.1–6.6 and the backpressure half of 1.1, reworded here
  as sections 1–4.

Only "A late tool result never widens the window" has no counterpart there.
Compression, held-transcript resume, idle memo release and its third
MODIFIED requirement stay with it. Any later reconciliation (which change
drops the duplicated requirements, how the MODIFIED text is rebased onto the
main spec) is routed through Lead and the standing owner gate for that change.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `chat-sessions`: the recent window and each page gain the size budget;
  new requirements for the budget itself, elision of large tool outputs,
  serving the full output, and bounded live event batches.
- `terminal-streaming`: new requirements that outbound messages are never
  dropped silently and that any inbound message proves a connection alive.

## Impact

- Server: `src/server/chat/historyWindow.ts` (parts, budget),
  `ChatSessionManager.ts` (pricing on the returned projection,
  `getToolOutput`), `ChatConnections.ts` (elide once in `publish`, byte
  cap), `toolOutputElision.ts` (new), `routes/chatToolOutput.ts` (new,
  mounted in `bootstrap.ts`), `ws/ConnectionHub.ts` and
  `ws/socketHandlers.ts` (send status, `closeOnBackpressureLimit`, logs).
- Shared: `chatTranscriptMerge.ts` (already on master), `chat.ts`
  (`outputElided` on `tool_result`).
- Client: `hooks/useWebSocket.ts` (any inbound message satisfies the
  deadlines; only the matching `pong` samples the round-trip time), the tool
  result view (elided marker, HTTP download on expand, "call not loaded"
  marker on a standalone result).
- Wire (additive): `tool_result` gains optional `outputElided`
  (`{ totalBytes }`). An older client shows the preview without the fetch;
  an older server never elides.
- Docs: the `AGENTS.md` chat-history bullet, and `docs/recovery-matrix.md`
  rows for the backpressure close and an interrupted download.
- Out of scope: compression, resume, memo release, tail-reading
  transcripts on first open, list virtualization, windowing nested worker
  transcripts, and the Android keyboard fix (a separate change).
