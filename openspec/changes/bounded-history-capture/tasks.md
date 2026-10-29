# Tasks

Mutants (one-line edits; at most five per round):

| id | file | mutation |
|---|---|---|
| H1 | `ChatSessionManager.ts` | `prepare` keeps the synchronous `captureHistory` |
| H2 | `ChatSessionManager.ts` | `send` starts the driver before awaiting `loadHistory` |
| H3 | `ChatSessionManager.ts` | the post-await kill check in `loadHistory` dropped |
| H4 | line reader | the partial line is not copied across reads |
| H5 | `codexRollout.ts` | the line index counts only non-blank lines |

## 1. Starts await the async load (D1)

- [x] 1.1 Make `send`, `start`, and the mailbox `prepare` await
  `loadHistory` before the driver starts.
  - Verify: the Table S rows S1–S6 pass as table-driven tests against the
    real manager. H1, H2, and H3 are each killed.
  - Result: S1–S4 in `chatStartHistoryLoad.test.ts` (prepare driven by
    direct human mail); S5 in `codexRolloutReplay.integration.test.ts`; S6 is
    that file's existing mid-turn load test, the load every starter now
    awaits. H1 killed by S1 prepare, S3, and P2; H2 by S1 send and S4 send;
    H3 by both S4 rows. A start with the memo still synchronous fails S5.
- [x] 1.2 Add property P2 (seed `0x57a7`, 30 sequences).
  - Verify: no `readFileSync` of a history file under any sequence. H1 and
    H2 are killed.
  - Result: P2 kills H1. It cannot kill H2: H2 only reorders the awaited
    load after the driver start and reads nothing synchronously, so a
    `readFileSync` spy is blind to it. S1 and S4 kill H2 instead.
- [x] 1.3 Add a debug log to the synchronous `captureHistory` guard when it
  reads a file, and update the async-transcript-parsing D4 note in
  `docs/architecture/chat.md`.
  - Verify: a test that skips the await sees the log line, and the doc names
    the guard.
  - Result: no architecture bullet described the async load, so the note is
    a new "History loads" bullet in `docs/architecture/chat.md`.
- [x] 1.4 Check whether the client shows anything while a send waits on a
  long load.
  - Verify: if it shows nothing, record that in the result and propose the
    UI change separately. No UI change is made here.
  - Result: it shows nothing. The composer clears on submit and no bubble or
    activity row appears until `send` resolves, since both come from the
    driver. A UI send always follows an attach, which awaits the same load
    before its snapshot, so the wait is visible only for a send typed before
    the first snapshot (an empty transcript with the composer enabled). The
    UI change (a loading state until the first snapshot) is proposed
    separately.

## 2. Streamed parsers (D2)

- [x] 2.1 Extract `readLines` from `transcriptMeta.ts` (or add it here if
  bounded-boot-restore has not merged).
  - Verify: `chatTranscriptMetaScan.test.ts` still passes, and `readLines`
    has its own boundary tests (a line straddling a chunk, a final line
    without `\n`, `\r\n`). H4 is killed.
  - Result: `lineReader.ts` (`scanLines`, `readLines`). The partial line is
    kept as copied pieces and joined once its newline arrives, so a line many
    chunks long is copied once, not once per read. H4 (pieces not copied) is
    killed by `lineReader.test.ts` and P1.
- [x] 2.2 Split `parseTranscriptContent` and `parseCodexRollout` into line
  consumers with string wrappers, and route the async replays through
  `readLines`.
  - Verify: property P1 (seed `0xb0a7`, 50 cases per runtime) passes, and
    the existing replay tests pass unchanged. H4 and H5 are killed.
  - Result: P1 in `streamedParseParity.test.ts` compares the async file
    replay with the sync string replay, and `readLines` at small chunk sizes
    with the string parser. H5 is killed by its Codex case.
    `chatAsyncRestore.test.ts` now counts `fsp.open`, since the streamed
    replay never calls `readFile`, and its attach race lets only the
    attach's own load race.

## 3. Integration

- [x] 3.1 Annotate the tests with `@covers` for the three delta scenarios.
  - Verify: `specCoverageGuard.test.ts` passes.
- [x] 3.2 Run `bun run check` on the clean committed tree.
  - Verify: a recorded full pass.
  - Result: pass record `3b2f4c95` for the tree of `8f66559b`.
- [x] 3.3 Re-run the scratch boot against a copy of the live data, with a
  Codex stub that passes the version check and then idles.
  - Verify: no request waits longer than 1 s while the 1.2 GB rollout
    loads, and the server's RSS stays under 1 GB and its JS heap under
    256 MB during the load (today: 4.4 GB). Restated by the human on
    2026-10-29 from "peak RSS below 2× the parsed events' size", which no
    parse change can meet (see the allocator note below).
  - Result (2026-10-29): passes as restated — longest request 553 ms, RSS
    690 MB, heap 128 MB. Scratch
    copy of the live data with the leftover claim settled, Codex stub,
    attach to the 1.2 GB rollout's chat; a CPU profile places each stall.
    - Latency holds for this change's path: during the streamed load
      (profile window of `codexRollout` `line` frames) no health probe took
      over 553 ms. The probes over 1 s before it are boot work (git and
      `openspec list` spawns, session-directory upserts); a control run
      attached to no chat shows them too.
    - Memory: the parsed events retain 19 MB of heap (7,261 events). The
      server's RSS rose from about 190 MB to about 690 MB during the load,
      against 4.4 GB before. The 500 MB is transient garbage from the
      rollout's 237 lines over 1 MiB (937 MB in all, the largest 12.5 MB),
      each copied, decoded, and parsed whole; a standalone replay peaks at
      596 MB and settles at 81 MB after GC. So the peak is far below the old
      one but is not below 2× the retained events.
    - The gap is allocator retention, not live data. A trace of the
      standalone replay every 100 MB read shows the JS heap at most 128 MB
      while RSS climbs to 619 MB, then falls to 85 MB at the end. GC hints
      every 64 MB of lines change nothing (689 MB); every 16 MB they reach
      462 MB at 2.7× the time. No parse change brings RSS under 2× the
      events, so the clause was restated as above.
    - The 10.5–14.8 s stall right after the load is outside this change. The
      profile puts about 4 s in the transcript tail's catch-up
      (`transcriptTitleWatcher.ts` `readAppended`): on agent start it reads
      the whole 1.2 GB rollout into one buffer and string, splits it, and
      runs `codexReceiptMessageId` on every line, which also takes the
      server to 5.3 GB. The other ~11 s is uncached profile-catalog
      resolution on the mailbox recipient sweep (`providerOf`,
      `sessionCooldown`), which `catalog-resolution-cache` removes. The
      control run with no attach stalls the same way (14.2 s, 5.6 GB) when
      mail delivery starts the chat. The tail's catch-up and the receipt
      reads go to the separate `bounded-receipt-reads` proposal.
- [x] 3.4 Map every oracle id (S1–S6, P1, P2) to a test title and each
  mutant to its killing test.
  - Verify: the map has no gap.
  - Result:

    | id | test |
    |---|---|
    | S1 | `chatStartHistoryLoad.test.ts` › `S1 {send,start,prepare} reads the history once, asynchronously, before the driver starts` |
    | S2 | `chatStartHistoryLoad.test.ts` › `S2 {send,start,prepare} with the memo present reads nothing` |
    | S3 | `chatStartHistoryLoad.test.ts` › `S3 a send while prepare’s load is in flight shares it: one read, one driver, the history once` |
    | S4 | `chatStartHistoryLoad.test.ts` › `S4 a kill during {send,start}’s load writes no memo and {send,start} reports the session gone` |
    | S5 | `codexRolloutReplay.integration.test.ts` › `S5 a start with a retryable memo and no live events re-reads the rollout once, asynchronously` |
    | S6 | `codexRolloutReplay.integration.test.ts` › `a retryable memo and live events coexist while the rollout reads EISDIR — a mid-turn load keeps the memo` |
    | P1 | `streamedParseParity.test.ts` › `Claude transcripts: …` and `Codex rollouts: the streamed replay equals the string parse` |
    | P2 | `chatStartHistoryLoad.test.ts` › `P2 seeded concurrent starters never read a history file synchronously` |
    | H1 | S1 prepare, S3, P2 |
    | H2 | S1 send, S4 send |
    | H3 | S4 send, S4 start |
    | H4 | `lineReader.test.ts` (chunk 1, 3, 7 cases), P1 |
    | H5 | P1 Codex case |

## Workflow follow-up

- Land after `bounded-boot-restore`, which supplies the chunk splitter.
- Push and open the PR when the human asks.
