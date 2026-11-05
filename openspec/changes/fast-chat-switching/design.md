# Design

## Context

- **Server.** `ChatSessionManager` keeps two lists per chat. The memo
  (`snapshotHistory`) is the transcript replay, filled once by `loadHistory`
  and dropped only on kill. `liveEvents` holds every event emitted since the
  memo was taken. `getSnapshot` passes memo + live through the pure
  `historyWindow` (`src/server/chat/historyWindow.ts`). That function cuts
  only at turn boundaries, over the 24 hours ending at the newest dated
  event. Its options are `fromId` (reconnect), `beforeId` (page), and
  `throughId` (search).
- **Attach.** `ChatConnections`' `chat-attach` awaits `loadHistory`, sends
  the snapshot, and starts the agent. Each WebSocket send is
  `ws.send(JSON.stringify(message))` through `ConnectionHub.send`/`broadcast`
  or the terminal output coalescer (`socketHandlers.ts`). No send passes a
  `compress` argument, and `perMessageDeflate` is
  `AGENTBOARD_WS_DEFLATE === 'true'` (terminal-keystroke-lag D3).
- **Client.** Switching chats releases the attachment, which queues
  `chat-detach` (`chatAttachment.ts`). Reselecting sends a plain
  `chat-attach`, or one with `historyFrom` after a reconnect or when the user
  had expanded history. `chatStore.snapshot` then replaces the transcript.
  `applyChatEvents` folds raw events into entries. A merged assistant text
  entry takes the later raw event's id. `seen` and `throughSequence` drop
  repeats. `ChatMessages` renders every entry.
- **Measurements (2026-10-26).** The busiest real window held 2,322 events
  and 2.9 MB. Gzip brought it to 0.75 MB in 22 ms. The browser spent
  80–110 ms in React and 80–100 ms in layout on the server host. The warm
  server path took under 5 ms.
- **Incident (2026-11-05).** Global Lead's attach snapshot was 70.9 MB of
  6,722 events. Of that, 67.7 MB was `tool_result` output in `liveEvents`
  (471 results since the 05:36Z restart, 57 of them over 100 KiB, the
  largest 2.1 MB). The same day replayed from the rollout (1.86 GB file)
  gives 1,484 events and 1.9 MB. The client's heartbeat
  (`useWebSocket.ts`: ping every 20 s, `PONG_TIMEOUT_MS` 10 s) clears only
  on the matching `pong`, so the socket was declared dead every 31–32 s and
  the re-attach sent everything again. A loopback probe sent pings before,
  during, and after an 82.7 MB snapshot: the first and last pongs arrived,
  and the middle one never did.
- **Bun backpressure.** `ServerWebSocket.send` returns `0` when it drops a
  message, `-1` under backpressure, or the bytes sent
  (`bun-types/serve.d.ts`, Bun 1.4.3). The default `backpressureLimit` is
  16 MiB, and `closeOnBackpressureLimit` defaults to `false`. Every route
  in `ConnectionHub` ignores the status, so a message sent while a socket
  holds more than 16 MiB vanishes with the connection still open.

## Goals / Non-Goals

**Goals:**

- Bound what one switch sends and renders, whatever the day's activity.
- Send nothing a reselected chat already holds, beyond the new tail.
- Shrink the large chat messages on the wire without touching terminal
  echo latency.
- Stop an archived chat from holding its replay in memory after nobody
  watches it.
- Keep large tool outputs from stalling a live connection on a slow link,
  keep the full output one click away, and never lose a message silently.

**Non-Goals:**

- Tail-reading transcripts on first open after a restart.
- List virtualization or `content-visibility`. The budget bounds the
  mounted rows, and `content-visibility` together with `overflow-anchor:
  none` risks scroll jumps on upward scrolling.
- Windowing nested worker transcripts.
- Releasing memos of live (non-archived) chats. Their memo is the base that
  `liveEvents` extends, and dropping it while a driver appends would need a
  re-read that duplicates turns (memo audit D3/D4).

## Decisions

### D1 — The history window has a size budget, cut at quiet points

`historyWindow` gains a budget of `HISTORY_MAX_EVENTS = 500` and
`HISTORY_MAX_BYTES = 512 * 1024`. Bytes are the UTF-8 encoded length of the
delivered events-array serialization — each event's JSON plus the commas
and brackets that join them — the measure the wire actually transmits,
counted separately from the rest of the snapshot envelope, which the budget
never counts. The measured array is the one the manager actually returns:
`getSnapshot` and `getHistoryPage` attach `workspaceContext` after
windowing, so the pricing sees the same final projection it returns —
decoration before selection, or an equivalent projection/size callback
over the decorated events; no separate raw-only estimator exists, and
metadata is never stripped or truncated to fit. The projection also
includes D5's tool-output elision, which applies to every delivered
`tool_result` whatever the budget, so a result is priced at its elided
size. Elision is part of what the manager returns, not a step taken to
fit the budget. Raw ids, cuts, resume and page metadata, and part
integrity are unchanged.
(UTF-16 code-unit lengths are not wire bytes: one CJK text
event of 100 code units encodes to about 300 bytes.) Unless an example or
W row expressly exercises byte overflow, its complete eligible input's
UTF-8 serialized events array — commas and brackets included — fits the
512 KiB budget, and count-specific outputs below (W2's 480, W3's exactly
500, W16's 300, the 450+150→150 and 300+600→300 examples) hold under that
premise. Byte-overflow rows (W6, whose raw input overflows until D5a
elides it; W15; W17) carry no such premise. Individually
small raw events do not imply small parts: continuation can hold many
deltas in one part, which is then the atomic-exception domain.

1. **Parts.** Each turn unit (today's `unitsOf`) is split further into
   parts at quiet points. Event *i* (not the unit's first) starts a new part
   when two things hold. First, no `tool_call` before *i* in the unit still
   awaits its `tool_result` (matched by call id). Second, *i* does not
   continue the previous event's assistant message. Continuation is decided
   by the predicate the client fold uses to merge text into one entry, moved
   to `src/shared/chatTranscriptMerge.ts` as `continuesEntry(prev, next)`
   and imported by both sides (hazard "Several readers disagreeing on
   derived state"). The unit's first event always starts a part. A turn
   with no quiet point is one part. A call whose result never arrived
   (cancelled or unfinished) simply keeps the quiet points after it closed:
   the rest of its unit stays in the call's part, and history preserves the
   call without a fabricated result.
2. **Walk.** Today's 24-hour rule picks the oldest unit to deliver; for a
   page, the bound ends before the part holding `beforeId`, and where it
   cuts the boundary turn at a quiet boundary, only that turn's remaining
   eligible portion (its start through the part before `beforeId`'s part)
   is the newest candidate unit. Candidates are considered newest first.
   A whole candidate unit is added iff the complete selected suffix stays
   within both limits — the encoded-byte measure runs over that whole
   suffix, commas and brackets included. Once any unit has been selected,
   the first older unit that would overflow the remaining budget stops the
   walk: its space is never filled with pieces of that unit, however large
   or finely partable it is. Example (W2): nine units totalling 2,300
   events, the newest four totalling 480, the fifth-newest holding quiet
   10-event parts — exactly the newest four units, 480 events, are
   delivered. Only when the selection is still empty because the newest
   unit alone exceeds the full budget is that one unit split: its quiet
   parts are added newest-first while the complete selected suffix fits
   both limits, the walk stops before the first overflowing older part,
   and if the unit's newest part alone exceeds either full limit, exactly
   that one part is delivered (the single atomic exception). The walk
   never enters older units after this branch and never moves a cut
   backward to a nominal event index. Examples: a 600-event unit whose
   quiet parts are [0, 450) — a `tool_call` at 0 with its `tool_result`
   at 449 — and [450, 600) — one continuing assistant text run — delivers
   only the last 150 events; a newest 300-event unit ahead of an older
   600-event unit delivers 300, however finely the 600-unit's parts
   divide. At least one part is delivered whenever eligible candidates
   exist; with no eligible candidates the window is empty — `events: []`,
   `startId: null`, `hasOlder` false — and no part is fabricated.
3. **Options.** `fromId` and `throughId` still widen the window to the unit
   holding that id. A widened window ignores the budget, because a
   reconnect must keep what was shown. `fromId` and `throughId` resolve to
   the *part* holding the id, so the widening stops at the part, not the
   unit. A page (`beforeId`) applies the same 24-hour rule, the same
   candidate-unit treatment of the boundary turn's remaining portion, and
   the same budget, walking backward from the part before the one holding
   `beforeId`, and delivers at least one part when an older candidate
   exists; a page bounded at the first part returns empty (`events: []`,
   `startId: null`, `hasOlder` false) instead of a fabricated part.
4. **Results.** `hasOlder` is true when anything precedes the delivered
   start, and `startId` is the first delivered event's id. Both keep their
   current meaning, so the client's load-earlier control and the paging
   protocol are unchanged.

This amends the archived `chat-history-window` D1, which rejected count and
byte bounds because turns were never split. The quiet-point rule keeps the
property D1 protected: no tool entry is ever shown without its call or
result, and no assistant message is ever shown half.

*Alternatives.* A count-only bound was rejected: one tool result can be
several hundred KiB, and a byte-only bound does not bound row count. The
client could also render only the tail, but that still pays the transfer.

### D2 — Reattaching a held chat resumes instead of replacing

**Wire (additive).** Every `chat-snapshot` and `chat-history-page` reply
gains `historyEpoch?: string` — an opaque, per-process token the manager
mints whenever a session's memo comes into being or is replaced: first
population by `loadHistory`, a retryable Codex memo's replacement, a
release-and-replay, and every process restart. Appends to `liveEvents`
never change it: the token names the immutable prefix the client may hold.
`chat-attach` gains
`held?: { newestId: string; startId: string; epoch: string; expanded?: boolean }`.
It is sent only when the client still holds a non-empty transcript of that
chat from this page load, carrying the last epoch the server showed it
and, when the user had loaded earlier history, `expanded: true` — the
server never infers expansion from `held` alone.
`chat-snapshot` gains `resume?: { afterId: string }`. When `resume` is
present, `events` holds only the events after `afterId`, and `historyStartId`
and `historyHasOlder` describe the recomputed window. Every other field
(pending requests, activity, rosters, notices, usage, `throughSequence`) is
complete and authoritative, as today. An older server ignores `held` and
sends a full snapshot. An older client never sends `held`.

**Server decision** (`resumeDecision`, pure, in `historyWindow.ts`). The
server computes the window it would send for a plain attach. If the client
sent `expanded: true`, it uses `fromId = held.startId`, as `historyFrom`
does today. It then checks the proof: `held.epoch` must equal the current
`historyEpoch`, and both `held.newestId` and `held.startId` must be found
in memo + live with the start at or before the newest. It resumes only
when the epoch matches, both ids are found in order, and
`index(held.startId) ≤ index(window start) ≤ index(held.newestId) + 1`.
In that case it sends the events after `held.newestId`. In every other
case — epoch missing, stale, or matching without a provable range — it
sends a full snapshot and never guesses index 0: endpoint presence alone
proves nothing, because a release or restart can replay a transcript that
rewrites an interior row while both held endpoints keep their ids, and
only the epoch detects it. The ordinary reconnect of a shown chat keeps
today's `historyFrom` path unchanged — the window widens to the part
holding `historyFrom`, budget ignored, including a `historyFrom` older
than the budgeted start (lower-bound widening, exercised in OW1). Table R
below is the complete rule.

**Client tracking.** The client must know what it holds in raw-event terms,
because a merged entry's id is a later raw id. `ChatTranscript` therefore
gains:

- `rawOrder`: the applied raw event ids, oldest first.
- `entryOrigin`: each entry's first raw id.
- `historyEpoch`: the epoch the server last issued for this transcript,
  taken from the snapshot that built it and refreshed by every
  `chat-history-page` reply.

`applyChatEvents` maintains the raw fields on fold and on snapshot
replace; the page prepend in `chatHistoryPages` maintains them for the
events it installs — it carries the page's raw order, entry origins and
`seen` marks into the held transcript and keeps the first raw part id as
the start, never advancing the live `throughSequence` watermark
(`startId` stays a raw part id even when the page's first entries merge).
`held.newestId` is the last raw id, `held.startId` is `historyStartId`,
`held.epoch` is the held `historyEpoch`, and `held.expanded` is the
transcript's own expanded state — never inferred from the other fields.

**Client apply** (`applyResume`, pure, in `chatTranscript.ts`):

1. Fold the delta events with the held `throughSequence`. Set the snapshot's
   `throughSequence` only afterwards; otherwise the delta's live sequences
   would be skipped.
2. Drop every entry whose origin precedes the new `historyStartId` in
   `rawOrder`. Remove those raw ids from `rawOrder` and from `seen`, so a
   later page can bring them back.
3. Replace pending requests and the other whole fields.

If `afterId` is not the client's newest raw id, or `historyStartId` is not
in `rawOrder` after the fold, the client discards the resume and re-attaches
plain (table A). A stale or wrong anchor may instead be caught earlier on
the server — an epoch or range miss sends a full snapshot (R2–R6); both
fallbacks are correct outcomes for a mismatched held transcript, and the
oracles accept either failure site rather than demanding the client's.
Because D1 never cuts inside a merged entry, the trim never
splits one.

**Effect.** After `applyResume`, the transcript's entries equal what a full
attach at that moment would produce (property P2). Reopening still slides
the window, as the existing requirement states. The only change is that the
unchanged middle is not re-sent. The remount cost stays, bounded by D1's
500 events.

*Alternatives.* Keeping the subscription open while switching (no detach)
was rejected: background chats would keep streaming every event to every
tab. A client-side cache with no server agreement was rejected because it
cannot detect a restart or a kill.

### D3 — Per-message compression for large non-terminal messages

`config.wsDeflate` becomes a mode read from `AGENTBOARD_WS_DEFLATE`:

| Value | Mode |
|---|---|
| `false` | `off` |
| `true` | `all` |
| anything else or unset | `large` |

`perMessageDeflate` is `false` for `off` and `true` otherwise. The
threshold is over the full serialized outbound message — the complete JSON
the send would transmit, envelope included — measured in encoded UTF-8
bytes: at least 16,384 encoded bytes compresses in `large` mode, smaller
messages never do (a non-ASCII message's encoded length decides, not its
code-unit count). One pure
function, `compressFor(mode, type, encodedLength)` (`src/server/ws/compression.ts`),
is passed as the `compress` argument of every `ws.send` — Bun's
`ServerWebSocket.send(data, compress?)`, where `compress` is the second
argument (zero-based index 1); `publish(topic, data, compress?)` is a
different API and none of these routes. The physical send
routes are finite and enumerated; each passes the flag explicitly:

1. `ConnectionHub.broadcast` — stringifies once for all its sockets; the
   decision is made once per message from its type and encoded length.
2. `ConnectionHub.send` on a socket without a coalescer — the direct
   fallback send of the message object.
3. The coalescer's ordered sends (`outputCoalescer`'s queued non-terminal
   messages, `terminal-output` frames included).
4. The coalescer's terminal flush.

The string-only send callback at `socketHandlers.ts` receives the message
type and encoded length beside the payload — a fact the coalescer's queue
entries carry, never inferred by treating every callback as terminal
output. Terminal types are
`terminal-output`, `terminal-ready`, `terminal-error`, and `terminal-attach`.
When the client did not negotiate the extension, Bun sends uncompressed
whatever the flag; what Bun does when `compress` is omitted under
negotiation stays unknown until probe 1.1 runs, and every send passes the
flag explicitly — its presence asserted at the call boundary (OW2),
independently of the wire bits — so that default never matters.

*Alternatives.* Application-level gzip in a binary frame was rejected: it
would change the client's message decoding and gain nothing over the
standard extension. A per-socket option was rejected because the keystroke
echo and the snapshot share one socket.

### D4 — Eligible archived chats release their memo after 10 idle minutes

`ChatConnections` tells the manager when a chat's subscriber count changes
between zero and non-zero, through `noteWatched(sessionId, watched)`. It
calls this from attach, detach, and connection close. The manager arms one
unref'd timer per archived chat when the chat becomes unwatched, when it is
archived while unwatched, and when a memo is populated for an archived chat
no one watches — a `loadHistory` completing after its attach was cancelled
before the subscription registered must not leave an untimed memo. The
timer's deadline is the calculable eligible-idle time, ten minutes from the
moment the chat last became unwatched-and-archived (or the memo
population), and the fire re-checks table L rather than trusting the
deadline. It cancels the timer on watch, restore, and
kill. When the timer fires, it re-checks table
L. On release it deletes the
memo, `liveEvents`, and `retryableHistory`
together.

Release is conservative, never best-effort over data: a memo is eligible
only when exact replay is provably safe — the archived chat has no driver,
no load in flight, an empty `liveEvents`, and no retryable Codex mark. The
policy notice and other driver events an archived stop emits reach
`liveEvents` without being written to the SDK transcript, and a
never-started session replays empty, so live-only entries would be lost; a
retryable memo exists because its last replay failed. Such a memo is kept
whole — its heap cost remains, and this change invents no new durable
storage. The proposal and delta state the eligibility limit rather than
promising every archived memo is releasable.

After a release, the replayed transcript carries a new `historyEpoch`, so
a held client's resume falls back to a full snapshot (R2, R10) — even
where the replay kept every id, the stale epoch decides. Search
already reads an unloaded chat by transient replay (`searchableEvents`), so
it keeps working. Codex chats replay from the rollout, and the same rule
applies to them.

### D5 — Large tool outputs stop stalling a live connection

The 2026-11-05 incident (Context) needed three faults at once: one message
too large for the link, a heartbeat that cannot see a message still
arriving, and a server that drops messages behind a full buffer. Each
gets its own rule, so that no one of them can recreate the loop alone. D5
does not make every WebSocket message fast enough for every deadline on
every link; the limits it leaves are listed under Risks.

**D5a — Tool outputs are elided on delivery, measured as sent.** A pure
`elideToolOutput(event)` (`src/server/chat/toolOutputElision.ts`) measures a
`tool_result`'s output as it is sent: the UTF-8 length of
`JSON.stringify(output)`, the quoted and escaped string value, quotes
included. When that length exceeds `TOOL_OUTPUT_MAX_BYTES = 65_536` it
returns a copy whose output is the longest prefix, ending on a character
boundary, whose own serialized string value is at most 65,536 bytes
(inclusive), plus `outputElided: { totalBytes }`. `totalBytes` is the UTF-8
length of the whole original output before any projection (its canonical
UTF-8 encoding, below), never the serialized length. `outputElided` is set
exactly when the output changed. Any other event, or an output whose
serialized value is within the limit, is returned unchanged (the same
object), and the source object is never modified. So 65,534 ASCII
characters (65,536 serialized bytes) pass whole, 65,535 are elided, and an
output of control characters such as U+0001, which JSON writes as six bytes
each, is cut at 10,922 characters. It runs on every delivery route:

1. `getSnapshot` and `getHistoryPage`, before pricing (D1), so the budget
   sees the decorated and elided projection actually returned.
2. The live `chat-events` fan-out in `ChatConnections`, so a watching
   client gets what a later snapshot would show (one function, not a
   second rule). It is applied once at the top of `publish`, before
   batching, so both of its send sites — the batch-overflow send in
   `publish` and the scheduled `flush` — carry the elided event.

The memo, `liveEvents`, the transcript files, search (`searchableEvents`),
and the agent are untouched: elision is a delivery projection, never a
change to stored history. Nested worker transcripts (`chat-worker-transcript`,
read through `chatWorkerTranscript.ts`) are a separate `ChatEvent[]` route
whose ids are not in the parent's memo or live events; this change neither
elides nor fetches them, which matches the proposal's scope (windowing
nested worker transcripts is out of scope). Replayed rollout events are
elided by the same rule; their stored output is whatever the replay
produced. 64 KiB keeps a typical diff or log whole (the largest tool call
input in the incident window was 27 KB) while capping the 2 MB `task_get`
replies at about a thirtieth.

**D5b — A full buffer closes the connection.** `socketHandlers.ts` sets
`closeOnBackpressureLimit: true` and keeps Bun's default
`backpressureLimit` (16 MiB), named as a constant so the tests can lower
it. `ConnectionHub.send`, `broadcast`, and the coalescer's sends read
`ws.send`'s status. A `0` (dropped) logs `ws_send_dropped` with the type,
encoded length, and `getBufferedAmount()`. The close handler logs
`ws_backpressure_close` when the close followed a limit hit. Probe 1.1
records whether Bun 1.4.3 closes instead of dropping. If it still drops
the message that crossed the limit, the hub closes the socket itself on a
`0` status. The two mechanisms are independent and both ship: the option
is the primary close, and the `0`-status close is the fallback for any
message Bun drops without closing. Either way, no message is lost while
the connection stays open. Probe 1.1 runs before section 6's tests are
written, because B2's expected native behaviour depends on it. The client
already reconnects and re-attaches after any close, so nothing on the
client changes. After D5a, D5e, and D1, reaching 16 MiB takes many
messages queued on a stalled link, so the close is rare. When it happens,
it replaces silent corruption with a visible resync.

*Alternative rejected:* a per-socket application queue in the hub,
written into Bun only below a low-water mark and drained from the `drain`
handler, with `pong` placed ahead of queued bulk messages. It bounds pong
latency more tightly, but it adds a second buffer and ordering logic next
to the coalescer's terminal-first rule ("Output ordering is preserved
across message types"). D5c covers the common case.

**D5c — Any inbound message proves life.** In `useWebSocket.ts` the
heartbeat (`PONG_TIMEOUT_MS`) and resume-verification
(`VERIFY_PONG_TIMEOUT_MS`) deadlines are met by any message that
`onmessage` completes after the ping was sent, not only the matching
`pong`. One `noteInbound()` call at the top of `onmessage`, before
parsing, clears a pending pong timer and settles a pending verification as
the matching pong does today, including the early-heartbeat restart after
verification. Because it runs before parsing, a malformed payload counts
too. It acts only for the current socket: a message delivered by a socket
that has already been replaced never settles the current socket's timers.
The intervals and deadlines are unchanged. A dead socket still delivers
nothing and is still replaced. A healthy socket that is busy delivering a
snapshot is kept, because the snapshot's arrival counts. This does not
help while a single message is still arriving, since the browser only
reports whole messages: a message must arrive within the deadline on its
own (Risks).

**D5d — The full output comes over HTTP, not the WebSocket.** A new
`GET /api/chat/sessions/:sessionId/tool-output/:eventId`
(`src/server/routes/chatToolOutput.ts`) is mounted on the existing app in
`bootstrap.ts` beside `/api/chat/search`, before the static fallback. Both
ids are opaque, URL-encoded path segments, never file paths. It calls
`ChatSessionManager.getToolOutput(sessionId, eventId)`, which awaits the
manager's own `loadHistory` (a shared load: it accepts archived chats,
never starts a driver, and keeps a killed chat's replay out of its memo),
then looks the exact session and event up in memo plus live events again
after the await. A released memo replays. An unknown session, an unknown
id, a non-`tool_result` id, or a result missing after replay is `404`,
never an empty success.

A hit replies `200`, `Content-Type: text/plain; charset=utf-8`,
`Cache-Control: no-store`, with the body the output's canonical UTF-8
bytes and `Content-Length` computed from those same bytes. Canonical UTF-8
is the standard encoding of the JavaScript string (`TextEncoder`), which
writes a lone surrogate as U+FFFD. Valid text, including a leading BOM,
multi-byte characters, and control characters, therefore round-trips
byte for byte. An ill-formed string is served, counted in `totalBytes`, and
compared in that same replaced form, and no identity of raw ill-formed
code units is claimed. The route keeps the trust model of `/ws` and
`/api/chat/search` — same origin, the same listener, no route auth — and
adds no CORS, JSONP, proxying, or filesystem access. The service worker
precaches only listed static assets and excludes `/api` from its
navigation fallback (`vite.config.ts`). `no-store` keeps any cache from
retaining a body, and a test checks the route through the real app.

Because the download runs on its own HTTP request, the full output never
enters the WebSocket's message stream, so no `pong` or other message ever
waits behind it there. It still shares the link's bandwidth, and that
sharing is not bounded (Risks). A 2 MB output takes about 40 s at
50 KB/s in one request. There is no `chat-tool-output` WebSocket message,
and nothing is added to `CHAT_CONNECTION_TYPES`.

The client's tool result view marks an elided output ("Output shortened —
N KB total"). Expanding starts one request with its own `AbortController`
and shows that the full output is loading. The client reads the body as
bytes and decodes it with `TextDecoder('utf-8', { ignoreBOM: true })`, so a
leading U+FEFF is kept. It replaces the preview only when the whole body
has arrived, its byte length equals `totalBytes`, and this request is
still the current one for that expansion, session, and event. Collapse,
re-expand, chat switch, detach, and unmount abort the request, and a late
completion of an aborted or superseded request is discarded, never
adopted. A `404` shows "Full output unavailable". A network error or a
length mismatch keeps the preview with "Retry", which starts a new
request. A WebSocket close and reconnect is not a detach (attachment holds
survive socket drops, `chatAttachment.ts`), so a download in progress for
the same session and event continues across it, and a successful resume
neither restarts nor duplicates it. The manager's shared history load is
never cancelled by a client abort, and an abort does not promise that the
server stops work or closes the TCP connection.

**D5e — Live batches are capped as sent.** `ChatConnections.publish`
measures each pending `chat-events` batch as the UTF-8 length of the whole
message as sent: `JSON.stringify({ type: 'chat-events', sessionId, events })`,
envelope, session id, and separators included. Before an event joins a
batch, `publish` sends the batch on its own if adding the event would take
the message over `CHAT_EVENTS_MAX_BYTES = 262_144` (256 KiB). `flush` sends
only batches built under that rule. The existing 128-event cap and the
turn-boundary split keep their order and meaning; the byte cap only adds
split points. Every event is sent exactly once, in order. A single event
that is over the cap on its own is sent alone as a one-event batch. After
D5a that can only be a non-`tool_result` event with a large field (E5),
which is never elided. 256 KiB takes about 5.2 s at 50 KB/s, which meets
the 10 s heartbeat but not the 1.5 s resume verification (Risks).

## Acceptance oracles

All tables are committed verbatim as table-driven tests next to the code
they cover. `*` means don't-care.

### W — window cut (`historyWindow`, budget 500 events / 512 KiB)

| id | Input | Delivered |
|---|---|---|
| W1 | 24 h holds 3 turns, 200 events, 100 KiB | all 3 turns, `hasOlder` per older units |
| W2 | 24 h holds 9 turns, 2,300 events; newest 4 turns total 480 events | exactly the newest 4 turns; `hasOlder` true |
| W3 | newest unit alone: 2,700 events with quiet points every 10 events, each part within the byte budget (C1 premise; selection empty) | exactly 500 events of its newest-first quiet parts; starts at a quiet point; `hasOlder` true |
| W4 | in the oversized-newest-unit part walk, a newer part is already selected and the next older part holds a `tool_call` and its `tool_result` and would overflow | that older part is left to older history whole and the walk stops; the cut never separates the call from its result; both delivered or both absent (the oversized newest part itself is W8's atomic case, never excluded here) |
| W5 | in the part walk, a newer part is already selected and the next older part is one continuing assistant message that would overflow | that older part is left to older history whole and the walk stops; the cut never falls inside the message |
| W6 | newest unit alone exceeds the budget; its newest part is a `tool_call` with a 600 KiB `tool_result` | the result delivered elided (D5a: its serialized output value at most 65,536 bytes) and priced at that elided, decorated size; the part fits, so the walk continues under both caps and the window stays within 512 KiB |
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

Unreachable: a part with zero events (every part starts at an event), a
`startId` inside a merged entry (W5 forbids the cut), a part holding a
`tool_result` without its owning call (part 1's quiet-point rule puts a
call and its result in the same part), and a part walk entered while any
unit is selected (the split branch requires an empty selection).

### R — server resume decision (`resumeDecision`)

`S` is the recomputed window start index. `h₀` and `h₁` are the held start
and newest indexes in memo + live.

| id | `held` | epoch | `h₁` found | `h₀` found | relation | Result |
|---|---|---|---|---|---|---|
| R1 | absent | * | * | * | * | full snapshot |
| R2 | present | mismatched or absent | * | * | * | full snapshot |
| R3 | present | current | no | * | * | full snapshot |
| R4 | present | current | yes | no | * | full snapshot |
| R5 | present | current | yes | yes | `S < h₀` | full snapshot |
| R6 | present | current | yes | yes | `S > h₁ + 1` | full snapshot |
| R7 | present | current | yes | yes | `h₀ ≤ S ≤ h₁ + 1` | resume: events after `h₁`, `historyStartId` = event at `S` |
| R8 | present | current | yes | yes | R7 and nothing after `h₁` | resume with `events: []` |
| R9 | present, expanded | current | yes | yes | window computed with `fromId = held.startId` | R7 with `S = h₀` |
| R10 | interior rewrite: memo replaced by release/restart, the replay rewrites an interior row, both held endpoint ids survive | stale | yes | yes | * | full snapshot (R2's decisive case) |

Unreachable: `h₁ < h₀` (the client's newest is never older than its start;
listed defensively as R5 by construction), and an epoch match over a
rewritten range (the epoch changes whenever the memo is replaced, so R10's
ids can only co-occur with a stale epoch).

### A — client resume apply (`applyResume`)

| id | `afterId` = client newest | new start in `rawOrder` after fold | Result |
|---|---|---|---|
| A1 | yes | yes | append delta, trim before start, drop trimmed ids from `seen`, set `throughSequence` after the fold |
| A2 | yes | no | discard; re-attach plain |
| A3 | no | * | discard; re-attach plain |
| A4 | `resume` absent | * | replace transcript (today's snapshot) |

A mismatched held transcript resolves either in table R (the server sends
a full snapshot, the client takes A4) or here (the server resumed, the
client discards at A2/A3); which site fires depends on where the mismatch
appears first, and both leave the transcript equal to a full attach.

### C — compression (`compressFor` plus negotiation)

| id | mode | negotiated | type | length | Sent |
|---|---|---|---|---|---|
| C1 | off | * | * | * | uncompressed; extension not offered |
| C2 | large/all | no | * | * | uncompressed |
| C3 | all | yes | * | * | compressed |
| C4 | large | yes | terminal type | * | uncompressed |
| C5 | large | yes | non-terminal | ≥ 16,384 encoded bytes | compressed |
| C6 | large | yes | non-terminal | < 16,384 encoded bytes (class: empty, 1 B, 2 KiB, 16,383) | uncompressed |

C5/C6 measure the full serialized message in encoded UTF-8 bytes; C6's
class is the whole small-message range with 16,383/16,384 as the boundary
representatives. Mode parsing: `false` → off, `true` → all, `""`, `TRUE`,
`1`, or unset →
large (rows C7–C10).

### L — memo release (timer fire and re-check)

| id | archived | watched | driver present | load in flight | `liveEvents` | retryable | idle ≥ 10 min | Result |
|---|---|---|---|---|---|---|---|---|
| L1 | no | * | * | * | * | * | * | keep; no timer |
| L2 | yes | yes | * | * | * | * | * | keep; timer cancelled |
| L3 | yes | no | yes | * | * | * | * | keep; re-armed |
| L4 | yes | no | no | yes | * | * | * | keep; re-armed |
| L5 | yes | no | no | no | * | * | no | keep (timer not due) |
| L6 | yes | no | no | no | empty | no | yes | release memo, live events, retryable mark |
| L7 | yes | no | no | no | non-empty (live-only entries) | no | yes | keep; unreplayable overlay |
| L8 | yes | no | no | no | * | yes | yes | keep; retryable memo |
| L9 | yes | no | no | no | empty | no | timer armed at memo population (attach cancelled before subscription) | eligible; its fire re-enters the table by deadline |

A driver on an archived chat exists only while archive's stop is in
progress (L3).

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
| E9 | search for text beyond the preview of an elided result | found (search reads stored history) |
| E10 | `GET` the route through the real app and manager for a 2 MB ASCII result, the E8 fixtures, a multi-byte and control-character fixture, and the E7 U+0001 fixture | `200`; `Content-Type: text/plain; charset=utf-8`; `Cache-Control: no-store`; `Content-Length` = body length = `totalBytes`; body byte-identical to the canonical UTF-8 of the stored output |
| E11 | `GET` for an unknown session, an unknown event id, a non-`tool_result` id, and a result absent after replay | `404` in every case; never `200` with an empty body |
| E12 | `GET` for a result of an archived chat whose memo was released | the history replays; `200` with the E10 body; afterwards memo, `liveEvents`, and the search result for that chat hold the full, unprojected output |
| E13 | client expansion over a fake `fetch`: a body with a leading U+FEFF; a body one byte short of `totalBytes`; a `404`; a network error | first: full text shown with the U+FEFF kept; second and fourth: preview kept with "Retry"; third: preview kept with "Full output unavailable" |
| E14 | collapse and re-expand while the first request is pending, and the first then completes; separately, chat switch, detach, and unmount while pending | the first request's signal is aborted and its late body is discarded; only the second request's body is adopted; switch, detach, and unmount abort with no later state update |
| E15 | the WebSocket closes and reconnects, and a resume verification succeeds, while a download is pending for the same session and event | the same request continues; no second request is made; its body is adopted on completion |
| E16 | eight `tool_result`s of 2,000,000 × U+0001 in one turn, published (a) within one flush tick and (b) after 125 small events, so the 128-event overflow send also fires | every `chat-events` message as sent (UTF-8 of the whole message JSON) is at most 262,144 bytes; every event is delivered exactly once, in order, across overflow and flush sends; each delivered result equals E7's elided event; the route still serves the full 2,000,000-byte body |
| E17 | one `tool_call` event whose input is 2 MB, between two small events of the same turn | it is sent alone as a one-event batch; the neighbours are delivered in order before and after it |
| E18 | events of two turns, and 130 small events of one turn, all under the byte cap | batches split at the turn boundary and at 128 events exactly as before D5e |

### B — backpressure (`socketHandlers`, `ConnectionHub`)

| # | Buffered state | Expected |
|---|---|---|
| B1 | production handler options | `closeOnBackpressureLimit: true`, `backpressureLimit` = the named 16 MiB constant |
| B2 | test limit lowered; a stalled raw client; messages sent past the limit | the socket closes; `ws_backpressure_close` logged with the buffered amount; no message accepted after the limit is reported delivered |
| B3 | `ws.send` returns `0` on any route (a fake socket whose `send` returns `0` and stays open, independent of Bun's option) | `ws_send_dropped` logged with type and encoded length; the hub closes the socket itself |
| B4 | buffer stays below the limit | every message delivered in order; socket open |
| B5 | one socket closed at the limit | a second socket on the same server receives a broadcast sent afterwards |

### H — heartbeat liveness (`useWebSocket`, fake timers)

| # | After a ping | Expected |
|---|---|---|
| H1 | nothing arrives for `PONG_TIMEOUT_MS` | socket destroyed; reconnect scheduled (`ws_pong_timeout`) |
| H2 | a non-`pong` message arrives at 9 s; the pong never comes | no reconnect at 10 s; the next heartbeat pings again |
| H3 | the matching `pong` arrives | timer cleared (unchanged behaviour) |
| H4 | a `pong` with a stale `seq` arrives and nothing else | counts as an inbound message: timer cleared (any message proves life) |
| H5 | resume verification; a `sessions` message arrives within `VERIFY_PONG_TIMEOUT_MS` | verified; early heartbeat started; no force reconnect |
| H6 | resume verification; nothing arrives | force reconnect (unchanged) |
| H7 | a malformed (non-JSON) payload arrives at 9 s; the pong never comes | counts as inbound: no reconnect at 10 s |
| H8 | the socket was replaced; the old socket delivers a message while the new socket's ping is pending and nothing arrives on the new one | the new socket's timer is not cleared: it is destroyed at its deadline |

### Properties

- **P1 — budget and integrity (budgeted modes only).** For any generated
  history, in attach and page modes (never the widened `fromId`/`throughId`
  exemptions), the delivered window follows the precedence: whole units
  newest-first up to the first overflow stop; only an empty selection on
  an oversized newest unit walks that unit's quiet parts, with at most the
  single atomic newest part; the window stays within both limits unless
  that one atomic part stands, the encoded-byte measure counted over the
  complete delivered suffix as actually projected — the workspaceContext
  decoration and D5a's elision included, never a raw-only estimate, with
  metadata-bearing cases joining the same 500-case generator — every
  delivered `tool_result` output's serialized string value (quotes
  included) is at most 65,536 bytes, carrying `outputElided` exactly when
  the delivered output differs from the stored one, with `totalBytes` the
  stored output's canonical UTF-8 length, and every
  delivered `tool_result` whose call
  exists in history has that call in the window and vice versa; a call
  with no recorded result (cancelled or still unfinished) is valid
  history, kept as it stands and never fabricated a result. The generator
  is a seeded LCG over turns of
  1–60 events mixing text runs, tool call/result pairs with sizes up to
  700 KiB, unmatched cancelled calls, and gaps of 0–50 h. The seam is
  `historyWindow`. Seed `0x5eed`, 500 cases.
- **P2 — resume equals full attach.** For a generated history, a held
  window, and appended live events (0–200), folding the full snapshot gives
  the same entries (ids, kinds, text) as `applyResume(held transcript,
  resume snapshot)` whenever R chose resume, and R never chooses resume
  over a replaced memo — an interior rewrite with surviving endpoints (R10)
  always falls back to the full snapshot. The generator is the same as
  P1 plus an append count. The seams are `resumeDecision` and
  `applyChatEvents`/`applyResume`. Seed `0x5eed`, 500 cases.
- **P3 — pages tile history.** Repeated `beforeId` pages from the recent
  window down to `hasOlder: false` concatenate to the whole history in
  order with no duplicates. The generator and seed are the same as P1, with
  300 cases.

### Production wiring (hazard M1)

- **OW1.** A test runs `ChatConnections` over a real `ChatSessionManager`
  with a fixture transcript. A second attach with `held` receives a
  `resume` snapshot. Mutant: the attach handler drops `held`. OW1 also
  runs the production budget checks through the real manager: a snapshot
  and a `getHistoryPage` over the W17 fixture with persisted workspace
  contexts must return events whose `UTF-8(JSON.stringify(...))` is at
  most 512 KiB, with the exact selected raw ids, full metadata, and the
  actual `hasOlder` — held/resume and the plain reconnect lower-bound
  controls unchanged. The planned counterfactual mutant moves the
  workspaceContext attachment after raw-only pricing; these
  response-byte and selection assertions must detect it, not the test
  setup.
- **OW2.** A real Bun server built by the production `socketHandlers` and
  `ConnectionHub` is reached by a raw TCP client that negotiates
  permessage-deflate. Two observation layers, per physical route (a
  broadcast chat message, route 1; a direct send to a socket without a
  coalescer, route 2; an ordered non-terminal coalescer message, route 3;
  a 64 KiB terminal flush, route 4). **Call boundary:** the route's `send`
  calls are captured at the production handlers, and every call carries an
  explicitly present second argument — `compress`, zero-based index 1 of
  `ServerWebSocket.send(data, compress?)` — equal to the required boolean
  for that route, mode, and input; an absent or `undefined` argument fails
  even when Bun's default would send identical wire bits, and that default
  stays unknown until probe 1.1. **Wire:** the first three routes' large
  messages arrive with RSV1 set, the terminal flush without it, and a
  small (< 16,384 encoded bytes) non-terminal message on any route arrives
  uncompressed. Mutant: omitting `compressFor` on any one named route
  fails that route's call-boundary observation; the wire layer never
  substitutes for it, because an omitted argument can match the wire while
  staying absent.
- **OW3.** Through `ChatConnections` + manager with a fake clock, an
  archived chat detached for 10 minutes is observably released: the memo
  is gone, and the next attach replays the same entries under a new
  `historyEpoch` — replay, not memory, answered it — so skipped eviction
  is distinguished from successful eviction. Mutant: `noteWatched` is
  never called. A cancelled attach — one whose `loadHistory` completes
  after the client detached — leaves the populated memo timed: the same
  fake clock releases it with no further subscriber change, observed the
  same way (memo gone, replay, new epoch). Mutant: the population path
  never arms the timer.
- **OW4.** Through the real app built by `bootstrap.ts` and `ChatConnections`
  over a real manager whose driver emits a `tool_result` of 2,000,000 ×
  U+0001 live: the subscribed client receives the elided event (E7) over
  `chat-events` on both live send sites (the batch-overflow send in
  `publish` and the scheduled `flush`); a fresh attach receives the same
  elided event in its snapshot; and `GET` on the route returns the E10
  headers and the full 2,000,000-byte body. No WebSocket message to any
  client carries more of that output than the preview. Mutants: elision
  applied only in `getSnapshot` (the live route ships the whole output);
  elision written back into `liveEvents` (the body is the preview and its
  length differs from `totalBytes`); a WebSocket tool-output transport
  reintroduced in any form (the no-output-frames assertion fails,
  whatever the timing); the route mounted after the static fallback (the
  reply is not `text/plain`).
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
- **OW6.** A browser-level check (Playwright, slow e2e tier) through the
  real app, its WebSocket, and its HTTP route, with pinned and measured
  transfer conditions. Every timing claim here is planned, not yet run.
  - *Link.* The browser reaches the e2e server through a pacing TCP proxy
    in the test. Server-to-browser bytes share one global budget of
    50,000 bytes/s across all ready connections: every 50 ms the proxy
    sends at most 2,500 bytes, taken round-robin from the connections
    that have bytes waiting (after the page's assets load, one WebSocket
    and at most one HTTP download). The proxy adds a fixed 1,000 ms round
    trip (500 ms each way). It records every slice with its connection
    and time. The server runs with `AGENTBOARD_WS_DEFLATE=false`, so wire
    bytes equal the serialized message.
  - *Measured bounds.* From the proxy's record, the test asserts that the
    measured global rate is at most 60,000 bytes/s, that a ready WebSocket
    never waited more than 100 ms for its next slice, and that each
    verification `pong` reached the browser within 1,200 ms of its `ping`
    leaving it. If the proxy cannot meet these bounds the test fails as an
    oracle gap, naming the bound; it never passes or fails on the product
    while a fixture bound is broken. Stock timers and workers are never
    changed for the test.
  - *Fixture.* A chat whose stored history holds 10 turns, each one tool
    call and its result. The newest turn's output is 2,000,000 bytes of
    base64 text from a seeded LCG (seed `0x5eed`, incompressible in
    practice), so the newest turn is one atomic 2 MB call/result part.
    The second-newest turn's output is 2,000,000 × U+0001. The other
    eight are base64 like the newest.
  - *Snapshot timing.* The chat is selected 1 s after the socket opens, so
    the first heartbeat ping (20 s after open) and its deadline (30 s)
    fall while an unbounded transfer of the newest part (about 40 s at
    the pinned rate) would still be arriving. The test observes 45 s.
  - *Payload assertions* (on received frames, separate from timing): every
    delivered `tool_result` output's serialized value is at most 65,536
    bytes and carries `outputElided` with `totalBytes` 2,000,000; the
    snapshot frame is at most 600 KiB once D1 has landed (at most 700 KiB
    at the section-6 checkpoint, where today's 24 h window delivers all
    ten elided turns, about 13 s at the pinned rate). Without D1 the
    snapshot mutant ships about 20 MB instead of 2 MB; it is killed either
    way.
  - *Liveness assertions:* the transcript renders, `ws_pong_timeout` is
    never logged, and the socket is not replaced during the 45 s.
  - *Expansion with resume.* After that, the second-newest result
    (U+0001) is expanded. Its 2,000,000-byte body arrives over HTTP in
    about 40 s. One second after the body's first byte passes the proxy,
    the page is hidden and made visible again, which runs resume
    verification. Expected: no `ws_verify_timeout` or `ws_pong_timeout`
    is logged, the socket is not replaced, exactly one HTTP request was
    made, and the full text shown equals the stored output. The test
    observes until the body has fully arrived plus 5 s.

  Mutants: elision disabled on the snapshot route (D1 then delivers the
  newest 2 MB part whole, which outlasts the heartbeat deadline: the
  timeout and re-attach are seen); and the specific 5f design, the full
  output fetched over the WebSocket in chunks of 65,536 decoded UTF-8
  bytes, one in flight. With the U+0001 output each such chunk is 393,216
  serialized bytes, about 7.9 s on the link; the resume falls one second
  into a chunk, its verification `pong` waits behind the rest, and
  `ws_verify_timeout` and a replaced socket are seen. Arbitrarily small
  serialized WebSocket chunks are a different design and not this mutant;
  OW4's no-output-frames assertion kills any WebSocket transport
  regardless of timing. D5c's wiring is killed at unit level instead: the
  H rows drive the production `useWebSocket` class over a fake socket,
  because a bounded snapshot arrives within the deadline with or without
  D5c.

## Risks / Trade-offs

- **Remount cost stays.** Resume removes the transfer, not the React mount
  on reselect. D1 bounds that mount at 500 events. Keeping transcripts
  mounted was rejected for memory reasons.
- **Compression CPU.** Deflating a 2.9 MB snapshot costs about 22 ms on the
  server thread. After D1 a snapshot is at most about 512 KiB, which costs
  a few milliseconds. Terminal frames never pay it.
- **Merge predicate drift.** If the client's merge rule changes without the
  shared predicate, a cut could split an entry. This is mitigated by
  `continuesEntry` being the only definition, and by W5 and P2.
- **Release then restore.** A restore immediately after a release pays one
  replay. This is accepted; it is the same cost as the first open after a
  restart.
- **Some archived memos stay resident.** A memo with live-only entries or a
  retryable mark is never released under D4's conservative eligibility; its
  heap cost remains until restore or kill. Releasing and losing the
  unreplayable entries was rejected, and no new durable storage is added.
- **Rename coordination.** `rename-agentboard-to-kawai` renames the
  variable. Whichever change archives second rebases its delta.
- **A copied or rendered result is the preview until expanded.** Copying
  an elided tool result (copy-chat-message-markdown) copies the 64 KiB
  preview plus its shortened marker, not the full output. Expanding first
  fetches it. This is accepted: the full text is one click away, and
  shipping it eagerly is the fault being fixed.
- **A backpressure close drops in-flight terminal state.** A terminal
  attached on the closed socket re-attaches through the normal reconnect
  path. This is accepted: before D5b the same condition lost messages
  silently, including terminal output.
- **One message can still be slow.** D5c cannot see a message still
  arriving. A snapshot near the 512 KiB budget on a link slower than about
  50 KB/s uncompressed (about 13 KB/s with D3's compression) can still
  outlast the 10 s deadline. Raising `PONG_TIMEOUT_MS` was rejected: it
  delays detection of truly dead sockets on every link to cover a case D1,
  D3, and D5a make unlikely.
- **Resume verification still fails behind a large message.** Resume
  verification allows 1.5 s. With a 1 s round trip that leaves about
  0.5 s, about 25 KB at 50 KB/s, so any WebSocket message larger than that
  still arriving when the page becomes visible (a snapshot or page up to
  512 KiB, a live batch up to 256 KiB, a lone E5 event) still causes a
  reconnect, as it does before this change. D5 does not worsen it, and it
  keeps both deadlines unchanged: falling back to the 10 s deadline after
  a failed verification, or extending verification while a reply is
  pending, would slow the detection of a socket that died during sleep,
  and neither is chosen. The limit is tracked separately
  (task-b9d8c232) for evidence from D5's first production path.
- **The HTTP download shares the link.** D5d keeps the full output out of
  the WebSocket's message stream, so no message waits behind it there. It
  does not reserve bandwidth: on a slow or congested link, or a tunnel
  that carries both connections, WebSocket messages can still be delayed
  by the download's bytes in shared queues, and that delay is not
  bounded here. OW6 measures it under a pinned fair proxy only.
- **A lone large non-result event is sent whole.** Only `tool_result`
  output is elided (E5). A single event with a very large tool call input
  or text is sent alone as one message (D5e) and can still exceed either
  deadline on a slow link. The largest tool call input in the incident
  window was 27 KB.
- **A full output expands slowly on a slow link.** A 2 MB output takes
  about 40 s at 50 KB/s over HTTP. This is accepted: the preview stays
  usable meanwhile, and the WebSocket keeps working.
- **Ill-formed text is shown as replaced.** An output holding a lone
  surrogate is served, counted, and shown with U+FFFD in its place
  (canonical UTF-8); its raw ill-formed code units are not preserved.
- **Nested worker transcripts are not elided.** A worker transcript with a
  huge tool output still ships whole when the user opens it. This is left
  for the worker-transcript windowing that the proposal puts out of scope.

## Migration Plan

All additions are additive, and no schema or stored data changes. Mixed
client and server versions fall back to full snapshots. The compression
default changes for existing installs, and `AGENTBOARD_WS_DEFLATE=false`
restores today's behaviour. `outputElided` and the full-output route are
additive. An older client shows the elided preview without the fetch,
and an older server never elides. Rollback means reverting the change.

## Open Questions

None blocking. Probe 1.1 settles Bun's `compress` default before D3's
tests are written, and whether Bun closes or drops at
`closeOnBackpressureLimit` before D5b's tests are written.
