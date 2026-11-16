# Tasks

Each group lands its own tests. Groups 2 and 3 ship together to preserve
archive access. One core writer serializes shared files across groups 1–4,
5.2 and 6. Group 5.1 is separately owned and integrated after review. Every table in
design.md is committed verbatim as a table-driven test, in the same commit
as the code it covers. Each scenario test carries its
`// @covers: <capability> › <requirement> › <scenario>` annotation.

## 1. Connect timeout and verification deadline (D1, D2)

- [ ] 1.1 In `src/client/hooks/useWebSocket.ts`, measure the handshake with
  `performance.now()` and replace the fixed `CONNECT_TIMEOUT_MS` with D1's
  `nextConnectTimeoutMs` (doubling on timeout, learned from `onopen`, max
  with the resume timeout, unchanged on error). Inject the clock and the
  timer seam the existing `websocketManager.test.ts` already uses. Verify:
  `src/client/__tests__/connectTimeouts.test.ts` runs table T (T1–T11) and
  sequence oracle T12. Mutants to kill: escalation removed (T2–T4, T12
  fail), the 3 s floor dropped from the learned value (T5, T11), an error
  escalating (T8).
- [ ] 1.2 Record each heartbeat ping's send time, keep `srtt` (weight 1/8,
  seeded by the first sample; only armed, current-socket heartbeat pongs
  sampled, never verification or hidden/late pongs), and set the
  verification timer to `clamp(3 * srtt, 1500, 8000)`. Verify: the same
  file runs table V (V1–V7) and sequence oracle V8. Mutants to kill: a
  verification pong sampled (V6), the cap removed (V4), the estimate reset
  on reconnect (V7).
- [ ] 1.3 Annotate the `terminal-streaming` scenarios on the tests above,
  and update the header comment of `useWebSocket.ts` to describe the
  learned timeouts. Verify:
  `bun run test src/client/__tests__/connectTimeouts.test.ts scripts/__tests__/specCoverageGuard.test.ts`
  passes.

## 2. Archived chats leave the session list (D3)

- [ ] 2.1 Add `getLive()` and `archivedChatCount()` to `SessionRegistry`,
  use `getLive()` for the `sessions` event and the connect message in
  `socketHandlers.ts`, and send `archive-summary` after `sessions`. Add the
  new message types to `src/shared/types.ts`. Verify:
  `src/server/__tests__/archivedSessionList.test.ts` checks that a connect
  with 7 live and 771 archived chats sends 7 rows and a count of 771, and
  that `GET /api/sessions` still returns all 778 (I5). Mutant to kill:
  `getAll()` left in the connect path.
- [ ] 2.2 Apply previous/next archive transitions in both `setChatSession` and
  `updateSession`, and replace the list emit in `removeChatSession`
  with D3's single-session messages (`session-update`,
  `chat-session-archived`, `session-removed` plus `archive-summary`), and
  wire them in `ConnectionHub.wireRegistry`. Verify: the same file covers
  all lifecycle scenarios of `session-updates`, including archived boot
  registration after connect, one whenRestored-settled summary through actual
  bootstrap wiring without delaying listen, unrelated tmux refresh, and archived-staying patches, plus property P1 through the
  actual patch path and client protocol/store (seed
  0x51ED, `propertyCases(200)`). Mutants to kill: `setChatSession` still
  emitting `sessions` (no `sessions` frame may appear for a lifecycle
  change), restore without `archive-summary` (P1's count fails).
- [ ] 2.3 Client: make `session-update` add a session it does not hold, and
  keep the existing rule that notifications skip a session the client did
  not hold before. Add `archivedChats`, `archivedCount` and
  `selectSessionById` to `sessionStore.ts`, and handle
  `chat-session-archived` and `archive-summary` in
  `protocol/sessionMessages.ts` without touching the transcript or the
  snapshot cache. Verify: `src/client/__tests__/archivedSessionStore.test.ts`
  shows that an open chat stays open when it is archived, that a created
  session appears, and that `archivedCount` follows the messages. Mutant
  to kill: archiving routed through the `session-removed` handler (the
  transcript is dropped).
- [ ] 2.4 Inventory current hooks/stores/components and move every registry-row
  lookup by id in the client files (App, ChatTaskRow, TeamTasksView, ChatWorkersStrip,
  ChatWorkerRow, ChatSurface, ChatView, ProductStrategyView, sessionStore,
  useRevealRow, chatStore, TeamWorkspaceView, sessionMessages,
  PlanWorkspaceConversation, ToolDrill, teamTaskLabels, strategyLabels,
  and any other current call sites; distinguish transcript maps) to
  `selectSessionById`. Leave iterations over the live list on `sessions`,
  each with a one-line comment saying why. Add
  `src/client/__tests__/sessionLookupGuard.test.ts`, which fails on
  `sessions.find(` or `sessions.some(` by id outside `sessionStore.ts`.
  Verify: the guard passes, and a planted `sessions.find((s) => s.id ===`
  in a component makes it fail.
- [ ] 2.5 Build `Archive` in `src/client/utils/workspaceView.ts` from
  `archivedChats` and take its count from `archivedCount`. Hibernating and
  history rows stay unchanged. Verify: `workspaceView.test.ts` shows a
  collapsed `Archive` with count 771 and no rows loaded. Mutant to kill:
  the count taken from loaded rows (it shows 0).

## 3. Archived rows over HTTP (D4)

- [ ] 3.1 Add `src/server/routes/archivedChats.ts` with the page route
  (keyset on `(archivedAt desc, id desc)`, opaque cursor, `limit` clamped
  to 1–100) and the by-id route (at most 100 ids, `unknown` listed), and
  mount it in `bootstrap.ts` with the same access rules as
  `/api/chat/search`. Verify:
  `src/server/__tests__/archivedChatsRoute.test.ts` covers the clamp, the
  101-id refusal, the unknown ids, and property P2 (seed 0xA2C1,
  `propertyCases(100)`, with colliding `archivedAt` values). It also
  checks, through the real app, that the route is mounted. Mutants to kill:
  ordering on `archivedAt` alone (P2 sees duplicates or gaps), the route
  not mounted (404).
- [ ] 3.2 Add `src/client/stores/archivedChatRows.ts`: paging (one request
  in flight, never the same cursor twice per paging lifecycle), `useSessionRow(id)` with
  per-frame batching of at most 100 ids, the unknown-id memory cleared on
  the first sessions frame of each new connection or a lifecycle mutation,
  and the merge of table M. Invalidate archived/page/cursor/request caches
  once per connection, exclude live duplicates, refresh if expanded, and
  re-resolve selected/rendered references. Ignore older HTTP row/unknown
  replies after reconnect or a later WS mutation for that id. Verify:
  `src/client/__tests__/archivedChatRows.test.ts` runs table M (M1–M11),
  page dedupe across and within connections, stale replies, and "12 ids in one frame give one request". Mutants to kill:
  a fetched row overwriting a live one (M2, M7), no batching (two
  requests).
- [ ] 3.3 Wire the navigator: expanding `Archive` loads the first page,
  reaching the end loads the next one, and a loading row shows while a page
  is in flight. Switch the worker rows, task rows and Team page assignees
  to `useSessionRow`. Verify: the `workspace-navigation` scenarios "Collapsed
  Archive loads no archived rows", "Expanding Archive loads the first
  page", "Scrolling loads the next page", "Archiving or restoring while
  Archive is open" and "Team page references archived members" each have
  an annotated component test.
- [ ] 3.4 Resolve the kept selection in `App.tsx`: when it is not in
  `sessions` after the first `sessions` message, fetch it by id before the
  "select the first visible target" fallback runs. Keep archived/pending selection with Archive collapsed;
  preserve filtered-live fallback, Team deferral and hibernating behavior.
  Only a current unknown reply clears it
  and shows the not-found notice. Verify: an annotated test for "Reload
  with an archived chat selected" and "The chat no longer exists". Mutant
  to kill: the fallback running first (the selection moves to another
  chat).

## 4. Workspace digest on reconnect (D5)

- [ ] 4.1 Compute the digest once per snapshot in
  `src/server/workspace/workspaceCoordinator.ts` (sha256 of
  `JSON.stringify(repositories)`, 16 hex characters), and send it as a
  field of `workspace-snapshot`. Verify:
  `src/server/__tests__/workspaceDigest.test.ts` runs W6–W8. Mutant to
  kill: `generatedAt` included in the digest (W6 fails).
- [ ] 4.2 Copy a well-formed `workspace` URL parameter into `WSData` in
  `createServerFetch`, and skip the snapshot in `open` per table W. On the
  client, keep the digest only beside the snapshot in the store that
  replaces it, and append `?workspace=<digest>` to the socket URL. Verify:
  the same file runs table W (W1–W5) over `createServerFetch` and the
  `open` handler with fake sockets, deferred initial comparison W5a–W5c
  before first publication after restart and normal later broadcasts, and a client test shows the URL
  carries the digest of the last snapshot received (I3). Mutants to kill:
  the parameter ignored (W2 sends the snapshot), a malformed parameter
  accepted (W4).

## 5. Compressed and cached static assets (D6)

- [ ] 5.1 Add `scripts/compress-assets.ts` (node:zlib, brotli quality 11,
  gzip level 9, the D6 extension list) and change `"build"` in
  `package.json` to run it after `vite build`. Verify:
  `scripts/__tests__/compressAssets.test.ts` runs P3 over a fixture tree
  with one file of each eligible extension and a PNG. Mutant to kill: a PNG
  compressed, or `.webmanifest` skipped.
- [ ] 5.2 Add `src/server/staticAssets.ts` (`staticAssetsMiddleware(root)`,
  `precompressed: true`, `onFound` setting the D6 `Cache-Control` values)
  and mount it in `bootstrap.ts` in place of the bare `serveStatic`,
  classifying root-relative found paths and preserving staticDir configuration.
  Verify: `src/server/__tests__/staticAssets.test.ts` runs table E (E1–E7),
  with the decoded body and `Vary` checks on every row. Mutants to kill:
  `precompressed` off (E1, E2, E4), `onFound` unwired (every
  `Cache-Control` cell).

## 6. Integration and docs

- [ ] 6.1 Add `tests/e2e/archive-lazy.spec.ts` (design V7): 120 archived
  chats seeded, a collapsed `Archive` shows 120, and the first `sessions`
  frame holds no archived row. Expanding shows 50 rows, and scrolling
  shows 100. Reloading with an archived chat selected opens it. The main
  bundle carries `Content-Encoding: br` and the immutable `Cache-Control`.
  Verify: build and direct Playwright with the CI fixture setup in a
  disposable private HOME/database/tmux/server/port; never invoke
  `bun run test:e2e` (its teardown affects the live server). Include affected
  archive selection, Team, ordinary chat and reconnect workflows. Mutant to kill: `bootstrap.ts` still mounting bare `serveStatic`.
- [ ] 6.2 Add a "Connect payload and slow links" bullet to
  `docs/architecture/chat.md`. It names D1–D6: the learned timeouts, the
  live-only session list with the archive summary, the archived-row
  routes, the workspace digest, and the static encodings. Verify: the
  bullet names only files that exist (`ls` each path it cites).
- [ ] 6.3 Measure once against a private synthetic seeded dev server whose state matches the
  proposal (778 sessions, 771 archived) with the probe from the proposal.
  Expect the connect messages to drop from about 830 KB to about 350 KB
  with no held digest, and to about 25 KB on a reconnect with an unchanged
  workspace. Record the figures in the result. Then run `bun run check` on
  the committed tree and confirm it passes.

## Workflow follow-up

- Archive the change after review. Archiving needs `@covers` annotations
  for every ADDED scenario left in the main specs.
