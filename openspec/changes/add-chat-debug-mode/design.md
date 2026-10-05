# Design

## Context

- `ChatSessionDriver` builds SDK `Options` and calls an injected
  `ChatQueryFactory` (`sdk.query` in production, `fixtureQueryFactory` under
  `AGENTBOARD_CHAT_FIXTURE=1`). The SDK spawns the Claude Code CLI itself and
  speaks newline-delimited JSON over its stdin/stdout. Control traffic
  (`initialize`, `can_use_tool`, `interrupt`, `control_response`) never
  reaches the driver as an `SDKMessage`.
- The installed SDK (0.3.289) exposes `Options.spawnClaudeCodeProcess(opts:
  SpawnOptions) => SpawnedProcess` (`stdin`, `stdout`, `kill`, `exitCode`,
  `killed`, `on/once/off` for `exit`/`error`). A plain `ChildProcess`
  satisfies it. This is the only public seam where the actual wire bytes
  are visible.
- Chat traffic to the browser is WebSocket-only (`chat-attach` →
  `chat-snapshot`, then batched `chat-events`) through `ChatConnections`.
  There is no HTTP auth layer, so a new HTTP route would not be more
  protected than the WebSocket.
- `ChatSessionManager.ts` is already ~470 lines; `ChatSessionDriver.ts` ~600.
  New logic has to live in new modules.
- Data lives beside `agentboard.db` (default `~/.agentboard/`, overridable
  via `AGENTBOARD_DB_PATH`).

## Goals / Non-Goals

**Goals:**
- Capture the exact lines exchanged with the CLI process, including control
  messages, at near-zero cost to the chat path.
- Make the capture survive restarts and respawns with a monotonic per-session
  sequence.
- Serve history in pages plus live tail to only the clients that ask.

**Non-Goals:**
- Capturing the CLI's own HTTP traffic to the Anthropic API (requests to
  `api.anthropic.com`). This change records the Agentboard ↔ Claude Code
  boundary only.
- Redacting prompt or file contents. The log holds the same data as the
  Claude transcript; only the spawn environment is excluded.
- Editing, replaying, or injecting frames.
- Search or filtering inside the panel (see Open Questions).
- Terminal (tmux) sessions.

## Decisions

### D1. Tap at `spawnClaudeCodeProcess`, not at the driver

`createWireTappedSpawn(recorder)` (new `src/server/chat/wireTap.ts`) returns a
`spawnClaudeCodeProcess` implementation that:

1. Records a `lifecycle` frame `{"event":"spawn","command","args","cwd"}`
   (never `env`), then calls `child_process.spawn(command, args, { cwd, env,
   signal, stdio: ['pipe','pipe','pipe'] })`.
2. Returns an object satisfying `SpawnedProcess` whose `stdin` is a
   `Writable` that forwards every chunk to `child.stdin` unchanged (honoring
   the callback, so backpressure and `EPIPE` reach the SDK) and feeds a line
   splitter that records `out` frames; `end()` ends `child.stdin`.
3. Exposes `stdout` as `child.stdout.pipe(new Transform(...))`: the transform
   pushes each chunk through unchanged and feeds a splitter that records `in`
   frames. Piping keeps a single consumer on the child stream so the SDK's
   reader and the tap never compete for `data` events.
4. Drains `child.stderr` into a splitter recording `stderr` frames (with a
   custom spawner the SDK does not read stderr, so leaving it unread could
   block the child).
5. Records `{"event":"exit","code","signal"}` (or `{"event":"error",
   "message"}`) and delegates `kill`, `killed`, `exitCode`, `signalCode`,
   `on/once/off` to the child.

Splitters use `StringDecoder('utf8')` so multi-byte characters split across
chunks are not corrupted, emit one frame per `\n`-terminated line without the
newline, and flush a trailing partial line on stream end.

*Alternative considered*: log `SDKMessage`s in `handleSdkMessage` and the
`SDKUserMessage`/`PermissionResult` the driver produces. Rejected (user
choice): it misses control traffic and shows SDK-normalised objects rather
than the wire.

### D2. Raw line is the source of truth

```ts
// src/shared/chat.ts
export type ChatWireDirection = 'out' | 'in' | 'stderr' | 'lifecycle'
export interface ChatWireFrame {
  seq: number      // per session, >= 1, monotonic across respawn/restart
  at: string       // ISO timestamp of capture
  dir: ChatWireDirection
  raw: string      // exact line, no trailing newline
}
```

Frames store the raw string, never a re-serialized object, so "copy" returns
the bytes that crossed the pipe. Parsing for pretty-print and the type label
happens in the client (`type`, plus `subtype`, `request.subtype`, or
`event.type` for `stream_event`). `out`/`in` are named from Agentboard's
side: `out` = to Claude Code (stdin), `in` = from Claude Code (stdout).

### D3. Per-session JSONL with one rotated generation

New `src/server/chat/ChatWireLog.ts` owns one session's files under
`<dirname(dbPath)>/chat-wire/`:

- Current: `<sessionId>.jsonl`; previous: `<sessionId>.1.jsonl`. Each line is
  a JSON-encoded `ChatWireFrame`.
- When the current file passes 16 MiB, it is renamed over `.1.jsonl` and a
  new current file starts, so retention is 16–32 MiB per session and oldest
  frames go first.
- `record(dir, raw)` assigns `seq` synchronously and appends the frame to an
  in-memory pending buffer; a single serialized writer flushes the buffer with
  `fs.promises.appendFile` on the next tick. Write errors are logged once per
  session and the frames dropped — chat never awaits or fails on capture.
- On first use after a restart, `seq` resumes from the last line of the
  current file (falling back to `.1.jsonl`), read from the file tail.
- `readPage({ beforeSeq?, limit })` returns up to `limit` frames with
  `seq < beforeSeq` (or the newest when omitted) and `hasOlder`, reading
  both generations plus unflushed pending frames.
- `delete()` removes both files.

New `src/server/chat/ChatWireLogs.ts` is the registry: `get(sessionId)`
(lazy), `delete(sessionId)`, `pruneOrphans(knownIds)` (startup), and a
`subscribe(sessionId, listener)` fan-out of recorded frames for live
delivery. `ChatSessionManager` receives it as an option (index.ts builds it
from the DB directory; tests pass a temp dir), passes the session's recorder
to each driver, calls `delete` in `kill`, and `pruneOrphans` after
`restorePersisted`.

*Alternative considered*: an SQLite table. Rejected: frame volume (one row per
streamed token delta) would bloat `agentboard.db`, and trimming/vacuum is
costlier than renaming a file.

*Alternative considered*: in-memory ring buffer only. Rejected: the user
needs history of any session, including across restarts.

### D4. Driver and fixture wiring

`ChatSessionDriverOptions` gains `wire?: ChatWireRecorder` (`{ record(dir,
raw): void }`). `spawnQuery()` adds `spawnClaudeCodeProcess:
createWireTappedSpawn(wire)` to `Options` when present, so every respawn
(crash recovery, restart resume) is tapped and continues the same session
log. `ChatQueryFactory` params gain `wire?` so the development fixture —
which never spawns a process — can record synthetic `out` frames for each
prompt message and permission answer, and `in` frames for each `SDKMessage`
and permission request it emits (mirroring the real wire shapes). This keeps
the e2e chat suite able to exercise the panel without credentials.

### D5. WebSocket protocol: subscribe first, then page

Additive messages in `src/shared/types.ts`:

| Direction | Message | Purpose |
|-----------|---------|---------|
| client → server | `chat-debug-open { sessionId }` | subscribe to live frames and request the newest page |
| client → server | `chat-debug-page { sessionId, beforeSeq }` | request the page older than `beforeSeq` |
| client → server | `chat-debug-close { sessionId }` | unsubscribe |
| server → client | `chat-debug-frames { sessionId, frames, hasOlder?, page? }` | page reply (`page: true`, `hasOlder`) or live batch |

`ChatConnections` handles them alongside the `chat-*` messages: on open it
subscribes the connection *before* starting the async page read, then sends
the page. Live frames are batched per connection on the same zero-delay
flush used for chat events, capped per batch. Clients merge frames by `seq`
(dedupe, keep sorted), so overlap between the page and early live frames is
harmless and reconnect simply re-sends `chat-debug-open`. Page size is 200.
Connections without an open debug view are never subscribed, so they receive
no frames. `disconnect` drops debug subscriptions too.

*Alternative considered*: a `GET /api/chat/:id/wire` route for history. No
stronger access control than the WebSocket and it splits one feature across
two transports; rejected.

### D6. Client panel

- New `src/client/stores/chatDebugStore.ts`: per session `{ open, frames
  (sorted by seq, deduped), hasOlder, loadingOlder }`, `merge`, `setOpen`.
  Loaded frames are capped at 5,000 per session in memory, dropping the
  oldest and re-enabling "Load older".
- `ChatView` header gets a **Debug** toggle (`aria-pressed`). Opening sends
  `chat-debug-open` (re-sent on `connectionEpoch` change while open);
  closing sends `chat-debug-close`. Default is off on each page load.
- New `src/client/components/chat/ChatDebugPanel.tsx`: on `md+` a right-hand
  split beside the transcript; below `md` it replaces the transcript area
  with a back control. Rows show a direction badge (→ to Claude, ← from
  Claude, stderr, lifecycle), local time with ms, seq, and type label.
  Expanding shows `JSON.stringify(parsed, null, 2)` in a `<pre>` (raw text if
  unparseable) and a Copy button that copies `raw`. "Load older" at the top
  sends `chat-debug-page` with the lowest loaded seq. Auto-scroll follows the
  tail only while the user is at the bottom. Rows are collapsed by default so
  token-delta floods stay cheap to render.
- Empty state: "No protocol traffic recorded for this session yet."

## Risks / Trade-offs

- [Custom spawner skips SDK defaults (executable existence check, stderr
  grace before `exit`)] → Missing executable surfaces as the child `error`
  event, which the SDK already maps to a failed query; the tap records
  stderr itself, so the "stderr tail in exit errors" nicety is replaced by
  `stderr` frames. Covered by the existing real-SDK e2e (`chat-real.spec.ts`)
  plus a unit test spawning a small script.
- [Bun's `node:child_process`/stream compatibility] → The SDK's own default
  spawn already uses these APIs under Bun; the tap adds only `Transform`,
  `Writable`, and `StringDecoder`. Unit tests run under Bun.
- [Disk growth: 32 MiB × many sessions] → Kill deletes logs, orphan pruning
  on startup, per-session cap. Long-lived sessions stay bounded.
- [Write amplification from token deltas] → Batched async appends on the
  next tick; capture never blocks the SDK stream.
- [Sensitive content at rest] → Same exposure as `~/.claude/projects/*.jsonl`;
  environment excluded; files created with mode `0600` and directory `0700`.
- [Paging reads whole files (≤32 MiB)] → Acceptable for a debug view;
  paging requests are user-initiated. Can be replaced by a seq→offset index
  later without protocol changes.
- [Large client memory with many frames] → 5,000-frame client cap and
  collapsed rows.

## Migration Plan

Additive. Sessions created before deploy have no log until their next turn
spawns a tapped process; their panel shows the empty state until then.
Rollback: revert the change; leftover `chat-wire/` files are inert and can be
deleted manually.

## Open Questions

- Whether to add a "hide `stream_event` frames" filter or text search to the
  panel; deferrable UI polish that does not change capture or protocol.
