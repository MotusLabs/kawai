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

- [ ] 1.1 Make `send`, `start`, and the mailbox `prepare` await
  `loadHistory` before the driver starts.
  - Verify: the Table S rows S1–S6 pass as table-driven tests against the
    real manager. H1, H2, and H3 are each killed.
- [ ] 1.2 Add property P2 (seed `0x57a7`, 30 sequences).
  - Verify: no `readFileSync` of a history file under any sequence. H1 and
    H2 are killed.
- [ ] 1.3 Add a debug log to the synchronous `captureHistory` guard when it
  reads a file, and update the async-transcript-parsing D4 note in
  `docs/architecture/chat.md`.
  - Verify: a test that skips the await sees the log line, and the doc names
    the guard.
- [ ] 1.4 Check whether the client shows anything while a send waits on a
  long load.
  - Verify: if it shows nothing, record that in the result and propose the
    UI change separately. No UI change is made here.

## 2. Streamed parsers (D2)

- [ ] 2.1 Extract `readLines` from `transcriptMeta.ts` (or add it here if
  bounded-boot-restore has not merged).
  - Verify: `chatTranscriptMetaScan.test.ts` still passes, and `readLines`
    has its own boundary tests (a line straddling a chunk, a final line
    without `\n`, `\r\n`). H4 is killed.
- [ ] 2.2 Split `parseTranscriptContent` and `parseCodexRollout` into line
  consumers with string wrappers, and route the async replays through
  `readLines`.
  - Verify: property P1 (seed `0xb0a7`, 50 cases per runtime) passes, and
    the existing replay tests pass unchanged. H4 and H5 are killed.

## 3. Integration

- [ ] 3.1 Annotate the tests with `@covers` for the three delta scenarios.
  - Verify: `specCoverageGuard.test.ts` passes.
- [ ] 3.2 Run `bun run check` on the clean committed tree.
  - Verify: a recorded full pass.
- [ ] 3.3 Re-run the scratch boot against a copy of the live data, with a
  Codex stub that passes the version check and then idles.
  - Verify: no request waits longer than 1 s while the 1.2 GB rollout
    loads, and peak RSS stays below 2× the parsed events' size (measured
    against today's 4.4 GB).
- [ ] 3.4 Map every oracle id (S1–S6, P1, P2) to a test title and each
  mutant to its killing test.
  - Verify: the map has no gap.

## Workflow follow-up

- Land after `bounded-boot-restore`, which supplies the chunk splitter.
- Push and open the PR when the human asks.
