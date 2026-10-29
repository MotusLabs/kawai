# Design

## Context

See proposal.md, Why. `ChatSessionManager` keeps one history memo per chat
(`snapshotHistory`).

- The memo is taken before the agent's first start and dropped only on kill.
  Snapshots are the memo plus `liveEvents`.
- Two loaders fill it:
  - `loadHistory`: async and single-flight. Attach and history paging await
    it.
  - `captureHistory`: synchronous. It calls `getHistory`, which is
    `replayTranscriptFile` or `replayCodexRollout`, both `readFileSync` plus a
    whole-content parse.
- `send`, `start`, and the mailbox's `prepare` callback are all `async`, yet
  they call `captureHistory`. A `prepare` for a chat that nobody has opened
  therefore runs the full synchronous read.
- async-transcript-parsing D4 kept that synchronous fallback for "callers
  that must capture before a driver starts without an await". None of the
  current starters is such a caller.
- Both parsers (`parseTranscriptContent`, `parseCodexRollout`) are a single
  pass over `content.split('\n')`. Codex row ids are
  `codex-r<line index>-<sha256(line)[0..8]>`.

## Goals / Non-Goals

**Goals:**

- No agent start blocks the event loop on reading or parsing history.
- Peak memory while loading is no longer several times the file size: no
  whole-file string and no line array.
- Events, ids, the order, and the memo rule (content from before the start,
  never duplicated with live events) stay exactly as they are.

**Non-Goals:**

- Holding fewer events in memory. The memo still holds the whole history;
  a windowed load that keeps only the recent 24 hours is a separate change.
- Chat search's transient replay, mail-receipt transcript reads, and the log
  poller (`bounded-log-reads-and-task-get`).

## Decisions

### D1 — Every agent start awaits the async load

`send`, `start`, and `prepare` call `await this.loadHistory(id)` where they
call `captureHistory(id)` today, before `ensureDriver`/`driver.start()`.
`loadHistory` is single-flight per session, so concurrent starters share one
load. Each one starts or reuses the one driver only after that load resolves.
The memo therefore holds file content read before any driver of this process
appended to it.

- While a load is in flight, no starter proceeds; every starter awaits it.
- A driver already running means the memo already exists, because the memo
  is taken before every start and dropped only with the driver on kill.
- The Codex retry rule (`canRetryCodexMemo`: retry only while no live
  events exist) is unchanged.
- The kill check after the await stays: a session killed mid-load writes no
  memo, and its starter returns the usual "session not found" result.

`getSnapshot` and `getHistoryPage` keep their synchronous `captureHistory`.
Their callers already await `loadHistory`, so for them it is a no-op guard.
The guard gets a debug log for the case where it ever reads the file, so a
caller that skips the await shows up.

*Alternative:* keep the synchronous capture and move the parse into a
worker. Rejected: it still copies the whole file, and it adds a thread for
what an await already solves.

### D2 — Line-at-a-time parsers fed by a chunked reader

The chunk splitter from `transcriptMeta.ts` (bounded-boot-restore D2) is
extracted into `readLines(file, onLine)`.

- It reads 1 MiB chunks and calls `onLine(line, index)` with each decoded
  line, carrying the partial line between reads (copied).
- It yields to the event loop after each chunk (`await` on the next read).
- `parseTranscriptContent` and `parseCodexRollout` become thin wrappers over
  stateful line consumers (`createTranscriptParser`, `createRolloutParser`)
  that accept one line at a time. The string entry points stay, for callers
  and tests that hold a string, and feed the same consumer from
  `content.split('\n')`.
- `replayTranscriptFileAsync` and `replayCodexRolloutAsync` feed the
  consumers from `readLines`. The Codex line index is the reader's index, so
  ids are unchanged.
- An unreadable file keeps today's `historyUnavailable` mapping: ENOENT
  reads as `missing`, anything else as `unparseable`.

*Alternative:* `readline` over a stream. Rejected: it decodes every line
into a string through an extra layer and gives no control over chunk size;
the splitter already exists and is tested.

**Dependency:** D2 reuses `bounded-boot-restore`'s splitter. Land that change
first; if it is not merged, extract the splitter here.

## Acceptance oracles

### Table S — start paths (real manager, fixture query factory)

| id | starter | memo | load in flight | observable result |
|---|---|---|---|---|
| S1 | send / start / prepare | absent | no | the history is read once through the async reader; the driver starts after the load; no synchronous read |
| S2 | any | present | — | no read; the driver starts or is reused |
| S3 | send while prepare's load is in flight | absent | yes | one read; one driver; the transcript shows the earlier conversation once, then the new turn |
| S4 | any | absent | yes, then kill | no memo written; the starter returns its not-found result |
| S5 | Codex, memo marked retryable, no live events | retryable | no | the memo is re-read once (today's D8/M3 rule) |
| S6 | Codex, memo marked retryable, live events present | retryable | — | no re-read |

For prepare, the not-found result is the mailbox dispatcher's
`Recipient disappeared` failure: the kill dead-letters the queued mail, which
is never claimed or pushed.

Unreachable: memo absent while a driver is running. The memo is taken before
every start, and only kill drops it, together with the driver.

### Property P1 — streamed parse parity

For any content, the async file replay's events equal the string parser's
events for the same content: deep-equal, including ids and order. This is
checked for both runtimes.

- Generator: seeded lines drawn from each parser's row kinds, plus torn
  JSON, blank lines, `\r\n`, multibyte text, and lines longer than the chunk
  or ending within 10 bytes of a chunk boundary.
- Seams: the real file system.
- Seeds: `0xb0a7` for Claude transcripts and `0xb0a7 ^ 0xc0de` for Codex
  rollouts, 50 cases each.

### Property P2 — no synchronous read on start

Under S1–S3, a spy on `fs.readFileSync` records no read of the history file.
Seeded orders of send, start, and prepare are run concurrently: seed
`0x57a7`, 30 sequences.

## Risks / Trade-offs

- [The first message to a chat with a huge history now waits for the load,
  seconds instead of a frozen server] → This is the intended trade. Whether
  the composer or activity row needs a loading state during that wait is
  checked in task 1.4.
- [A starter added later forgets the await] → The guard's debug log, plus
  the P2 spy over every starter.
- [Event memory is still proportional to history] → Stated as a non-goal and
  named in the proposal as follow-up work.

## Migration Plan

None. No stored data or protocol change. Roll back by reverting.
