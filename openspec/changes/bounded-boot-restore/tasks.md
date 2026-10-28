# Tasks

Mutants named below (each is a one-line edit; run at most five per round,
following the mutation-testing scope rule):

| id | file | mutation |
|---|---|---|
| M1 | `transcriptMeta.ts` | drop the `isMeta`/`isSidechain` filter in `newestCwd` |
| M2 | `transcriptMeta.ts` | latest title wins whatever its source (manual no longer terminal) |
| M3 | `ChatSessionManager.ts` | `restoreRow(..., true)` for every row (archived scanned inline) |
| M4 | `transcriptMeta.ts` | `carry = data.subarray(lineStart)` (partial line not copied) |
| M5 | `transcriptLocator.ts` | duplicates keep the first copy found |
| M6 | `ChatSessionManager.ts` | drop the `records.get(id) !== registered` check in `catchUpArchived` |
| M7 | `transcriptLocator.ts` | `existing` remembers a miss |
| M8 | `transcriptLocator.ts` | `existing` returns a remembered path without `exists` |

## 1. Transcript discovery (D1, D4)

- [x] 1.1 Add `indexTranscripts` and `TranscriptPathCache` in
  `src/server/chat/transcriptLocator.ts`.
  - Verify: `chatTranscriptLocator.test.ts` passes. L1–L6 and K1–K4 hold.
    M5 is killed (recorded 2026-10-28).
- [x] 1.2 Commit Tables L and K verbatim as table-driven tests (one `test`
  per oracle id, titled with the id), plus property P2 (seed `0x1de5`, 40
  cases).
  - Verify: the file passes. M5, M7, and M8 are each killed, with the
    killing test title recorded per mutant.

## 2. Streaming meta scan (D2)

- [x] 2.1 Extract `recordCwd` in `transcriptReplay.ts` and use it in
  `parseTranscriptContent`. Add `scanTranscriptMeta` in
  `src/server/chat/transcriptMeta.ts`.
  - Verify: `chatTranscriptMetaScan.test.ts` passes, including P1 (seed
    `0x5eed`, 60 cases). M4 is killed (recorded 2026-10-28).
- [x] 2.2 Commit Tables T and C verbatim as table-driven tests, titled by
  oracle id.
  - Verify: the file passes. M1 (C3, C4, P1), M2 (T3, P1), and M4 (C7, T5)
    are each killed, with titles recorded.

## 3. Boot restore and catch-up (D1, D3, D4)

- [x] 3.1 Make `restorePersisted` build the index lazily, scan only live
  rows inline, defer archived rows to `catchUpArchived`, seed the path
  cache, and switch `startBlocker` to it.
  - Verify: `chatBootRestoreCatchUp.test.ts` passes (B1, B2, B3, B5), and so
    do `chatContextExhaustedFlag.test.ts` and `chatSessionTasks.test.ts`
    (synchronous registration).
- [x] 3.2 Add the B4 test: an archived row renamed or restored before its
  catch-up keeps the change.
  - Verify: M6 is killed.
- [x] 3.3 Make B2's "listed at `whenRestored()` with the stored name"
  deterministic. Hold the archived scan behind a test seam, or assert that
  the archived transcript was not opened before `whenRestored()` resolved.
  - Verify: M3 is killed.
- [x] 3.4 Add B6: rows without an SDK id, or whose transcript is not
  indexed, register with stored values.
  - Verify: the test passes and the new branches are covered.
- [x] 3.5 Annotate the tests with
  `// @covers: chat-sessions › <requirement> › <scenario>` for every
  scenario in this change's delta spec.
  - Verify: `scripts/__tests__/specCoverageGuard.test.ts` passes.

## 4. Documentation

- [x] 4.1 Add the Boot restore bullet to `docs/architecture/chat.md`.
  - Verify: the bullet names `indexTranscripts`, `scanTranscriptMeta`, the
    deferred archived pass, and `TranscriptPathCache`.
- [x] 4.2 Point the bullet's change tag at `bounded-boot-restore`. It
  currently cites async-transcript-parsing D2.
  - Verify: `grep -n 'bounded-boot-restore' docs/architecture/chat.md`
    matches.

## 5. Integration

- [x] 5.1 Run `bun run check` on the clean committed tree.
  - Verify: a recorded full pass for HEAD's tree.
- [x] 5.2 Map every oracle id (T1–T5, C1–C9, L1–L6, K1–K4, B1–B6, P1, P2)
  to a test title, and each mutant M1–M8 to the test that killed it, in the
  result.
  - Verify: the map has no gap.
- [x] 5.3 Boot the built server against a copy of the live data directory
  (scratch `HOME` holding a copy of `~/.agentboard` and the projects tree).
  - Verify: the server answers within 10 s of start, and boot restore and
    the archived catch-up stay bounded in memory and CPU.
  - Result, 2026-10-29: first 200 at 8.2 s. The archived catch-up ran at
    45–55 s with a small CPU share and no memory growth.
  - Out of scope, tracked separately: a 4.4 GB, 15 s stall from a Codex
    agent start reading its whole rollout (`codex-rollout-streaming-history`),
    and cooldown checks re-parsing the profile catalogs
    (`profile-catalog-read-cache`).

## Workflow follow-up

- Push `fix/boot-transcript-restore` and open the PR when the human asks.
- After merge and release, confirm that the next workspace reboot answers at
  once (kawai.log shows no multi-minute gap after `chat restore`).
- Archive the change. Its scenarios then need `@covers` annotations under
  `openspec/coverage.json`.
