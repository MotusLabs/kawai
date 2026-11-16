# Proposal

## Why

Over a link with about 1 s of round-trip time and 1 Mbit/s of bandwidth, the
web app cannot open a chat at all. Measured against the live server on
2026-11-16, the steps add up like this:

- The WebSocket handshake (TCP, TLS and the HTTP upgrade) takes about three
  round trips, roughly 3 s. The client gives up on a connect after
  `CONNECT_TIMEOUT_MS = 3_000` and retries with the same timeout, so on such
  a link connecting either flaps or never succeeds. The resume check allows
  `VERIFY_PONG_TIMEOUT_MS = 1_500` for one round trip, which a slow link
  barely meets, and a miss forces a full reconnect.
- Each connect, and each reconnect, sends about 830 KB before any chat data:
  `sessions` is 482 KB, `workspace-snapshot` is 326 KB, and `agent-sessions`
  is 19 KB. 771 of the 778 sessions in `sessions` are archived chats (479 KB);
  the 7 live ones take about 3 KB. Of `workspace-snapshot`, 292 KB is the
  worktree list of one repository. At 1 Mbit/s these messages alone take
  about 7 s.
- Creating, restoring or removing a chat session rebroadcasts the whole
  `sessions` list to every client (`SessionRegistry.setChatSession` and
  `removeChatSession`). Spawned dev and reviewer sessions make this frequent.
- The app bundle is 1.65 MB and is served by `serveStatic` without
  compression or long-lived cache headers. Gzipped it would be 465 KB. The
  service worker hides this after the first visit, but every app update
  downloads the full bundle again.

The chat snapshot then has to arrive behind all of this. When it is large,
the heartbeat expires, the client reconnects, and the sequence starts over.

`fast-chat-switching` (in progress) fixes the chat history side of this: a
512 KiB / 500-event window budget, eliding large tool outputs, compressing
large messages, sending only what changed when switching back, closing a
connection instead of silently dropping messages, and treating any inbound
message as a sign of life. This change covers what that change leaves out:
how the connection is set up, how much state is sent on every (re)connect,
and how static assets are delivered.

## What Changes

- **Connect timeouts grow on slow links.** After a connect attempt times
  out, the next attempt waits twice as long, up to a cap. A successful
  connect sets the next timeout to at least three times the handshake time
  just observed. The resume-verification deadline follows the round-trip
  time measured from heartbeat pongs instead of a fixed 1.5 s. On a fast
  link, a dead socket is still caught as quickly as it is today.
- **Archived chats are not sent on connect.** The session list on connect
  and in broadcasts holds only unarchived sessions. The navigator gets an
  archive summary instead (the count of archived chats), and it
  loads `Archive` rows in pages, newest first, when the section is expanded.
  An archived chat that the app shows elsewhere (a released member on the
  Team page, the selection kept across reloads) is fetched by id.
- **Session changes are sent one at a time.** Creating, restoring,
  archiving or removing a chat session sends a single-session update or
  removal instead of the whole list.
- **Reconnects skip an unchanged workspace snapshot.** Every workspace
  snapshot carries a digest of its content. A connecting client names the
  digest it holds, and the server leaves the 326 KB snapshot out of the
  connect messages when the digests match. Because the digest depends only on
  the content, this is also correct after a server restart.
- **Static assets are compressed and cached.** The build writes brotli and
  gzip copies of the client assets, and the server serves the best encoding
  the browser accepts. Content-hashed assets are sent with
  `Cache-Control: public, max-age=31536000, immutable`. `index.html` and the
  service worker are sent with `no-cache`.

## Capabilities

### New Capabilities

- `web-asset-delivery`: compressed and cached delivery of the web client's
  static assets.

### Modified Capabilities

- `terminal-streaming`: new requirements for connect timeouts and resume
  verification that adapt to the link.
- `session-updates`: the session list leaves out archived chats, and
  creating, restoring, archiving or removing a chat sends a single-session
  update instead of the whole list.
- `workspace-navigation`: `Archive` gets its count from a summary and loads
  its rows on demand; archived chats shown elsewhere are fetched by id; a
  reconnect skips an unchanged workspace snapshot.

## Impact

- Client: `src/client/hooks/useWebSocket.ts` (connect and verification
  timeouts, round-trip measurement, the held workspace digest in the
  connect URL), the session store and its message handlers (archived chats
  held apart from the live list, lookups by id that cover both), the
  navigator `Archive` section (count from the summary, paged loading), and
  the call sites that look sessions up by id (inventory current hooks, stores and components).
- Server: `src/server/ws/socketHandlers.ts` (connect messages, digest
  comparison), `src/server/SessionRegistry.ts` and `ws/ConnectionHub.ts`
  (unarchived list, single-session broadcasts, archive summary), two new
  read-only HTTP routes (a page of archived chats, and rows by id), the
  workspace snapshot broadcast in `bootstrap.ts` (digest), and static
  serving in `bootstrap.ts` (encodings and cache headers).
- Build: a post-build step writes the compressed copies into `dist/client`,
  which the release tarball already copies whole.
- Wire: `sessions` no longer includes archived chats, `session-update` adds
  a session the client does not hold yet, and a new message reports an
  archived chat with the new archive count. Client and server ship together
  in one build. An already-loaded old client may miss created/restored rows
  or retain archived cards until refresh; update polling/service workers
  give no instantaneous or strict bounded replacement guarantee. No new
  compatibility shim or wire version is introduced. The workspace digest is
  additive. `GET /api/sessions` is unchanged.
- Out of scope: anything about chat history and liveness, which
  `fast-chat-switching` owns. That includes a time-based (for example
  one-hour) history window: its 512 KiB budget already limits what one
  attach can cost, and a time window cannot, because one hour of tool output
  can be several megabytes. Also out of scope: making the workspace
  snapshot's worktree list smaller (compression from `fast-chat-switching`
  and the digest here cover the repeated cost), skipping the other connect
  messages on reconnect (about 22 KB once archived chats are gone), and a
  slow-link indicator in the UI.
- Ordering: independent of `fast-chat-switching`. Either change can land
  first, and they edit different requirements in `terminal-streaming`.
