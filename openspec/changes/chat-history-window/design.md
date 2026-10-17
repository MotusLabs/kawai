# Design

## Context

Today `chat-attach` awaits `ChatSessionManager.loadHistory` (an async replay of
the whole SDK transcript into the `snapshotHistory` memo, done once per session
per server run), then `getSnapshot` sends `memo + liveEvents` in one
`chat-snapshot`. The client folds every event with `applyChatEvents` into
`ChatTranscript.events` and `ChatMessages` renders all rows. A lead running for
days has a transcript of tens to hundreds of MB, and `liveEvents` alone can
span days when the server has run that long.

Observed facts the design relies on:

- Replayed events carry stable ids (`hist-<line uuid>`, or block ids derived
  from it) and replay emits `turn_started` per user/peer/agent-started turn
  (`hist-turn-N`); live events carry their own ids and `sequence > 0`.
- The memo is append-free and only dropped by kill, so `memo + live` is a
  stable, growing list during a server run; ids survive a restart because
  they come from the transcript.
- `at` may be empty (undated replay records); it is read through `validTime`.
- `applyChatEvents` skips any event whose `sequence <= throughSequence`, so a
  page containing older *live* events must not be folded into the current
  transcript state directly.

## Goals / Non-Goals

**Goals:**
- Attach payload and first render proportional to the last day of work.
- Older history on demand, a day at a time, with stable scroll position.
- Nothing disappears from a shown transcript; reconnects keep what was
  shown; reopening moves the window forward unless the user loaded more.
- Search reveal reaches old entries.

**Non-Goals:**
- Avoiding the one-time full replay of the transcript on the server. The memo
  stays whole: search and paging read it, and a tail-reading replay is a
  separate optimization (follow-up if first-open latency still matters).
- List virtualization in the client.
- A configurable window length. 24 hours is a constant (`HISTORY_WINDOW_MS`).
- Windowing nested worker transcripts (`chat-worker-transcript`).

## Decisions

### D1 — One pure window function over `memo + live`

New `src/server/chat/historyWindow.ts`, SDK-free and pure:

```ts
historyWindow(events, { endAt?: string|undefined, beforeId?, throughId?, fromId? })
  → { events: ChatEvent[]; startId: string | null; hasOlder: boolean }
```

- **Cut points** are the indices of `turn_started` events, plus index 0. An
  event without a turn (session notice, approval-policy notice) belongs to the
  unit it sits in; units are therefore contiguous slices and a cut never
  separates a tool call from its result or splits an assistant message.
- **Unit time** is the first `validTime` in the unit; an undated unit takes
  the time of the nearest earlier dated unit (so it never jumps the window).
- **Anchor**: for attach, the newest `validTime` of any event; for a page, the
  time of the unit at `beforeId`. Cutoff = anchor − 24 h. The window starts at
  the earliest cut point whose unit time is ≥ cutoff, but never later than the
  last unit before the anchor (the "at least one turn" rule). No dated event
  at all → the whole list (nothing to measure against).
- `fromId` (reconnect) starts the window at that event's unit instead, when it
  is found and older than the default start; `throughId` (search) extends a
  page back to the unit containing that id.
- `hasOlder` = the window starts after index 0.

Alternative considered: windowing by event count or bytes. Rejected: the user
thinks in days ("show the last 24h"), and a count still cuts turns arbitrarily.
Anchoring on the newest event rather than wall-clock "now" is chosen so a chat
idle for days opens on its last work instead of empty; for an active lead the
two are the same.

### D2 — Wire contract (additive)

- `chat-attach` gains optional `historyFrom?: string` (the oldest event id the
  client holds).
- `chat-snapshot` gains `historyHasOlder: boolean` (absent from older servers
  = false). `events` becomes the window; `throughSequence`, pending requests,
  activity, rosters, notices are unchanged and independent of the window.
- New client message `chat-history-page { sessionId, beforeId, throughId? }`
  and server reply `chat-history-page { sessionId, beforeId, events,
  hasOlder, stale? }`. `stale: true` with no events means `beforeId` is not in
  the server's list (killed and recreated memo, unexpected id drift); the
  client re-attaches without `historyFrom`.
- Add `chat-history-page` to `CHAT_CONNECTION_TYPES`; it awaits
  `loadHistory` like attach, needs an existing subscription, and never starts
  an agent (archived chats page too).

Older clients ignore `historyHasOlder` and see the recent window only —
acceptable degradation, documented. Alternative: a REST endpoint for pages.
Rejected: ordering against the subscription and the `teamPath`-free session
addressing already live on the chat WebSocket.

### D3 — Client store: prepend by refolding the page alone

`ChatTranscript` gains `historyHasOlder`, `historyLoading`, and the server's
window `startId`. A page reply folds `page.events` with
`applyChatEvents(emptyTranscript(), page.events)` (so older live events are
not dropped by the `throughSequence` filter), filters out ids already in
`seen`, then sets `events = [...pageFolded, ...events]` and unions `seen`.
Because cuts fall on turn boundaries, no assistant-text merge crosses the
seam.

The window is not sliding (spec: "The history window moves only when a chat
is opened"): between attaches the client only appends, so nothing leaves the
top of a shown transcript. Whether an attach sends `historyFrom` decides when
the window moves:

- **Reconnect** — `ChatView`'s attach effect re-runs for the same
  `session.id` because `connected`/`connectionEpoch` changed. A ref in the
  view remembers the session it last attached; on a re-run for the same id it
  sends `historyFrom = historyStartId`, so the snapshot covers the same span
  (plus whatever arrived meanwhile).
- **Open** — the effect runs for a new `session.id` (selection or mount). It
  sends `historyFrom` only when the session's `historyExpanded` flag is set;
  otherwise the server recomputes the recent window at that moment, so a lead
  chat left open for days reopens at one day, not at everything it gathered.
- `historyExpanded` is set by a successful page reply (load-earlier or a
  search reveal), lives in `chatStore` memory only, and is never sent to the
  server. Like the transcript itself it is gone after a page reload, so a
  reload always starts at the recent window. Kill discards it with the
  session's other client state.

Alternative considered: a true sliding window that trims the top while a chat
is shown. Rejected: entries vanishing under the reader, and the scroll
position jumping, are worse than the memory a long-shown chat holds.

### D4 — Load-earlier control and scroll anchoring

`ChatMessages` renders a top row inside `.chat-transcript`: **Load earlier
messages** button (disabled while disconnected or loading; "Loading…" while
in flight) or a "Beginning of conversation" marker when `historyHasOlder` is
false and the session has any history. Prepending preserves position by
recording the first visible row's `data-anchor-id` and its offset before the
update and restoring `scrollTop` in a layout effect after it (the anchor
attributes already exist for search reveal). No automatic load on scroll —
explicit click, as requested.

### D5 — Search reveal

`useRevealRow` currently gives up when the anchor is absent. With this
change: if the anchor id is not rendered and `historyHasOlder` is true, it
sends one `chat-history-page { beforeId: startId, throughId: <anchor id> }`.
`throughId` takes a search anchor as-is: an event id, or `tool:<callId>`,
which the window function resolves to the event with that `toolCallId` (the
anchors `sessionSearch.ts` emits). It then resolves the reveal after
the page lands; if the entry still is not found, it falls back to today's
"open at the usual position" behavior. One request per reveal, no loop.

## Risks / Trade-offs

- [First open of a huge transcript still pays the full replay] → Unchanged
  cost, now visible as the only remaining one; tail-reading replay is the
  follow-up if needed. Subsequent opens hit the memo and send a day's events.
- [A single day can still be large for a busy lead] → Acceptable: it is the
  requested window; virtualization is a separate change.
- [Reconnect after a server restart: `historyFrom` id from a live event no
  longer exists] → Window falls back to the default; the client accepts the
  snapshot as authoritative (loses its expansion once). Replayed ids are
  stable, so expansions over replayed history survive.
- [A chat kept shown for days grows in the tab again] → Accepted: it costs
  only while shown; the next open of that chat starts at one day again.
- [Undated rows near the cut] → They inherit the previous dated unit's time,
  keeping the history prefix contiguous; covered by unit tests.
- [Rosters or pending requests reference tool calls outside the window] →
  Pending requests and the live strip render independently of rows; a tool
  row's roster badge simply appears once that row is loaded.

## Migration Plan

No data migration. Server and client ship together; an old client on a new
server sees only the window (no load control), a new client on an old server
sees full history with `historyHasOlder` absent (no control). Rollback is a
revert.
