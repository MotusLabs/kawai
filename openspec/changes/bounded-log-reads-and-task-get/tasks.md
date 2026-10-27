# Tasks

Groups 1–2 are the first production path. Groups 3–5 follow under a later task revision, in the Lead's integration order after the architecture split.

## 1. Exclude chat transcripts before content reads (D1)

- [ ] 1.1 Add one shared exclusion check over identity facts: the file-name thread id, then the known or record session id, then the head session id from the existing `extractSessionId` parse.
  - An absent or empty exclude set excludes nothing.
  - Verify: unit rows for each identity source, and for the empty set.
- [ ] 1.2 Apply it in `collectLogEntryBatch` (after the newest-`maxLogs` slice) and `collectLogEntriesForPaths`, before `isCodexSubagent`, `isCodexExec`, `extractProjectPath`, `extractSlug`, and the token read.
  - Verify: the existing `logPollData` tests pass unchanged.
- [ ] 1.3 Apply it in `buildOrphanEntries` before any helper or token read, in `buildLastMessageEntries`, and on the final entry list before `attachLastUserMessage`.
  - Verify: the existing `logMatchWorker` tests pass unchanged.
- [ ] 1.4 Commit table X1–X12 verbatim as a table-driven test through the real match-worker request handler over temp logs, with an observer on every file-open and content-read API.
  - Verify: every row holds, and the test kills mutant M1 (exclusion moved after enrichment).

## 2. Bounded token windows and evidence (D2–D3)

- [ ] 2.1 Replace the token read in `src/server/logmatch/logText.ts` with the one-descriptor reader:
  - head and tail windows of 200 KiB with the one-byte lookbehind, read once when they overlap;
  - `fstat` before and after; honor `bytesRead`; close in `finally`;
  - complete lines only; the 2,000-line tail limit; no whole-file API on any branch.
  - Verify: the existing `logText` tests pass or are updated row by row with the reason journaled.
- [ ] 2.2 Return evidence (`positive`, `empty`, `incomplete`, `unavailable`, and `known` for known sessions, replacing `-1`).
  - Cache only `empty`, keyed by device, inode, size, mtime, mode, and read options.
  - Verify: table E1–E9 committed verbatim through the reader with the all-API observer.
- [ ] 2.3 Make the three gates consume evidence: `getEntriesNeedingMatch` (`logMatchGate.ts`), the orphan gate in `buildOrphanEntries`, and the insert gate with `emptyLogCache` in `logPoller.ts`.
  - Verify: table G1–G5 committed verbatim through each gate.
- [ ] 2.4 Add witnesses O1 and O2 through the real worker and the poller, generated with bounded writes.
  - Verify: both stay eligible and are inserted on an exact match; each fails under mutant M3 (`incomplete` treated as `empty`).
- [ ] 2.5 Add properties P1 (seed `0x6b617761`, 200 cases, including the sparse 1 MiB / 1 GiB pair) and P2 over the same cases.
  - Verify: both pass, P1 kills mutant M2 (a whole-file read restored), and P2 kills M3.

## 3. Bounded `task_get` (D4–D5, later revision)

- [ ] 3.1 Add `AgentTaskDetail`, the journal preview entry, and the bounds types to `src/shared/teamTasks.ts`.
  - Verify: `bun run typecheck`.
- [ ] 3.2 Add the windowed queries to `TaskStore` and `mailboxStore`:
  - journal rows with `length(CAST(text AS BLOB))` and `substr(CAST(text AS BLOB), 1, 2000)`, anchored on `(created_at, rowid)`;
  - newest subtasks and messages with `LIMIT`;
  - the three counts;
  - all in one synchronous read transaction.
  - Verify: store tests over `schemaDb()`, including entries that share a `created_at` and entries holding NUL.
- [ ] 3.3 Give `TaskService.get` the optional agent window, returning `AgentTaskDetail` with the seal applied after.
  - Leave the human `team-task-detail` path on `humanDetail`.
  - Verify: T15 holds.
- [ ] 3.4 Extend the `task_get` schema with `journal_before` and `journal_limit` (integer 1–200, default 50) and the refusal `Unknown journal entry for this task: <id>`.
  - Verify: the `taskTools` tests pass for both arguments.
- [ ] 3.5 Commit table T1–T15 verbatim as a table-driven test through both the Claude (`createMailboxServer`) and the Codex (`dispatchTeamToolCall`) adapters. Refusal rows assert each adapter's own envelope.
  - Verify: the test passes, and with the test-side query observer it kills mutants M4 (windows taken from a full load) and M5 (whole text cut in JavaScript).
- [ ] 3.6 Add property P3 (seed `0x7461736b`, 200 cases).
  - Verify: it passes and kills the mutant "tie-break on `rowid` dropped".

## 4. `task_journal_read` (D6, later revision)

- [ ] 4.1 Add the entry reader to `TaskStore` and `TaskService` (ownership check, then the one `substr` statement), with the trimming and decoding rules of D6.
  - Verify: store and service tests for each D6 rule.
- [ ] 4.2 Register `task_journal_read` in the shared tool table with its schema (`offset_bytes` a safe non-negative integer, default 0) and description.
  - Verify: both adapters list it.
- [ ] 4.3 Commit table R1–R10 verbatim through both adapters, and add property P4 (seed `0x6a726e6c`, 200 cases).
  - Verify: every row holds and the property passes.

## 5. Agent-facing surfaces (D7, later revision)

- [ ] 5.1 Update the `task_get` description, the task note in `teamPrompt.ts`, the delivered header line in `taskContext.ts`, and the task-tools bullet in `AGENTS.md` so none promises the full journal and each names `journal_before`, `journal_limit`, and `task_journal_read`.
  - Verify: the prompt and header tests pass with the new text.
- [ ] 5.2 Update every enumeration test over the task tool names, and confirm the new name composes with tool-metrics normalization without an import cycle.
  - Verify: the enumeration tests pass.

## 6. Integration

- [ ] 6.1 Run `bun run check` on the clean committed tree for each submitted result.
  - Verify: it records a pass.
- [ ] 6.2 Produce the oracle map in each result: every in-scope row of X, E, G, O, T, and R, each of P1–P4, and each of M1–M5, with its test title and killed mutant. Rows belonging to a later revision are listed as deferred.
  - Verify: every id is mapped or deferred. No RSS or memory threshold is claimed.

## Workflow follow-up

- After deploy, ask the live Codex Leads to move to fresh chats, so their oversized rollouts stop growing.
- Archive the change once reviewed and landed.
