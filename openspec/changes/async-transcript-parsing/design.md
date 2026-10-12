# Design

## Context

`restorePersisted` (ChatSessionManager.ts:898) is called synchronously from the constructor
(:432) and loops every `chat_sessions` row: `findTranscriptPath` (recursive readdirSync,
depth 3 over `~/.claude/projects`), then `readTranscriptTitle(filePath)` and
`readTranscriptCwd(filePath)` — each its own `readFileSync` + full `parseTranscriptContent`
pass over the same file. `getHistory` (:544) calls `replayTranscriptFile` synchronously on
first attach (parse #3). `readTranscriptTitle`/`readTranscriptCwd` are also used by
`transcriptTitleWatcher` (live title following) and `chatWorkerTranscript` (worker bodies)
— those calls are per-event, not per-boot, and are NOT the hot path this change targets.

Ordering invariant (from the workers/snapshot designs, restated in the analysis): the initial
`chat-snapshot` a client receives on attach must precede any live event for that session;
`ChatConnections` already sequences `liveEvents` after the snapshot send, and `captureHistory`
runs before driver `start()`.

## Goals / Non-Goals

**Goals:**

- Zero synchronous filesystem work for transcript discovery/parsing on the main thread at
  boot and at first attach.
- One parse pass per transcript where today there are two (title + cwd).
- Preserve the snapshot-before-live-events invariant exactly, including reconnect and
  restart-restore flows.

**Non-Goals:**

- No worker thread (the parse is pure CPU over file content but boot volumes are tens of
  files, not thousands; async IO + single-pass reads remove the event-loop stalls. A worker
  remains a future option if transcripts grow orders of magnitude).
- No changes to transcript parsing semantics, title-adoption policy, or cwd persistence.
- Bounding/folding `liveEvents` into `snapshotHistory` (P1-3 item 4) — a separable memory
  change with its own invariant; follow-up change if wanted.
- The per-event readers used by the title watcher and worker-body reader stay as they are
  unless the compiler forces a mechanical await.

## Decisions

### D1: Single-pass meta reader, async IO

`readTranscriptMetaAsync(filePath): Promise<{ title, cwd }>` reads the file once
(`fs/promises.readFile`) and runs one `parseTranscriptContent` pass, returning both fields;
`findTranscriptPathAsync` mirrors `findTranscriptPath` over `fs.promises.readdir`
(withFileTypes) + `stat`. The existing sync functions stay exported for their non-boot
callers; `restorePersisted` and attach-history stop calling them.

### D2: restorePersisted is async and does not block the server boot

The constructor kicks off `void this.restorePersisted()` and records the in-flight promise
(`this.restored`); `restorePersisted` iterates rows with `await` per session (discovery +
meta in one pass), applying the same title/cwd catch-up and worker-roster recovery per row.
The promise is awaited at the attach boundary (D3), so chat rows are guaranteed present
before the first snapshot needs them, while the server's HTTP/WS loop starts immediately.
Rejected alternative: `await restorePersisted()` before `Bun.serve` — recreates the boot
stall this change removes.

### D3: chat-attach awaits restored sessions, then memoized history

`ChatConnections`'s `chat-attach` path becomes: `await manager.whenRestored()` (resolves the
D2 promise; also covers restart-restore), then `await manager.loadHistory(sessionId)` —
an async memoized wrapper over `replayTranscriptFileAsync` (memo per session, retained alongside live events) — then snapshot assembly as today. `getSnapshot`'s synchronous assembly
contract is untouched: only the two awaits are inserted ahead of it, and `liveEvents` are
already sequenced after the snapshot send, so the invariant holds by construction. The
existing `captureHistory`-before-`start()` ordering is preserved because both happen after
these awaits.

### D4: Mechanical caller migration only where boot/attach paths change

`getHistory`'s sync signature is kept for its non-attach callers (if any remain after the
audit) and implemented over the memo; the attach path never calls it synchronously. Each
remaining sync-fs caller gets an in-code note naming why sync is acceptable there.

## Risks / Trade-offs

- [Snapshot ordering regresses on reconnect] → Mitigation: D3 awaits precede assembly and
  the existing liveEvents-after-snapshot sequencing is untouched; new race test (attach
  concurrent with assistant_delta) pins it; `chatSessionManager.test.ts` snapshot suite runs
  per commit.
- [Chat rows appear a tick after boot] → Accepted: bounded by restorePersisted's completion;
  attach awaits it, so no client can observe a missing chat it is attaching to. The
  session-list broadcast fires as rows land, same as today's sequential restore.
- [Memoized history serves stale events] → Mitigation: the audit confirms history is
  captured before each driver starts, and subsequent turns are carried by `liveEvents`.
  Keep the memo until kill; invalidating at turn completion would duplicate live turns.
  A synchronous capture wins over a delayed async load, including its cwd catch-up.
- [A transcript disappears during discovery] → Skip failed stat calls and continue
  searching; one missing candidate must not abort restoration of the remaining sessions.
- [Parsing blocks the event loop] → File IO is asynchronous, but JSON parsing still runs
  on the event loop. Worker-based CPU parsing is outside this change.
- [Test churn in the 3,006-line chatSessionManager suite] → Constructor-time restore becomes
  async; tests that construct the manager and immediately assert restored rows must await
  `whenRestored()` — a mechanical, reviewable diff.

## Migration Plan

Single branch `async-transcript-parsing`, three commits (meta reader + async IO; async
restore + attach awaits; race test), each with the full suite green; rollback is revert.
No data, protocol, or config changes.

## Open Questions

None blocking.
