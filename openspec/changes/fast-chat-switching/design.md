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

## Goals / Non-Goals

**Goals:**

- Bound what one switch sends and renders, whatever the day's activity.
- Send nothing a reselected chat already holds, beyond the new tail.
- Shrink the large chat messages on the wire without touching terminal
  echo latency.
- Stop an archived chat from holding its replay in memory after nobody
  watches it.

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
`HISTORY_MAX_BYTES = 512 * 1024`. Bytes are the summed `JSON.stringify(event)`
lengths in UTF-16 code units, the same measure the wire uses before
compression.

1. **Parts.** Each turn unit (today's `unitsOf`) is split further into
   parts at quiet points. Event *i* (not the unit's first) starts a new part
   when two things hold. First, no `tool_call` before *i* in the unit still
   awaits its `tool_result` (matched by call id). Second, *i* does not
   continue the previous event's assistant message. Continuation is decided
   by the predicate the client fold uses to merge text into one entry, moved
   to `src/shared/chatTranscriptMerge.ts` as `continuesEntry(prev, next)`
   and imported by both sides (hazard "Several readers disagreeing on
   derived state"). The unit's first event always starts a part. A turn
   with no quiet point is one part.
2. **Walk.** Today's 24-hour rule picks the oldest unit to deliver. The
   budget is then applied backward from the newest part. Parts are added
   while the running totals stay within both limits, and the walk stops at
   the first part that would exceed either. Whole older units are added
   before any part of a unit is split. A unit is split only when it alone
   would exceed the budget, so turns stay whole whenever they fit. At least
   one part is always delivered, however large.
3. **Options.** `fromId` and `throughId` still widen the window to the unit
   holding that id. A widened window ignores the budget, because a
   reconnect must keep what was shown. `fromId` and `throughId` resolve to
   the *part* holding the id, so the widening stops at the part, not the
   unit. A page (`beforeId`) applies the same 24-hour rule and the same
   budget, walking backward from the part before the one holding
   `beforeId`, and delivers at least one part.
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

**Wire (additive).** `chat-attach` gains
`held?: { newestId: string; startId: string }`. It is sent only when the
client still holds a non-empty transcript of that chat from this page load.
`chat-snapshot` gains `resume?: { afterId: string }`. When `resume` is
present, `events` holds only the events after `afterId`, and `historyStartId`
and `historyHasOlder` describe the recomputed window. Every other field
(pending requests, activity, rosters, notices, usage, `throughSequence`) is
complete and authoritative, as today. An older server ignores `held` and
sends a full snapshot. An older client never sends `held`.

**Server decision** (`resumeDecision`, pure, in `historyWindow.ts`). The
server computes the window it would send for a plain attach. If the client
had expanded history, it uses `fromId = held.startId`, as `historyFrom`
does today. It then locates `held.newestId` and `held.startId` in memo +
live. It resumes when both are found and
`index(held.startId) ≤ index(window start) ≤ index(held.newestId) + 1`.
In that case it sends the events after `held.newestId`. Otherwise it sends a
full snapshot. Table R below is the complete rule.

**Client tracking.** The client must know what it holds in raw-event terms,
because a merged entry's id is a later raw id. `ChatTranscript` therefore
gains:

- `rawOrder`: the applied raw event ids, oldest first.
- `entryOrigin`: each entry's first raw id.

`applyChatEvents` maintains both. `held.newestId` is the last raw id, and
`held.startId` is `historyStartId`.

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
plain (table A). Because D1 never cuts inside a merged entry, the trim never
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

`perMessageDeflate` is `false` for `off` and `true` otherwise. One pure
function, `compressFor(mode, type, length)` (`src/server/ws/compression.ts`),
is passed as the `compress` argument of every `ws.send`. This covers
`ConnectionHub.send` and `ConnectionHub.broadcast` (once per message, shared
by its sockets) and the coalescer's send. The coalescer's send is a
`terminal-output` frame, or one of its ordered sends. Terminal types are
`terminal-output`, `terminal-ready`, `terminal-error`, and `terminal-attach`.
When the client did not negotiate the extension, Bun sends uncompressed
whatever the flag. Probe 1.1 confirms this, and confirms what Bun does when
`compress` is omitted under negotiation. Every send passes the flag
explicitly, so that default never matters.

*Alternatives.* Application-level gzip in a binary frame was rejected: it
would change the client's message decoding and gain nothing over the
standard extension. A per-socket option was rejected because the keystroke
echo and the snapshot share one socket.

### D4 — Archived chats release their memo after 10 idle minutes

`ChatConnections` tells the manager when a chat's subscriber count changes
between zero and non-zero, through `noteWatched(sessionId, watched)`. It
calls this from attach, detach, and connection close. The manager arms one
unref'd timer per archived chat when the chat becomes unwatched or when it
is archived while unwatched. It cancels the timer on watch, restore, and
kill. When the timer fires, it re-checks table L. On release it deletes the
memo, `liveEvents`, and `retryableHistory` together. Live events are already
in the transcript file, so the next `loadHistory` replays them as part of
the memo, with no duplicates.

After a release, the replayed ids differ from the ids live events carried,
so a held client's resume falls back to a full snapshot (R2). Search
already reads an unloaded chat by transient replay (`searchableEvents`), so
it keeps working. Codex chats replay from the rollout, and the same rule
applies to them.

## Acceptance oracles

All tables are committed verbatim as table-driven tests next to the code
they cover. `*` means don't-care.

### W — window cut (`historyWindow`, budget 500 events / 512 KiB)

| id | Input | Delivered |
|---|---|---|
| W1 | 24 h holds 3 turns, 200 events, 100 KiB | all 3 turns, `hasOlder` per older units |
| W2 | 24 h holds 9 turns, 2,300 events; newest 4 turns total 480 events | exactly the newest 4 turns; `hasOlder` true |
| W3 | newest turn 2,700 events with quiet points every 10 events | newest parts totalling ≤ 500 events; starts at a quiet point; `hasOlder` true |
| W4 | budget boundary falls between a `tool_call` and its `tool_result` | cut moves to the nearest earlier quiet point; call and result both delivered or both absent |
| W5 | budget boundary falls inside one assistant message streamed as several text events | cut moves before the message's first event |
| W6 | newest part is one `tool_result` of 600 KiB | that part alone, delivered whole |
| W7 | exactly 500 events, ≤ 512 KiB | all delivered (limit inclusive) |
| W8 | 501 events in one part, otherwise within bytes | that part whole (oversized single part) |
| W9 | turn started 25 h before newest, fits budget | whole turn or none (existing rule unchanged) |
| W10 | `fromId` names an event 1,200 events back | widened to the part holding it; budget ignored |
| W11 | `throughId` older than the budgeted start | widened to the part holding it |
| W12 | `beforeId`, the 24 h before it hold 1,500 events | ≤ 500 events ending at the part before `beforeId`'s part; `hasOlder` true |
| W13 | `beforeId`, empty 24 h before it, older turns exist | at least the next older part |
| W14 | turn with no quiet point, 900 events | that turn whole (single part) |

Unreachable: a part with zero events (every part starts at an event), and a
`startId` inside a merged entry (W5 forbids the cut).

### R — server resume decision (`resumeDecision`)

`S` is the recomputed window start index. `h₀` and `h₁` are the held start
and newest indexes in memo + live.

| id | `held` | `h₁` found | `h₀` found | relation | Result |
|---|---|---|---|---|---|
| R1 | absent | * | * | * | full snapshot |
| R2 | present | no | * | * | full snapshot |
| R3 | present | yes | no | * | full snapshot |
| R4 | present | yes | yes | `S < h₀` | full snapshot |
| R5 | present | yes | yes | `S > h₁ + 1` | full snapshot |
| R6 | present | yes | yes | `h₀ ≤ S ≤ h₁ + 1` | resume: events after `h₁`, `historyStartId` = event at `S` |
| R7 | present | yes | yes | R6 and nothing after `h₁` | resume with `events: []` |
| R8 | present (expanded) | yes | yes | window computed with `fromId = held.startId` | R6 with `S = h₀` |

Unreachable: `h₁ < h₀` (the client's newest is never older than its start;
listed defensively as R4 by construction).

### A — client resume apply (`applyResume`)

| id | `afterId` = client newest | new start in `rawOrder` after fold | Result |
|---|---|---|---|
| A1 | yes | yes | append delta, trim before start, drop trimmed ids from `seen`, set `throughSequence` after the fold |
| A2 | yes | no | discard; re-attach plain |
| A3 | no | * | discard; re-attach plain |
| A4 | `resume` absent | * | replace transcript (today's snapshot) |

### C — compression (`compressFor` plus negotiation)

| id | mode | negotiated | type | length | Sent |
|---|---|---|---|---|---|
| C1 | off | * | * | * | uncompressed; extension not offered |
| C2 | large/all | no | * | * | uncompressed |
| C3 | all | yes | * | * | compressed |
| C4 | large | yes | terminal type | * | uncompressed |
| C5 | large | yes | non-terminal | ≥ 16,384 | compressed |
| C6 | large | yes | non-terminal | 16,383 | uncompressed |

Mode parsing: `false` → off, `true` → all, `""`, `TRUE`, `1`, or unset →
large (rows C7–C10).

### L — memo release (timer fire and re-check)

| id | archived | watched | driver present | load in flight | idle ≥ 10 min | Result |
|---|---|---|---|---|---|---|
| L1 | no | * | * | * | * | keep; no timer |
| L2 | yes | yes | * | * | * | keep; timer cancelled |
| L3 | yes | no | yes | * | * | keep; re-armed |
| L4 | yes | no | no | yes | * | keep; re-armed |
| L5 | yes | no | no | no | no | keep (timer not due) |
| L6 | yes | no | no | no | yes | release memo, live events, retryable mark |

A driver on an archived chat exists only while archive's stop is in
progress (L3).

### Properties

- **P1 — budget and integrity.** For any generated history, the delivered
  window is within the budget unless it is one part, and every delivered
  `tool_result` has its `tool_call` in the window and vice versa (unless
  outside both). The generator is a seeded LCG over turns of 1–60 events
  mixing text runs, tool call/result pairs with sizes up to 700 KiB, and
  gaps of 0–50 h. The seam is `historyWindow`. Seed `0x5eed`, 500 cases.
- **P2 — resume equals full attach.** For a generated history, a held
  window, and appended live events (0–200), folding the full snapshot gives
  the same entries (ids, kinds, text) as `applyResume(held transcript,
  resume snapshot)` whenever R chose resume. The generator is the same as
  P1 plus an append count. The seams are `resumeDecision` and
  `applyChatEvents`/`applyResume`. Seed `0x5eed`, 500 cases.
- **P3 — pages tile history.** Repeated `beforeId` pages from the recent
  window down to `hasOlder: false` concatenate to the whole history in
  order with no duplicates. The generator and seed are the same as P1, with
  300 cases.

### Production wiring (hazard M1)

- **OW1.** A test runs `ChatConnections` over a real `ChatSessionManager`
  with a fixture transcript. A second attach with `held` receives a
  `resume` snapshot. Mutant: the attach handler drops `held`.
- **OW2.** A real Bun server built by the production `socketHandlers` and
  `ConnectionHub` is reached by a raw TCP client that negotiates
  permessage-deflate. A 64 KiB chat message arrives with RSV1 set, and a
  64 KiB `terminal-output` frame arrives without it. Mutant: a send path
  omits `compressFor`.
- **OW3.** Through `ChatConnections` + manager with a fake clock, an
  archived chat detached for 10 minutes has no memo, and re-attaching
  replays the same entries. Mutant: `noteWatched` is never called.

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
- **Rename coordination.** `rename-agentboard-to-kawai` renames the
  variable. Whichever change archives second rebases its delta.

## Migration Plan

All additions are additive, and no schema or stored data changes. Mixed
client and server versions fall back to full snapshots. The compression
default changes for existing installs, and `AGENTBOARD_WS_DEFLATE=false`
restores today's behaviour. Rollback means reverting the change.

## Open Questions

None blocking. Probe 1.1 settles Bun's `compress` default before D3's
tests are written.
