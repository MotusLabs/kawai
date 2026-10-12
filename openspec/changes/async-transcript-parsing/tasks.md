# Tasks

Each task ends with `bun run lint && bun run typecheck && bun run test` green and a commit
(matching message below); tick the checkbox in the same commit.

## 1. transcriptReplay: single-pass meta + async IO

- [x] 1.1 Add `readTranscriptMeta(filePath)` (one read + one parse, returns
  `{ title, cwd }`) and async mirrors `findTranscriptPathAsync` and
  `readTranscriptMetaAsync` over `fs/promises` in `src/server/chat/transcriptReplay.ts`;
  add `replayTranscriptFileAsync` wrapping the existing parse with async read. Keep the
  sync exports intact for non-boot callers; unit-test the meta reader against a fixture
  transcript (title present/absent, cwd present/absent, unreadable file)
- [x] 1.2 Audit every caller of the sync fns (`ChatSessionManager`, `ChatConnections`,
  `transcriptTitleWatcher`, `chatWorkerTranscript`, tests): non-boot callers keep sync with
  an in-code note why; commit (`feat: single-pass transcript meta reader and async io`)

## 2. Async restore + attach awaits

- [x] 2.1 `ChatSessionManager`: make `restorePersisted` async (per-row discovery + single
  meta pass, same title/cwd/worker-roster catch-up), kick it off un-awaited from the
  constructor, expose `whenRestored(): Promise<void>`; add a memoized async
  `loadHistory(sessionId)` over `replayTranscriptFileAsync` (retain until kill alongside
  live events, matching the audited `snapshotHistory` semantics noted in-code)
- [x] 2.2 `ChatConnections` chat-attach path: `await manager.whenRestored()` then
  `await manager.loadHistory(sessionId)` before snapshot assembly; nothing else in the
  ordering changes; update tests that construct the manager and immediately assert restored
  rows to await `whenRestored()`
- [x] 2.3 Run the full suite (chatSessionManager, chatConnections, chatTranscriptReplay,
  chatRename.integration must all pass); commit
  (`refactor: restore chat transcripts off the event loop`)

## 3. Race test + close-out

- [x] 3.1 Add the race test: a `chat-attach` concurrent with a live `assistant_delta` still
  yields the delta after the snapshot (pin the D3 invariant)
- [x] 3.2 Mark S6 done in `docs/refactor-analysis/synthesis.md` under a new P1/S6 status
  note with commit hashes, mirroring the P0/S2/S1 notes; commit
  (`docs: mark P1/S6 complete in refactor synthesis`)

## Workflow follow-up

- Merge `async-transcript-parsing` to master after review (user decision), then archive the
  change via the archive workflow.
