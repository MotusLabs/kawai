# Proposal

## Why

Starting a chat agent through send, start, or the mailbox's delivery
preparation still reads and parses the chat's whole history file
synchronously, on the event loop. This applies to both the Claude transcript
and the Codex rollout. On 2026-10-29, a boot against a copy of the live data
started a Codex chat whose rollout is 1.2 GB. The server blocked requests for
15 s and grew to 4.4 GB. The file is read into one string, split into a
second array copy, and only then parsed. Attach and history paging already
use the async load (async-transcript-parsing D3), but the start paths kept
the synchronous fallback, and that fallback is the one mail delivery hits.

## What Changes

- Every path that starts an agent (send, start, mailbox delivery
  preparation) awaits the single-flight async history load before the driver
  starts, instead of the synchronous capture. The memo rule is unchanged: it
  is taken once before the first start and holds file content from before
  that start.
- Replay of Claude transcripts and Codex rollouts parses line by line from
  bounded chunks, yielding to the event loop between chunks. It never holds
  the file as one string. The events are identical to today's parse,
  including Codex row ids (line index plus line hash).
- The synchronous whole-file replay leaves the start paths. It stays only
  where a caller cannot await, and this change names each such caller.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `chat-sessions`: adds a requirement that the server keeps answering while
  a chat's history loads for an agent start, whatever the history's size, and
  that the history shown is unchanged.

## Impact

- `src/server/chat/ChatSessionManager.ts`: `send`, `start`, the mailbox
  `prepare` callback, `captureHistory` / `loadHistory`, `getHistory`.
- `src/server/chat/transcriptReplay.ts` and
  `src/server/chat/codex/codexRollout.ts`: line-at-a-time parsers fed by a
  chunked reader. The chunk splitter is shared with `transcriptMeta.ts` from
  `bounded-boot-restore`.
- Not covered: chat search's transient replay, mail-receipt transcript
  reads, and memory for the parsed events themselves. A windowed history load
  that keeps only the recent window in memory is a separate change.
