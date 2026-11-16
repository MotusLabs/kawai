# Design

## Context

See proposal.md (Why) for the measurements. Facts from the code that shape the approach:

- **Connecting.** `WebSocketManager` (`src/client/hooks/useWebSocket.ts`) opens a socket with a fixed
  `CONNECT_TIMEOUT_MS = 3_000`, or 8 s for the first attempt after a resume. Status becomes `connected` in
  `onopen`. Resume verification sends a ping and waits a fixed `VERIFY_PONG_TIMEOUT_MS = 1_500`. Heartbeat
  pings carry a `seq`, and the `pong` handler already matches it. The time between sending a ping and its pong
  is not recorded anywhere.
- **Session list.** `SessionRegistry.getAll()` returns tmux sessions plus every chat session, archived ones
  included. `setChatSession` and `removeChatSession` emit the whole list; `ConnectionHub.wireRegistry`
  broadcasts it as `sessions`. Archiving a chat is `applyPatch` with `archivedAt` set and `status: 'waiting'`
  (`ChatSessionManager`), so an archived chat never waits for permission. Archive/restore patches reach
  `updateSession`, while creation and boot registration use `setChatSession`.
- **Client session store.** `sessionStore.sessions` is the live list used across client hooks, stores and
  components to find sessions by id (the chat view, worker and task rows, the Team page). `workspaceView.ts`
  puts every session with `archivedAt` in `Archive`. `updateSession` only replaces a session it already holds.
  `session-removed` also drops the chat transcript and its cached snapshot, so it cannot double as "archived".
- **Search** covers unarchived chats only (`chat-session-search`), so it never needs an archived row.
- **Workspace snapshot.** `WorkspaceCoordinator` broadcasts the whole snapshot (`repositories` plus
  `generatedAt`) on every change, and `socketHandlers` sends the latest one on open. The client replaces its
  copy wholesale.
- **Static files.** `serveStatic({ root: './dist/client' })` from `hono/bun` 4.11.3 already supports
  `precompressed: true`: it looks for `.br`, `.zst` and `.gz` siblings of compressible types, in that order,
  sets `Content-Encoding` and `Vary`, and has an `onFound(path, c)` hook for headers. It matches
  `Accept-Encoding` tokens exactly, so a coding sent with parameters (`br;q=1`) is treated as not listed.
- **The socket.** One socket carries everything, and the browser hands over only whole messages. Any reply
  fetched on demand over the same socket sits in front of the pong (oracle-hazards, "An unbounded recovery
  reply under a whole-message heartbeat").

## Goals / Non-Goals

**Goals:**

- Connecting works on a link whose handshake takes up to about 8 s, and a dead socket on a fast link is still
  caught as quickly as today.
- The data sent on every connect does not grow with the number of archived chats.
- A reconnect with an unchanged workspace does not resend it.
- A first load and an update send compressed assets, and a repeat load revalidates only the app shell.

**Non-Goals:**

- Chat history, the heartbeat deadline, compressing WebSocket messages, and backpressure.
  `fast-chat-switching` owns all of these, and nothing here depends on it landing first.
- Keeping state across page reloads (IndexedDB caches). A reload still receives the full connect messages, now
  without archived chats.
- Changing `GET /api/sessions`, which still returns every session.

## Decisions

### D1. The connect timeout escalates, and learns from the last handshake

`WebSocketManager` keeps `nextConnectTimeoutMs`, starting at 3,000:

- On a connect timeout: `next = min(2 * next, 24_000)`.
- On `onopen`: `handshake = now - lastConnectTs`, and `next = clamp(3 * handshake, 3_000, 24_000)`.
- An attempt waits `max(next, RESUME_CONNECT_TIMEOUT_MS)` when it is the first attempt after a resume,
  otherwise `next`.

Other errors (`onerror`/`onclose` before open) leave `next` unchanged. Only a timeout means the link was too
slow for the timeout, and a refused connection says nothing about speed. The value lives only in memory, so a
reload starts again at 3 s.

The existing reconnect backoff (`min(1000 * 2^(n-1), 30_000)` between attempts) and the stall cooldown stay as
they are. They space attempts out; this value bounds how long one attempt may take.

*Alternatives.* A fixed longer timeout (for example 10 s) would slow down catching a zombie socket after an
iOS resume, which is the reason the 3 s value exists. Measuring the round trip with a preflight HTTP request
would cost a round trip on every connect.

### D2. Resume verification uses a smoothed round trip

Each heartbeat ping records when it was sent. When its matching `pong` arrives, the client updates `srtt` (an
exponentially weighted average with weight 1/8, seeded by the first sample, as in TCP). `verifyDeadline =
clamp(3 * srtt, 1_500, 8_000)`, or 1,500 before any sample exists. A verification ping is not used as a
sample, because it is sent right after a resume and its delay measures the resume, not the link.

A pong delayed behind queued downstream data makes the sample larger than the true round trip. That errs
toward waiting longer, and the 8 s cap bounds it. The estimate is kept across reconnects of one page.

`fast-chat-switching` changes what counts as an answer during verification (any inbound message). This design
changes only how long the client waits. The two compose without conflict.

### D3. Archived chats leave the session list; one message per lifecycle change

Server:

- `SessionRegistry` gains `getLive()` (tmux sessions plus unarchived chat sessions) and `archivedChatCount()`.
  The `sessions` event, the connect message, and the broadcast use `getLive()`. `getAll()` keeps its meaning
  for `GET /api/sessions` and server-side callers.
- Both `setChatSession(session)` and the chat branch of `updateSession` compare the previous and next
  `archivedAt` and use the same transition rule:
  - next unarchived: emit `session-update` (create, change, restore);
  - previous live, next archived: emit `chat-session-archived { session, archivedCount }`;
  - previous absent, next archived (boot registration), or previous and next archived: emit no live row and no
    lifecycle list.
  A restore also emits `archive-summary`. Archived boot rows are counted by the connect summary and one restore-settled summary. Tmux
  updates keep their existing behavior.
- `removeChatSession` emits `session-removed`, plus `archive-summary { archivedCount }` when the removed
  session was archived.
- Each connect sends `archive-summary { archivedCount }` right after `sessions`. A restore's `session-update`
  is followed by `archive-summary`.

The existing bootstrap `whenRestored()` chain publishes one current
`archive-summary` through the hub when initial restoration settles, before
its fixture setup. Listening is not delayed. Clients connected during
restoration converge without reconnecting; archived boot rows and metadata
catch-up stay silent as row events, with no per-row boot summaries.

Workspace discovery retains its internal source invalidation on chat set/remove
through `chat-sources-changed`; the hub does not send that event to clients.

Client:

- `session-update` adds a session the client does not hold yet; today it ignores one. Additions exclude
  `pendingKills` and archived rows; restore removes any archived duplicate, and removal clears both row
  collections. Sound and attention notifications still skip a session the client did not hold before, as they
  do now.
- The store keeps `sessions` (live) and `archivedChats: Map<id, Session>`, plus `archivedCount` and the
  Archive paging state. A new selector, `selectSessionById(state, id)`, reads `sessions` first, then
  `archivedChats`. Every registry-row lookup by id switches to it, using a fresh inventory of current hooks,
  stores and components, not a fixed file/read count. Transcript maps in `chatStore` remain transcript maps.
  Include `PlanWorkspaceConversation`, `ToolDrill`, `teamTaskLabels` and `strategyLabels` as well as the
  original chat/Team call sites. Reads that iterate the live list stay on `sessions`.
- `chat-session-archived` moves the row from `sessions` to the top of `archivedChats`, and sets
  `archivedCount`. It does not touch the transcript or the snapshot cache, so an open archived chat stays
  open.
- `workspaceView.ts` builds `Archive` from `archivedChats` instead of filtering `sessions`. Its count comes
  from `archivedCount`. Hibernating and history rows keep coming from `agent-sessions`.

*Alternatives.* Sending archived rows in a trimmed form (id, name, `archivedAt`) would still grow with the
archive. Sending `session-removed` for an archive would drop the open transcript.

### D4. Archived rows come over HTTP: one page route, one by-id route

Both routes are read-only and live in `src/server/routes/archivedChats.ts`, behind the same access rules as
`/api/chat/search`:

- `GET /api/chat/sessions/archived?before=<cursor>&limit=50`: archived chat rows ordered by `(archivedAt desc,
  id desc)`. The cursor is the `(archivedAt, id)` of the last row received, encoded opaquely. The reply is `{
  rows, nextCursor | null, archivedCount }`. `limit` is clamped to 1–100.
- `GET /api/chat/sessions/rows?ids=a,b,c`: up to 100 ids. The reply is `{ rows, unknown: string[] }`.
  Unarchived ids are answered too, so a caller never has to know whether a session is archived.

They go over HTTP rather than the socket because of the hazard in Context: a page reply must never sit in
front of a pong. Keyset paging stays stable while chats are archived or restored during paging. A row archived
after a page was computed has a newer `archivedAt` than any later cursor, and it reaches the client through
`chat-session-archived`.

Client fetching (`src/client/stores/archivedChatRows.ts`):

- Expanding `Archive` with no loaded page requests the first page. Reaching the end of the list requests
  `nextCursor`. At most one page request is in flight, and a cursor that has already been requested is never
  requested again within that paging lifecycle. A new connection starts a new lifecycle and permits
  intentional refetching.
- `useSessionRow(id)` is the by-id path for components that may show an archived chat (worker and task rows,
  the Team page, the restored selection). Ids missing from both maps are collected for one animation frame and
  fetched in one request, at most 100 per request. An id the server reports unknown is remembered as unknown
  until the next connect or a lifecycle message for that id.
- The kept selection: when the persisted `selectedSessionId` is not in `sessions` after the first `sessions`
  message, App resolves it through the by-id path before the existing "select the first visible target"
  fallback runs. An unknown id clears the selection and shows the not-found notice. A valid archived row or
  pending resolution remains selected even with Archive collapsed. Existing filtered-out LIVE selection
  fallback, Team-page deferral, and hibernating selection rules are preserved.
- Once per new connection, its first `sessions` frame invalidates archived rows, pages, cursors, unknown marks
  and pending requests; live duplicates are excluded. Refresh the first page if Archive is expanded and
  resolve selected/rendered references before fallback. Periodic list broadcasts do not reset this cache. Old
  HTTP replies cannot cross this boundary.

Merging a fetched row (page or by-id) follows table M below. The rule is that live state always wins over a
fetched row. A WS lifecycle mutation for the id after request issuance, or a reconnect, wins over both HTTP
rows and unknown replies. Every lifecycle message clears obsolete unknown state. M1–M8 apply only to current
requests without a later mutation; M9–M11 specify overtaken replies. Freshness tracking is connection-local
client state, with no new wire version, lease or fencing token. HTTP returns registry-shaped `Session` rows,
including group/task/parked fields.

### D5. The workspace digest rides in the connect URL

The server computes `digest = sha256(JSON.stringify(repositories))`, truncated to 16 hex characters, once for
each snapshot the coordinator produces. `generatedAt` is left out. The digest travels as a field of
`workspace-snapshot` as a top-level message field (outside the parsed snapshot). Snapshot and digest are
replaced atomically on server and client. The client keeps the digest of the snapshot it holds and opens the
socket as `/ws?workspace=<digest>`. `createServerFetch` copies the parameter into `WSData`, and `open` skips
`workspace-snapshot` when it equals the current digest.

The parameter goes in the URL because the server sends its connect messages in `open`, before any client
message can arrive. A client hello would cost a round trip on every connect.

The digest is a pure function of the content, so a restart that rebuilds the same snapshot keeps the same
digest. Skipping is still correct then, because the client holds exactly that content. A parameter that is not
16 hex characters is ignored. A truncated digest collision would leave a stale workspace view until the next
change; at 64 bits that is negligible.

`JSON.stringify` is deterministic for the same coordinator output, because the snapshot is built in a fixed
order. W8 tests that the digest equals for snapshots built twice from the same repositories.

When no snapshot exists at open, defer only this initial comparison until first publication. Retain the valid
client digest, suppress that first snapshot if equal, otherwise send it (also for missing/malformed digests).
Consume the deferred comparison once; later structural broadcasts remain normal. This preserves equal-digest
suppression even when reconnecting before the first discovery pass after restart (W5a–W5c).

### D6. Precompressed assets and cache headers

- A post-build script, `scripts/compress-assets.ts`, run by `"build": "vite build && bun
  scripts/compress-assets.ts"`, walks `dist/client`. For every file whose extension is `.js`, `.mjs`, `.css`,
  `.html`, `.svg`, `.json`, `.webmanifest` or `.txt`, it writes `<file>.br` (brotli quality 11) and
  `<file>.gz` (gzip level 9), using `node:zlib`. No new dependency.
- Static serving moves to `src/server/staticAssets.ts`, as `staticAssetsMiddleware(root)`, which
  `bootstrap.ts` mounts where `serveStatic` is mounted today. It wraps `serveStatic({ root, precompressed:
  true, onFound })`, and `onFound` sets `Cache-Control`, classifying the found filesystem path relative to
  root and preserving `staticDir` / `AGENTBOARD_STATIC_DIR` configuration:
  - paths under `/assets/` (Vite's content-hashed output): `public, max-age=31536000, immutable`;
  - `index.html`, `sw.js`, `manifest.webmanifest`: `no-cache`;
  - anything else, including the root-level `workbox-<hash>.js`, fonts and icons: no header (today's
    behaviour).
- Workbox's `globPatterns` lists no `.br` or `.gz`, so the precache does not grow. Its fetches send
  `Accept-Encoding` and receive the compressed form.
- The release workflow copies `dist/client` whole, so the copies ship without changes to it. The tarball grows
  by about 30%.

*Alternative.* Compressing on the fly in a Hono middleware would spend CPU on every request, and brotli
quality 11 is too slow for that.

### D7. No recovery matrix row

The connect-timeout escalation, the verification deadline and the digest skip are transport retries and a
cache. They are not durable recovery mechanisms and hold no exclusive slot, so `docs/recovery-matrix.md` gets
no row.

## Acceptance oracles

Each table is committed verbatim as a table-driven test with the code it covers. Times are milliseconds and
use injected clocks, never wall time.

### T: connect timeout (D1)

Input: the previous `next`, the event, and whether this is the first attempt after a resume. Output: the
timeout of the next attempt.

| id | previous next | event | resume first | next attempt waits |
| --- | --- | --- | --- | --- |
| T1 | (fresh) | none | no | 3000 |
| T2 | 3000 | timeout | no | 6000 |
| T3 | 12000 | timeout | no | 24000 |
| T4 | 24000 | timeout | no | 24000 |
| T5 | * | open after 200 | no | 3000 |
| T6 | * | open after 5000 | no | 15000 |
| T7 | * | open after 10000 | no | 24000 |
| T8 | 3000 | error before open | no | 3000 |
| T9 | 3000 | none | yes | 8000 |
| T10 | 24000 | none | yes | 24000 |
| T11 | 6000 | open after 1000 | no | 3000 |

Unreachable: a negative or `NaN` handshake. The handshake is measured with `performance.now()` on both ends
(today `lastConnectTs` is `Date.now()`, which a wall-clock step can move backwards), and tests inject that
clock.

Sequence oracle T12: a fake socket that opens 4,000 after construction. The client's attempts time out at
3,000, then open at 4,000 within a 6,000 timeout. There are exactly two attempts, and status is `connected`.

### V: verification deadline (D2)

| id | samples (ms) | verification deadline |
| --- | --- | --- |
| V1 | none | 1500 |
| V2 | [50] | 1500 |
| V3 | [1000] | 3000 |
| V4 | [5000] | 8000 |
| V5 | [400, 1200] | srtt = 400 + (1200 - 400) / 8 = 500, so 1500 |
| V6 | a verification pong of 4000 only | 1500 (not sampled) |
| V7 | [1000], then a reconnect | 3000 (kept) |

Sequence oracle V8: srtt 1,000, a resume, and the verify pong arrives at 1,200. The socket is kept; there is
no reconnect. With srtt 50 and no pong, a forced reconnect happens at exactly 1,500.

### M: merging a fetched archived row (D4)

The row comes from a page or a by-id reply. "Held" is the client's state for that id when the reply is
applied.

| id | held | fetched row | result |
| --- | --- | --- | --- |
| M1 | absent | archived | added to `archivedChats` |
| M2 | in `sessions` (live) | archived | dropped; the live row stays |
| M3 | in `archivedChats`, same `archivedAt` | archived | replaced by the fetched row |
| M4 | in `archivedChats`, newer `archivedAt` | archived, older | dropped |
| M5 | in `archivedChats`, older `archivedAt` | archived, newer | replaced |
| M6 | absent | unarchived | added to `sessions` |
| M7 | in `sessions` | unarchived | dropped; the live row stays |
| M8 | absent | unknown id | marked unknown; a kept selection naming it is cleared |
| M9 | archived by WS after request | unarchived row computed before archive | dropped; archived row stays |
| M10 | removed by WS after request | row computed before removal | dropped; no ghost row |
| M11 | created/restored by WS after request | unknown computed before creation/restore | dropped; row and selection stay |

A reconnect after issuance drops any row/unknown reply regardless of held state. New requests after
invalidation follow M1–M8 again.

Unreachable: a page reply containing an unarchived row. The page query filters on `archivedAt IS NOT NULL` (P2
checks it).

### W: workspace snapshot on connect (D5)

| id | URL digest | server current snapshot | sent on open |
| --- | --- | --- | --- |
| W1 | absent | present | snapshot with digest |
| W2 | equal | present | nothing |
| W3 | different | present | snapshot with digest |
| W4 | malformed (`zz`, 17 chars) | present | snapshot with digest |
| W5 | * | none yet | nothing; defer initial comparison to first snapshot |

Deferred first-publication oracle (only when W5 applied):

| id | held URL digest | first available snapshot | result |
| --- | --- | --- | --- |
| W5a | valid, equal | present | suppress first snapshot |
| W5b | valid, different | present | send snapshot with digest |
| W5c | absent or malformed | present | send snapshot with digest |

After each W5a–W5c, later structural changes broadcast normally. Closing before first publication discards
that connection's deferred comparison.

Digest oracles: W6, two snapshots with equal `repositories` and different `generatedAt` give equal digests.
W7, adding one worktree changes the digest. W8, a fresh `WorkspaceCoordinator` built over the same
repositories (a restart) gives the same digest.

### E: encoding and cache headers (D6)

Requests go through `staticAssetsMiddleware` mounted on a Hono app at `/*`, as `bootstrap.ts` mounts it, over
a fixture `dist/client` that has `assets/index-abc123.js` (with `.br` and `.gz`), `index.html` (with both),
`sw.js`, and `icon.png`.

| id | path | Accept-Encoding | Content-Encoding | Cache-Control |
| --- | --- | --- | --- | --- |
| E1 | `/assets/index-abc123.js` | `gzip, deflate, br` | br | `public, max-age=31536000, immutable` |
| E2 | `/assets/index-abc123.js` | `gzip` | gzip | immutable as E1 |
| E3 | `/assets/index-abc123.js` | (none) | (none) | immutable as E1 |
| E4 | `/` | `br` | br | `no-cache` |
| E5 | `/sw.js` | `br` | (none: no copy in the fixture) | `no-cache` |
| E6 | `/icon.png` | `br` | (none) | (none) |
| E7 | `/assets/index-abc123.js` | `br;q=1` | (none) | immutable as E1 |

Each row also checks that the decoded body equals the original file, and that `Vary: Accept-Encoding` is
present exactly when `Content-Encoding` is.

### Properties

- **P1 (archive count).** Generator: seeded sequences of 200 operations over 30 chat ids (create, archive,
  restore, remove, plus connect at random points). Seams: the real `SessionRegistry` and `ConnectionHub` with
  fake sockets and the actual client protocol/store. Create/boot use `setChatSession`; archive/restore and
  archived-staying patches use the real `updateSession` path called by `ChatSessionManager.applyPatch`.
  Include boot archived registration after connect, restore settlement, archived removal and unrelated tmux refresh. Property: after each
  broadcast, the client's `archivedCount` equals the registry's archived count at published count boundaries and after restoration settles, the client's live ids equal
  `getLive()` ids, and no archived id is in the live list. Seed 0x51ED, cases `propertyCases(200)`.
- **P2 (paging is complete and duplicate-free).** Generator: seeded archives of 0–300 chats with colliding
  `archivedAt` values, then a page-walk with limits 1–100, with archives and restores interleaved between
  pages. Seams: the route over a fresh test database. Property: the rows seen are distinct, every chat
  archived before the walk began and not restored during it appears exactly once, every row is archived, and
  the order is `(archivedAt desc, id desc)`. Seed 0xA2C1, cases `propertyCases(100)`.
- **P3 (compression round trip).** Generator: every file of a real `vite build` output. Property: for each
  eligible file, `brotliDecompress(.br)` and `gunzip(.gz)` equal the file, and no ineligible file has a copy.
  This is deterministic over the build, so it needs no seed.

## Risks / Trade-offs

- [A lookup by id still reads `sessions` directly and misses an archived chat, so a released member's row goes
  blank on the Team page] → A fresh current-source inventory in task 2.4 moves every lookup or marks a
  deliberate iteration over the live list. A guard test fails on a lookup by id through `sessions.find(`
  outside the store module.
- [The kept selection clears before the by-id fetch returns] → D4 orders the resolution before the
  first-visible fallback, and task 3.4's test covers it.
- [Hono's exact token match skips compression for `br;q=1`] → The original is served, which is correct but
  slower. Browsers send bare tokens. E7 pins the behaviour so a Hono upgrade that changes it is noticed.
- [A long-cached asset is wrong after a bad build] → Asset names are content hashes, so a fixed build gets new
  names. `index.html` and the service worker are never cached.
- [The digest skip leaves a stale workspace if the client's copy was changed locally] → The client never edits
  the snapshot: it only replaces it. Task 4.2 keeps the digest only beside the snapshot it describes (I3).
- [Escalating timeouts slow down reconnecting when the server is really down] → Attempts already back off up
  to 30 s between tries, and the cap is 24 s per attempt. A refused connection does not escalate (T8).

## Migration Plan

The supported deployment is a matched client and server from one build. An already-loaded old client may miss
created/restored chats and retain archived cards until refresh. Service-worker updates and polling help
replace it, but do not guarantee instantaneous or strictly bounded replacement. No compatibility shim or extra
protocol version is added. Rollback reverts the build; no stored data changes.

## Implementation contract

### Acceptance

- A1: Connect timeouts follow table T (T1–T12) in `WebSocketManager`.
- A2: Resume verification waits the deadline of table V (V1–V8).
- A3: On connect, `sessions` holds no archived chat session, and `archive-summary` carries the archived chat
  count.
- A4: Creating, restoring, archiving or removing a chat session emits only the single-session messages of D3,
  never a `sessions` list.
- A5: The `Archive` section shows `archivedCount` without loading rows, loads pages of 50 from `GET
  /api/chat/sessions/archived` when expanded, and merges rows per table M.
- A6: A session referenced by id that the client does not hold is fetched from `GET /api/chat/sessions/rows`,
  in one request per animation frame, including the kept selection after a reload.
- A7: `open` follows table W, and the digest oracles W6–W8 hold.
- A8: Static responses follow table E, and the build writes `.br` and `.gz` copies per D6.

### Invariants

- I1: No archived-chat page or row reply travels over the WebSocket.
- I2: A fetched row never replaces a live row the client holds (M2, M7).
- I3: The client never sends a workspace digest other than one it received with the snapshot it holds.
- I4: A decoded compressed response equals the original file byte for byte.
- I5: `GET /api/sessions` returns the same set of sessions as before the change.
- I6: On a fast link (handshake under 1 s, srtt under 500 ms), the connect timeout is 3 s and the verification
  deadline is 1.5 s, as today.

### Scope

- `src/client/hooks/**`
- `src/client/stores/**`
- `src/client/protocol/**`
- `src/client/utils/workspaceView.ts`
- `src/client/App.tsx`
- `src/client/components/**`
- `src/client/__tests__/**`
- `src/server/SessionRegistry.ts`
- `src/server/ws/**`
- `src/server/routes/archivedChats.ts`
- `src/server/staticAssets.ts`
- `src/server/bootstrap.ts`
- `src/server/workspace/**`
- `src/server/chat/ChatSessionManager.ts`
- `src/server/__tests__/**`
- `src/shared/types.ts`
- `scripts/compress-assets.ts`
- `scripts/__tests__/**`
- `package.json`
- `tests/e2e/**`
- `docs/architecture/**`

### Verification

- V1: `src/client/__tests__/connectTimeouts.test.ts` runs tables T and V as table tests and the sequence
  oracles T12 and V8 (kills: escalation removed, a learned timeout without the floor, verification sampled as
  srtt).
- V2: `src/server/__tests__/archivedSessionList.test.ts` covers A3, A4 and property P1 (kills: `getAll()` left
  in the connect path, `setChatSession` or `updateSession` still emitting a list/live archived row); covers
  boot registration and patch archive/restore through actual protocol/store composition.
- V3: `src/server/__tests__/archivedChatsRoute.test.ts` covers the routes, the id limit, the cursor, and
  property P2 (kills: ordering by `archivedAt` alone, so ties duplicate or vanish).
- V4: `src/client/__tests__/archivedChatRows.test.ts` runs table M, page dedupe, and the one-request-per-frame
  batching (kills: a fetched row overwriting a live one, stale HTTP resurrecting a removed/archived row);
  includes M9–M11, connection invalidation and selection preservation.
- V5: `src/server/__tests__/workspaceDigest.test.ts` runs table W and W6–W8 (kills: `generatedAt` included in
  the digest, the URL parameter ignored, unconditional first-publication broadcast after restart); includes
  W5a–W5c and later broadcast preservation.
- V6: `src/server/__tests__/staticAssets.test.ts` runs table E over the middleware (kills: `precompressed`
  off, `onFound` not wired). `scripts/__tests__/compressAssets.test.ts` runs P3.
- V7: `tests/e2e/archive-lazy.spec.ts`: with 120 archived chats seeded, a collapsed `Archive` shows 120 and
  the first `sessions` frame holds no archived row. Expanding shows 50 rows, and scrolling shows 100.
  Reloading with an archived chat selected opens it. The e2e server's main bundle response carries
  `Content-Encoding: br` and the immutable `Cache-Control` (kills: `bootstrap.ts` still mounting bare
  `serveStatic`).
- V8: `bun run check` passes on the committed tree.

### Excluded

- X1: Chat history windows, WebSocket compression, liveness by any message, and backpressure, all owned by
  `fast-chat-switching`.
- X2: A time-based (for example one-hour) chat history window.
- X3: Versioning connect messages other than the workspace snapshot.
- X4: Caching state across page reloads.
- X5: Shrinking the workspace snapshot's worktree list.
- X6: A slow-link indicator in the UI.
- X7: Honouring `q` values in `Accept-Encoding`.
