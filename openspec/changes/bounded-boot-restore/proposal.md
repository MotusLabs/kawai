# Proposal

## Why

After a restart the server stopped answering for 15–20 minutes, peaking at
about 10 GB RSS. Release 1.0.0-3098 was installed at the 2026-10-28 18:21 UTC
reboot, and from then on every reboot hung the same way. A CPU profile
pins the cause on boot restore. For each of the 589 persisted chat rows
(577 of them archived), boot walks the whole Claude projects tree
(920 directories, 750 transcripts, 3.1 GB). It then reads the row's
transcript into one string and JSON-parses every line, only to learn the
title and the last working directory. One archived transcript alone is
552 MB. The cost grows with history, not with code changes: the 3056 boot
showed the same 1,003 s gap. Separately, every mailbox pass walks the tree
again for each live candidate's transcript-exists check.

## What Changes

- Boot restore discovers transcripts with one asynchronous walk of the
  projects tree that indexes every transcript file, instead of one walk per
  row. The index chooses the same copy as the existing lookup: the newest
  duplicate, with the same depth limit.
- The title and working directory come from a chunked streaming scan.
  It decodes only title rows and parses only the cwd candidates it needs,
  newest first. The answers match the full parse exactly, and memory stays
  bounded by the chunk and the longest candidate line, not by the file.
- Live (non-archived) chats still adopt their transcript's title and cwd
  before restore completes. Archived chats register at once with their
  stored name and path, then catch up afterwards, one transcript at a time.
  The catch-up skips a row that changed in the meantime. A user-set name is
  never replaced.
- The start blocker's transcript-exists check reuses a known existing path
  and walks again only when that path is gone. A missing transcript is never
  cached, so a restored file is seen at once.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `chat-sessions`: adds a requirement that the server keeps serving while it
  restores persisted chats, whatever the size of their transcripts, and that
  archived chats catch up on titles and paths after restore.

## Impact

- `src/server/chat/ChatSessionManager.ts`: `restorePersisted`, `restoreRow`,
  the new `catchUpArchived` pass, and `startBlocker`.
- New `src/server/chat/transcriptMeta.ts` (`scanTranscriptMeta`) and
  `src/server/chat/transcriptLocator.ts` (`indexTranscripts`,
  `TranscriptPathCache`).
- `src/server/chat/transcriptReplay.ts`: extracts `recordCwd`, shared by the
  full parse and the scan.
- `docs/architecture/chat.md`: a Boot restore bullet.
- No schema, protocol, or client change. Archived chats can show a stale
  generated title or path for a short time after boot, until the catch-up
  reaches them.
