# Design

## Context

This change is the failure-fixing slice of `fast-chat-switching`; that
change's design remains the long form of D1 and D5 (its row ids W, E, B,
H, P1, P3, OW4 and OW5 are kept so the two changes reconcile row by row,
except the rows added or reworded here: W18–W25, E11, E12, E16–E20, B2,
B6, H3, H4, H7, H9, H10, P1, P3 and OW4). `fast-chat-switching` is held and
is not edited by this change; proposal.md records the exact overlap, and any
later reconciliation goes through Lead and that change's standing owner
gate. See proposal.md for the incident.

- **Server.** `ChatSessionManager` keeps a memo (`snapshotHistory`, the
  transcript replay) and `liveEvents` (everything emitted since). `getSnapshot`
  and `getHistoryPage` pass memo + live through the pure `historyWindow`
  (`src/server/chat/historyWindow.ts`), which cuts only at turn boundaries
  over the 24 hours ending at the newest dated event; options `fromId`
  (reconnect), `beforeId` (page) and `throughId` (search). Workspace context
  is attached after windowing.
- **Sends.** Every WebSocket send is `ws.send(JSON.stringify(message))`
  through `ConnectionHub.send`/`broadcast` or the terminal coalescer. Bun's
  `send` returns `0` for a dropped message, `-1` under backpressure, or the
  bytes sent; the default `backpressureLimit` is 16 MiB and
  `closeOnBackpressureLimit` defaults to `false`, so the hub, which ignores
  the status, loses messages with the socket still open.
- **Client.** `useWebSocket.ts` pings every 20 s and clears its 10 s
  deadline (`PONG_TIMEOUT_MS`), and the 1.5 s resume verification
  (`VERIFY_PONG_TIMEOUT_MS`), only on the matching `pong`. The browser
  reports a WebSocket message only when it has fully arrived.
- **Measured (earlier probes; chat identities in owner-controlled records).**
  Busiest real window 2,322 events and 2.9 MB; one long-running lead chat's
  snapshot was tens of MB, almost all `tool_result` output in
  `liveEvents`; the same day replayed from the rollout is about 2 MB.

## Goals / Non-Goals

**Goals:**

- No single message a chat sends is larger than a slow link can deliver
  inside the heartbeat deadline, whatever tool output the chat holds.
- The full output of an elided result stays one click away.
- A message is never lost with the connection still open.

**Non-Goals:**

- Compression, resume of a held transcript, idle memo release
  (`fast-chat-switching` D2–D4).
- Tail-reading transcripts on first open; list virtualization;
  windowing nested worker transcripts (not elided here either).
- Making every message fast enough on every link (see Risks).

## Decisions

### D1 — The history window has a size budget, cut at quiet points

`historyWindow` gains `HISTORY_MAX_EVENTS = 500` and
`HISTORY_MAX_BYTES = 512 * 1024`. Bytes are the UTF-8 length of the
serialized delivered events array (commas and brackets included), measured
on the projection the manager actually returns: workspace-context
decoration and D2's elision are applied before pricing, never a raw-only
estimate, and metadata is never stripped to fit. UTF-16 lengths are not wire
bytes.

1. **Parts.** A turn unit splits into parts at quiet points: event *i*
   (not the unit's first) starts a part when no earlier `tool_call` in the
   unit still awaits its `tool_result` and *i* does not continue the
   previous event's assistant message. Continuation is decided by
   `continuesEntry(prev, next)` in `src/shared/chatTranscriptMerge.ts`,
   already on master and imported by the client fold, so the server keeps no
   private copy. A turn with no quiet point is one part.
2. **Walk.** Candidate units are taken newest-first; a whole unit is added
   iff the complete selected suffix stays within both limits. Once any unit
   is selected, the first older unit that would overflow stops the walk and
   its parts never fill the leftover space. Only when the selection is still
   empty because the newest unit alone exceeds the budget is that unit
   split: its quiet parts are added newest-first under both limits, stopping
   before the first overflowing older part, and if the newest part alone
   exceeds a limit it is delivered alone (the single atomic exception). With
   no eligible candidate the window is empty (`events: []`, `startId: null`,
   `hasOlder` false); otherwise at least one part is delivered.
3. **Options.** `fromId` and `throughId` still widen to the *part* holding
   the id and ignore the budget (a reconnect must keep what was shown). A
   page (`beforeId`) applies the same rule walking back from the part before
   the one holding `beforeId`; the boundary turn's remaining portion is the
   newest candidate unit.
4. **Results.** `hasOlder` and `startId` keep their meaning, so the
   load-earlier control and the paging protocol are unchanged.
5. **Cross-turn results (legacy replay).** The replay can emit a tool call
   in one turn and its `tool_result` in a later one. That pair is not a
   *link* the window protects: the call never widens the 24-hour or the
   size selection, and never extends the single-part exception, so no span
   of intervening turns is ever pulled in to pair them. Every real event
   stays in its own normal page, and `hasOlder` and `startId` count actual
   retained older events. A delivered result whose call is not loaded is
   drawn by the existing standalone result row with a "call not loaded"
   marker (no new fetch, wire field or synthetic event); when
   load-earlier brings the recorded call, the client pairs them once by
   `toolCallId`. Explicit reveals (`fromId`, `throughId`, a `tool:`
   anchor) keep their widened-anchor semantics. A call with no result
   (cancelled or unfinished) is valid history and is never fabricated a
   result. *Rejected:* a linked unit spanning call to result, whose newest
   instance would be an unbounded part over intervening turns on exactly the
   slow link this change serves; no measurement shows such links are rare.

*Alternatives.* A count-only bound was rejected (one result can be hundreds
of KiB); a byte-only bound does not bound row count; rendering only the tail
still pays the transfer. This amends the archived `chat-history-window` D1,
which rejected count and byte bounds because turns were never split; the
quiet-point rule keeps its property that no same-turn tool entry shows
without its call or result (cross-turn results are item 5).

### D2 — Tool outputs are elided on delivery, measured as sent

A pure `elideToolOutput(event)` (`src/server/chat/toolOutputElision.ts`)
measures a `tool_result` output as sent: the UTF-8 length of
`JSON.stringify(output)`, quotes included. Above
`TOOL_OUTPUT_MAX_BYTES = 65_536` (inclusive limit) it returns a copy whose
output is the longest prefix ending on a character boundary whose own
serialized value is at most 65,536 bytes, plus
`outputElided: { totalBytes }`, where `totalBytes` is the canonical UTF-8
length (`TextEncoder`) of the whole original output. Any other event, or an
output within the limit, is returned as the same object; the source is never
modified. It runs on every delivery route: `getSnapshot` and
`getHistoryPage` before pricing (D1), and once at the top of
`ChatConnections.publish` before batching, so both send sites (the
batch-overflow send and `flush`) carry the elided event. The memo,
`liveEvents`, transcript files, search and the agent are untouched. Nested
worker transcripts are neither elided nor fetched. 64 KiB keeps a typical
diff or log whole while capping the 2 MB `task_get` replies at about a
thirtieth.

### D3 — The full output comes over HTTP, not the WebSocket

`GET /api/chat/sessions/:sessionId/tool-output/:eventId`
(`src/server/routes/chatToolOutput.ts`, mounted in `bootstrap.ts` beside
`/api/chat/search`) calls `ChatSessionManager.getToolOutput`, which is read-only like
`searchableEvents` (conversation search): a loaded chat reads its memo plus
live events; an unloaded or archived one is replayed transiently, never
memoized, never moving the chat's working directory or project path, never
scheduling a workspace refresh, never starting a driver. It does not call
`loadHistory`, whose Claude replay applies the transcript's last cwd. The
event id is looked up only in that session's own events: an unknown
session, unknown id, non-`tool_result` id, a result absent after replay, or
an id that belongs to a different session is `404`, never an empty
success. A hit replies `200`, `text/plain;
charset=utf-8`, `Cache-Control: no-store`, with the canonical UTF-8 bytes
and `Content-Length` computed from those same bytes (a leading BOM, multi-
byte and control characters round-trip; a lone surrogate is served as
U+FFFD and counted so). The route has the same trusted-listener boundary as
`/ws` and `/api/chat/search` (same listener; README, trusted network); it
adds no authorization, and `no-store` and the absence of CORS are not
access control. The service worker precaches only listed static assets and
excludes `/api` from its navigation fallback. No `chat-tool-output`
WebSocket message exists; the Debug view's raw frames are a separate,
unchanged capability.

The tool result view marks an elided output ("Output shortened — N KB
total"). Expanding starts one request with its own `AbortController`, reads
bytes and decodes with `TextDecoder('utf-8', { ignoreBOM: true })`, and
replaces the preview only when the whole body has arrived, its length equals
`totalBytes` and the request is still current for that expansion, session
and event. Collapse, re-expand, chat switch, detach and unmount abort it and
discard a late body. `404` shows "Full output unavailable"; a network error
or length mismatch keeps the preview with "Retry". A WebSocket close and
reconnect is not a detach, so a pending download continues across it.

### D4 — Live batches are capped as sent

`ChatConnections.publish` measures each pending `chat-events` batch as the
UTF-8 length of `JSON.stringify({ type: 'chat-events', sessionId, events })`.
Before an event joins a batch, `publish` sends the batch alone if adding it
would exceed `CHAT_EVENTS_MAX_BYTES = 262_144`; `flush` sends only batches
built under that rule. The 128-event cap and turn-boundary split keep their
meaning; the byte cap only adds split points. Every event is sent exactly
once, in order. A single event over the cap is sent alone; after D2 that can
only be a non-`tool_result` event with a large field, which is never elided.

### D5 — A full buffer closes the connection

`socketHandlers.ts` sets `closeOnBackpressureLimit: true` and keeps Bun's
16 MiB `backpressureLimit` as a named constant the tests can lower.
`ConnectionHub.send`, `broadcast` and the coalescer's sends read the
`ws.send` status. *Observed on the repository's pinned Bun (1.4.5,
`.bun-version`), 1 MiB limit, 65,536-byte frames:* frame 54 was accepted
with status `-1` while the buffer went from 1,032,722 to 1,098,268 bytes
(over the limit); frame 55 returned `0`. With the option off, the receiver
got frames 0–54, frame 55 was dropped and the socket stayed open. With it
on, the receiver got 0–37, the socket closed (1006), the buffer read 0 in
the close callback, and a later send returned `0`: frames 38–54 were
*accepted but never delivered*. So accepted is not delivered, the frame that
crosses the limit is accepted, and the close follows the first rejected
send; the probe did not show that a crossing send alone closes.
The product therefore closes and resyncs on the first rejected send. The
hub samples `getBufferedAmount()` on every send that returns `-1` and logs
`ws_backpressure_limit` (type, encoded length, that amount) when it is over
the limit, because the amount reads 0 once the socket has closed; a `0`
status logs `ws_send_dropped` (type, encoded length, the last sampled
amount) and the hub closes the socket itself; the close handler logs
`ws_backpressure_close` when it followed either. The option is the primary
close and the `0`-status close the fallback for any message Bun drops
without closing; both ship. Guarantees: the rejected frame and every later
send are never delivered to that socket; earlier accepted frames may still
arrive as one contiguous prefix before the close. Task 1.1 re-runs the probe
on the pinned Bun and records each status, amount and received sequence.
The client already reconnects and re-attaches after any close.
*Rejected:* a per-socket application queue with `pong` ahead of bulk
messages; it adds a second buffer next to the coalescer's ordering rules.

### D6 — Any inbound message proves life

In `useWebSocket.ts`, one `noteInbound()` call at the top of `onmessage`,
before parsing, first captures whether a pong timer and `heartbeatSentAt`
are armed, then clears the pong timer and settles a pending resume
verification the way the matching `pong` does today, including the
early-heartbeat restart. A malformed payload counts. Only the matching
`pong` (current `seq`, page visible, sample within `PONG_TIMEOUT_MS`) still
updates `srtt` from the captured state, so the measured resume deadline
(3 × `srtt`, clamped to 1.5–8 s, 1.5 s before any sample; terminal-streaming
main spec) is preserved; any other message settles the timers and takes no
sample. It acts only for the current socket: a message from a replaced
socket never settles the current socket's timers. Intervals and deadlines
are unchanged: a dead socket delivers nothing and is still replaced. This does not help while a single
message is still arriving, because the browser reports whole messages only;
D1, D2 and D4 are what keep each message small enough to arrive on its own.

## Risks / Trade-offs

- **One message can still be slow.** A snapshot near 512 KiB on a link
  slower than about 50 KB/s outlasts 10 s. Raising `PONG_TIMEOUT_MS` was
  rejected: it delays detection of dead sockets everywhere. Compression
  (`fast-chat-switching` D3) would cut this about 4x and is the follow-up.
- **Resume verification still fails behind a large message.** It allows
  3 × `srtt` clamped to 1.5–8 s (1.5 s before any sample); a message still
  arriving past that deadline causes a reconnect, as before. Unchanged here.
- **A late result may show without its call.** On a legacy cross-turn pair
  the result can be delivered while its call is older (D1 item 5); it shows
  as a standalone result marked "call not loaded" until load-earlier
  reaches the call. No payload is added to keep them together.
- **The HTTP download shares the link.** It stays out of the WebSocket's
  message stream but not the link's bandwidth; a 2 MB output takes about 40 s
  at 50 KB/s, and the preview stays usable meanwhile.
- **A copied result is the preview until expanded.** Copying an elided
  result copies the 64 KiB preview plus its marker.
- **A backpressure close drops in-flight terminal state.** A terminal
  re-attaches through the normal reconnect path; before this it lost
  messages silently.
- **A lone large non-result event is sent whole.** Only `tool_result` is
  elided; the largest tool call input seen was 27 KB.
- **Overlap with `fast-chat-switching`.** Both changes carry the same
  requirement names (proposal.md lists them exactly), so whichever is
  archived second needs reconciliation. That is not done here: the other
  change is held, its artifacts and task status are untouched, and the
  reconciliation is routed through Lead and its standing owner gate.
- **Ill-formed text is shown replaced.** A lone surrogate is served and
  counted as U+FFFD.

## Migration Plan

Additive; no schema or stored data changes. Mixed client and server
versions work: an older client shows the preview without the fetch, an older
server never elides. Rollback means reverting the change.

## Open Questions

None blocking. Task 1.1 re-runs the backpressure probe on the pinned Bun and
the B rows are checked against its record.

## Acceptance oracles

All tables are committed verbatim as table-driven tests next to the code they
cover. `*` means don't-care. Ids match `fast-chat-switching`'s tables.

### W — window cut (`historyWindow`, budget 500 events / 512 KiB)

| id | Input | Delivered |
|---|---|---|
| W1 | 24 h holds 3 turns, 200 events, 100 KiB | all 3 turns, `hasOlder` per older units |
| W2 | 24 h holds 9 turns, 2,300 events; newest 4 turns total 480 events | exactly the newest 4 turns; `hasOlder` true |
| W3 | newest unit alone: 2,700 events with quiet points every 10 events, each part within the byte budget (selection empty) | exactly 500 events of its newest-first quiet parts; starts at a quiet point; `hasOlder` true |
| W4 | in the oversized-newest-unit part walk, a newer part is already selected and the next older part holds a `tool_call` and its `tool_result` and would overflow | that older part is left to older history whole and the walk stops; the cut never separates the call from its result; both delivered or both absent (the oversized newest part itself is W8's atomic case, never excluded here) |
| W5 | in the part walk, a newer part is already selected and the next older part is one continuing assistant message that would overflow | that older part is left to older history whole and the walk stops; the cut never falls inside the message |
| W6 | newest unit alone exceeds the budget; its newest part is a `tool_call` with a 600 KiB `tool_result` | the result delivered elided (D2: its serialized output value at most 65,536 bytes) and priced at that elided, decorated size; the part fits, so the walk continues under both caps and the window stays within 512 KiB |
| W7 | exactly 500 events, ≤ 512 KiB encoded | all delivered (limit inclusive) |
| W8 | 501 events in one part, otherwise within bytes | that part whole (oversized single part) |
| W9 | turn started 25 h before newest, fits budget | whole turn or none (existing rule unchanged) |
| W10 | `fromId` names an event 1,200 events back | widened to the part holding it; budget ignored |
| W11 | `throughId` older than the budgeted start | widened to the part holding it |
| W12 | `beforeId`, the 24 h before it hold 1,500 events, bounded candidates as D1 | the same precedence as D1 — whole units, or the oversized newest candidate's part-suffix, or its single atomic part alone; caps hold except that one part; ends before `beforeId`'s part; `hasOlder` reflects the actual remaining older events |
| W13 | `beforeId`, empty 24 h before it, older turns exist | at least the next older unit |
| W14 | turn with no quiet point, 900 events | that turn whole (single part) |
| W15 | many small CJK text events in independent quiet parts, each part within the byte budget, whose combined UTF-8 crosses 512 KiB while the count stays below 500 (individually small raw events alone do not establish this — part size decides) | the walk stops at the same precedence points on the byte measure — a unit stop once units are selected, else the part boundary before the byte limit; no single-part exception |
| W16 | units already selected; the next older unit holds 600 events with quiet 10-event parts, over the remaining budget | the walk stops; that unit is left whole; its parts never fill the leftover space |
| W17 | budgeted attach and `beforeId` page with valid persisted workspace contexts: three raw units of about 170 KiB each (about 510 KiB raw, under the byte budget), each decorated with about 64 KiB of workspace context; each decorated unit fits alone and the count stays below 500 | the newest two decorated units, intact with full metadata; the walk stops before the third; real raw `startId`, actual `hasOlder`; no atomic exception (raw-only pricing would deliver all three and is killed here; if decoration made the single newest part alone exceed the cap, the existing atomic exception applies unchanged) |
| W18 | attach: a call 26 h before the newest event (turn 1), a filler turn, and its `tool_result` in the newest turn (legacy cross-turn pair); everything fits the budget | the call's turn ages out of the 24 h window; the recent result is delivered with its own turn, ordinary bounds unchanged; `hasOlder` true; the client draws the result as a standalone row marked "call not loaded"; a later `beforeId` page reaching the call folds the pair once by `toolCallId` (one entry, no duplicate) |
| W19 | attach: a call and its result both older than the window, newest turn unrelated | both left in older history; none delivered; `hasOlder` true |
| W20 | attach: newest unit 200 KiB selected; a 100 KiB unit holding a late result selected; an older 300 KiB unit holding its call, each measured as delivered | the first two fit and are delivered; the older unit stays whole in older history (it would overflow the remainder); `hasOlder` true; the result shows with the marker |
| W21 | `beforeId` page: the late result lies in the page, its call in a still older unit | the page delivers the result's unit by the ordinary rule, with no special age exception and no duplicate across pages; the call arrives on a later page |
| W22 | reveal: `throughId` names the late result's event id, and separately a `tool:<callId>` anchor | each keeps its existing widened-anchor semantics: the window widens to the unit holding the resolved event (the anchor's first match); nothing else changes |
| W23 | a legacy pair whose call-to-result span holds more than 2,700 events in turns that each fit the budget on their own | the ordinary count and byte limits apply and no atomic allowance is used (every turn fits): at most 500 events and 512 KiB are delivered; the window never expands to the whole span (the existing single-part exception, one oversized newest part alone, is not involved) |
| W24 | a call that is genuinely unfinished or cancelled, with no result, across turns | kept as recorded, never fabricated a result; no marker, no link |
| W25 | a page: the 24 h before the oldest entry hold one 501-event part, otherwise within bytes | that part delivered whole (single-part exception); `hasOlder` is true only when older events actually remain after it |

Unreachable: a part with zero events (every part starts at an event), a
`startId` inside a merged entry (W5 forbids the cut), a part holding a
`tool_result` without its owning call *within the same turn* (part 1's
quiet-point rule keeps same-turn pairs together; a cross-turn legacy result
is reachable, see W18), and a part walk entered while any unit is selected
(the split branch requires an empty selection).

### E — tool-output elision, full-output route, live batches (`elideToolOutput`, `chatToolOutput` route, `publish`)

Sizes are serialized string values (UTF-8 of `JSON.stringify(output)`,
quotes included) unless a row says otherwise; `totalBytes` is always the
canonical UTF-8 length of the whole original output.

| # | Input | Expected |
|---|---|---|
| E1 | `tool_result`, output 65,534 ASCII characters (serialized 65,536) | unchanged, same object, no `outputElided` |
| E2 | `tool_result`, output 65,535 ASCII characters (serialized 65,537) | output = first 65,534 characters; `outputElided.totalBytes` = 65,535; source object unchanged |
| E3 | 65,533 × `a` then `€` (3 bytes) and more text | output = the 65,533 `a`s (serialized 65,535); decodes with no U+FFFD |
| E4 | 65,530 × `a`, an emoji (4 bytes), then `b` | output ends with the emoji, serialized exactly 65,536 |
| E5 | any non-`tool_result` event with a 2 MB field (`tool_call` input, `assistant_text`) | unchanged, same object |
| E6 | snapshot, page, and live `chat-events` carrying the same 2 MB result | identical elided event on all three routes |
| E7 | escape-heavy outputs: 2,000,000 × U+0001; 40,000 × `"`; 40,000 × `\`; 40,000 × newline | U+0001 cut to 10,922 characters (serialized 65,534) with `totalBytes` 2,000,000; each two-byte-escape case cut to 32,767 characters (serialized 65,536); no escape sequence split |
| E8 | output U+FEFF + 100,000 × `a`; separately, a lone surrogate U+D800 + 70,000 × `a` | `totalBytes` 100,003; `totalBytes` 70,003 (the surrogate counted as U+FFFD, 3 bytes) |
| E9 | search an active (loaded) chat for text beyond the preview of an elided result | found, with a snippet (search reads stored history, not the projection) |
| E10 | `GET` the route through the real app and manager for a 2 MB ASCII result, the E8 fixtures, a multi-byte and control-character fixture, and the E7 U+0001 fixture | `200`; `Content-Type: text/plain; charset=utf-8`; `Cache-Control: no-store`; `Content-Length` = body length = `totalBytes`; body byte-identical to the canonical UTF-8 of the stored output |
| E11 | `GET` for an unknown session, an unknown event id, a non-`tool_result` id, a result absent after replay, and the id of a result that belongs to a different session | `404` in every case; never `200` with an empty body |
| E12 | `GET` for a result of a cold archived chat after a server restart (no memo, no live events) | the transcript replays transiently; `200` with the E10 body; no memo is created and the stored output is untouched (state checks are E19) |
| E13 | client expansion over a fake `fetch`: a body with a leading U+FEFF; a body one byte short of `totalBytes`; a `404`; a network error | first: full text shown with the U+FEFF kept; second and fourth: preview kept with "Retry"; third: preview kept with "Full output unavailable" |
| E14 | collapse and re-expand while the first request is pending, and the first then completes; separately, chat switch, detach, and unmount while pending | the first request's signal is aborted and its late body is discarded; only the second request's body is adopted; switch, detach, and unmount abort with no later state update |
| E15 | the WebSocket closes and reconnects, and a resume verification succeeds, while a download is pending for the same session and event | the same request continues; no second request is made; its body is adopted on completion |
| E16 | measured envelope fixture, session id of 36 characters (the envelope adds 83 bytes to the `events` array): events whose array is exactly 262,062 bytes, published within one flush tick | the array alone fits 262,144 but the full message `{type, sessionId, events}` is 262,145 bytes, so it must split; every sent message is at most 262,144 bytes; kills "array-only measurement" |
| E16a | the same fixture with an array of exactly 262,061 bytes | the message is exactly 262,144 bytes and is sent whole (limit inclusive) |
| E16b | eight `tool_result`s of 2,000,000 × U+0001 in one turn, published (a) within one flush tick and (b) after 125 small events, so the 128-event overflow send also fires | every `chat-events` message as sent (UTF-8 of the whole message JSON) is at most 262,144 bytes; every event is delivered exactly once, in order, across overflow and flush sends; each delivered result equals E7's elided event; the route still serves the full 2,000,000-byte body |
| E17 | one `tool_call` event whose input is 2 MB, between two small events of the same turn | it is sent alone as a one-event batch; the neighbours are delivered in order before and after it |
| E18 | events of two turns, and 130 small events of one turn, all under the byte cap | batches split at the turn boundary and at 128 events exactly as before D4 |
| E19 | cold archived Claude chat whose transcript's last working directory differs from the record's project path; `GET` the route twice | both `200` with the E10 body; afterwards the record's project path is unchanged, no workspace refresh is scheduled, no memo is created, no driver exists; assert chat state as well as bytes; kills a route that calls `loadHistory` |
| E20 | client store and view: a snapshot delivers a result whose call is not loaded; then a `beforeId` page delivers the call | first: one standalone "Tool result" row marked "call not loaded"; after the page: one paired entry (call with its result), no duplicate row, no marker; a result whose call is loaded never carries the marker |

### B — backpressure (`socketHandlers`, `ConnectionHub`)

| # | Buffered state | Expected |
|---|---|---|
| B1 | production handler options | `closeOnBackpressureLimit: true`, `backpressureLimit` = the named 16 MiB constant |
| B2 | pinned Bun, test limit lowered; a stalled raw client; sequence-numbered frames sent until a send is rejected | the first rejected send closes the socket; `ws_backpressure_limit` was logged at the last `-1` send with its encoded length and a buffered amount over the limit; `ws_backpressure_close` follows the close; the rejected frame and every later attempted send are never delivered; the client reads one contiguous prefix of the accepted frames and no gap, in order |
| B6 | the same run: frames carry sequence numbers; witness sequence membership, never receipt time | with `r` the sequence number of the first rejected send: the client's received set is a contiguous prefix `0..k` with `k` below `r` (frames accepted before the rejection may still arrive after the instant of rejection); `r` and every higher sequence number are absent; the frame that crossed the limit (status `-1`) is accepted, so its delivery is not claimed from the status |
| B3 | `ws.send` returns `0` on any route (a fake socket whose `send` returns `0` and stays open, independent of Bun's option) | `ws_send_dropped` logged with type, encoded length and the last sampled buffered amount; the hub closes the socket itself |
| B4 | buffer stays below the limit | every message delivered in order; socket open |
| B5 | one socket closed at the limit | a second socket on the same server receives a broadcast sent afterwards |

### H — heartbeat liveness (`useWebSocket`, fake timers)

| # | After a ping | Expected |
|---|---|---|
| H1 | nothing arrives for `PONG_TIMEOUT_MS` | socket destroyed; reconnect scheduled (`ws_pong_timeout`) |
| H2 | a non-`pong` message arrives at 9 s; the pong never comes | no reconnect at 10 s; the next heartbeat pings again |
| H3 | the matching `pong` arrives | timer cleared and `srtt` sampled from the captured armed state (unchanged behaviour) |
| H4 | a `pong` with a stale `seq` arrives and nothing else | counts as an inbound message: timer cleared (any message proves life); no RTT sample |
| H5 | resume verification; a `sessions` message arrives within `VERIFY_PONG_TIMEOUT_MS` | verified; early heartbeat started; no force reconnect |
| H6 | resume verification; nothing arrives | force reconnect (unchanged) |
| H7 | a malformed (non-JSON) payload arrives at 9 s; the pong never comes | counts as inbound: no reconnect at 10 s; no RTT sample |
| H8 | the socket was replaced; the old socket delivers a message while the new socket's ping is pending and nothing arrives on the new one | the new socket's timer is not cleared: it is destroyed at its deadline |
| H9 | no prior RTT sample; the matching `pong` arrives 1.2 s after its ping; later a resume verification starts | `srtt` is 1.2 s; the verification deadline is 3.6 s, not 1.5 s: a message at 3 s verifies and silence reconnects at 3.6 s; kills "timer cleared before sampling" and "fixed 1.5 s" |
| H10 | a non-`pong` message arrives while a ping is pending | the timer is settled; `srtt` is unchanged (any inbound takes no sample) |

### Properties

- **P1 — budget and integrity (budgeted modes only).** For any generated
  history, in attach and page modes (never the widened `fromId`/`throughId`
  exemptions), the delivered window follows the precedence: whole units
  newest-first up to the first overflow stop; only an empty selection on
  an oversized newest unit walks that unit's quiet parts, with at most the
  single atomic newest part; the window stays within both limits unless
  that one atomic part stands, the encoded-byte measure counted over the
  complete delivered suffix as actually projected — the workspaceContext
  decoration and D2's elision included, never a raw-only estimate, with
  metadata-bearing cases joining the same 500-case generator — every
  delivered `tool_result` output's serialized string value (quotes
  included) is at most 65,536 bytes, carrying `outputElided` exactly when
  the delivered output differs from the stored one, with `totalBytes` the
  stored output's canonical UTF-8 length, and every
  delivered `tool_result` whose call is in the same turn has that call in
  the window and vice versa (same-turn integrity); a result whose call is in
  an earlier turn is delivered by the ordinary selection alone, never
  widening it (the cross-turn display boundary, D1 item 5); a call with no
  recorded result (cancelled or still unfinished) is valid history, kept as
  it stands and never fabricated a result. The generator
  is a seeded LCG over turns of
  1–60 events mixing text runs, same-turn and cross-turn tool call/result
  pairs with sizes up to 700 KiB, unmatched cancelled calls, and gaps of
  0–50 h. The seam is
  `historyWindow`. Seed `0x5eed`, 500 cases.
- **P3 — pages tile history.** Repeated `beforeId` pages from the recent
  window down to `hasOlder: false` concatenate to the whole history in
  order with no duplicates; the tiles are compared by the original event
  ids, so a cross-turn pair appears once per member. The generator and seed are the same as P1, with
  300 cases.

### Production wiring (hazard M1)

- **OW4.** Through the real app built by `bootstrap.ts` and `ChatConnections`
  over a real manager whose driver emits a `tool_result` of 2,000,000 ×
  U+0001 live: the subscribed client receives the elided event (E7) over
  `chat-events` on both live send sites (the batch-overflow send in
  `publish` and the scheduled `flush`); a fresh attach receives the same
  elided event in its snapshot; and `GET` on the route returns the E10
  headers and the full 2,000,000-byte body. No ordinary WebSocket delivery
  (snapshot, page, `chat-events`) to any client carries more of that output
  than the preview; with a Debug subscriber attached, its raw frames are
  unchanged (full frame content, live), as the chat-debug capability
  requires. Mutants: elision
  applied only in `getSnapshot` (the live route ships the whole output);
  elision written back into `liveEvents` (the body is the preview and its
  length differs from `totalBytes`); a WebSocket tool-output transport
  reintroduced in any form (the no-output-frames assertion fails,
  whatever the timing); the route not mounted, or mounted at another path
  (the `GET` gets no `200` with the E10 headers and body). Mounting before
  the static fallback stays a requirement but is not a mutant: Hono's
  `serveStatic` calls `next()` when no file matches, so a route mounted
  after it still answers.
- **OW5.** A real Bun server built by the production `socketHandlers`
  with the limit constant lowered, and a raw TCP client that stops reading
  (B2), then resumes. Expected: the socket is closed, and the messages the
  client read before the close carry contiguous sequence numbers (no gap).
  Mutant: both close mechanisms removed — `closeOnBackpressureLimit` left
  `false` and the hub's `0`-status close deleted — so the socket stays open
  while messages are dropped, which the test detects as a sequence gap on
  an open socket. Each mechanism alone is killed separately: the option by
  B1 at the production options boundary, the `0`-status fallback by B3
  over a fake socket. OW5 does not claim that removing only one of them
  leaves the socket open, because the other still closes it.

## Implementation contract

### Acceptance

- A1: Attaching to a chat whose last 24 hours hold 2,300 events delivers at most 500 events and 512 KiB of serialized events (W2, W3), unless a single oversized newest part stands alone (W8), and offers load-earlier.
- A2: A `tool_result` whose serialized output exceeds 65,536 UTF-8 bytes reaches the client elided on snapshot, history page and live `chat-events`, with `outputElided.totalBytes` equal to the stored output's UTF-8 length (E1–E8, E6, OW4).
- A3: `GET /api/chat/sessions/:sessionId/tool-output/:eventId` returns the stored output byte for byte as `text/plain; charset=utf-8` with `no-store` and an exact `Content-Length`, and `404` for an unknown session, an unknown id or a non-`tool_result` id (E10–E12).
- A4: Expanding an elided result shows the full text only when the whole body has arrived with length `totalBytes`; a stale, collapsed or aborted request is never adopted and a WebSocket reconnect does not restart it (E13–E15). The route changes no chat state and answers `404` for another session's event (E11, E12, E19).
- A5: No `chat-events` message exceeds 262,144 bytes as sent unless it carries one event that alone is larger, and every event is delivered once, in order (E16–E18).
- A6: On the first rejected send at the backpressure limit the connection is closed and logged with the buffered amount sampled at the last `-1` send; the rejected frame and later sends are never delivered, earlier accepted frames may arrive as one contiguous prefix, and a `ws.send` status of `0` closes it too (B1–B6, OW5).
- A7: After a ping, any inbound message on the current socket keeps the connection; silence for the deadline still reconnects (H1–H8).

### Invariants

- I1: Stored history, `liveEvents`, search and the agent never see an elided output; elision is a delivery projection only.
- I2: A window cut never separates a `tool_call` from its `tool_result` within a turn or splits a continuing assistant message. A result whose call is in an earlier turn never widens the window; it is shown with a "call not loaded" marker until the call is loaded, then paired once (D1 item 5).
- I3: The budget is measured on the projection actually returned (decorated and elided), never a raw-only estimate.
- I4: No ordinary transcript delivery (snapshot, page, `chat-events`) and no result expansion carries more of an elided output than its preview over the WebSocket. The Debug protocol-frame view keeps raw frames as the chat-debug capability requires and is outside this invariant.
- I5: A message from a replaced socket never settles the current socket's heartbeat or verification timers.
- I6: `fromId` and `throughId` widened windows are never trimmed by the budget.

### Scope

- `src/server/chat/historyWindow.ts`
- `src/server/chat/toolOutputElision.ts`
- `src/server/chat/ChatSessionManager.ts`
- `src/server/chat/ChatConnections.ts`
- `src/server/routes/chatToolOutput.ts`
- `src/server/bootstrap.ts`
- `src/server/ws/**`
- `src/shared/chat.ts`
- `src/shared/chatTranscriptMerge.ts`
- `src/client/hooks/useWebSocket.ts`
- `src/client/components/chat/**`
- `src/client/stores/chat*.ts`
- `src/server/__tests__/**`
- `src/client/__tests__/**`
- `docs/recovery-matrix.md`
- `AGENTS.md`

### Verification

- V1: Tables W (W1–W25), E (E1–E20, including E16a and E16b), B (B1–B6) and H (H1–H10) are committed verbatim as table-driven tests, with properties P1 and P3 (seed `0x5eed`, 500 and 300 cases), and pass under `bun run test`.
- V2: Production wiring tests OW4 and OW5 pass over the real app and a real Bun server.
- V3: `bun run check` passes on the clean committed tree.
- V4: On the affected lead chats (identities held in owner-controlled records), the attach snapshot is at most about 600 KiB and the chat loads on the owner's phone link (task 6.2).

### Excluded

- X1: No compression, resume of a held transcript, or archived-memo release (`fast-chat-switching`).
- X2: No change to `PONG_TIMEOUT_MS`, `VERIFY_PONG_TIMEOUT_MS` or the heartbeat interval.
- X3: No elision or windowing of nested worker transcripts.
- X4: No Android keyboard or other mobile layout change.
