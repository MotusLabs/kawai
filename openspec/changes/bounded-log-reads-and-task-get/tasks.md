# Tasks

Groups 1–2 are the first production path. Groups 3–5 follow under a later task revision, in the Lead's integration order after the architecture split.

## 1. Exclude chat transcripts before content reads (D1)

- [x] 1.1 Add one shared staged exclusion check (D1 rows X0–X4):
  - the file-name thread id F, then the stored record or session id R, both without opening the file;
  - then the head session id H from the existing `extractSessionId` parse, only when F and R missed.
  - Stop at the first hit. Known status never skips H. An unresolved H infers no exclusion and fabricates no identity. An absent or empty exclude set disables the filter.
  - Verify: unit rows X0–X4 and the empty set.
- [x] 1.2 Apply it in `collectLogEntryBatch` (after the newest-`maxLogs` slice) and `collectLogEntriesForPaths`, before `isCodexSubagent`, `isCodexExec`, `extractProjectPath`, `extractSlug`, and the token read.
  - Verify: the existing `logPollData` tests pass unchanged.
- [x] 1.3 Apply it in `buildOrphanEntries` before any helper or token read, in `buildLastMessageEntries`, and on the final entry list before `attachLastUserMessage`.
  - A recorded orphan whose path is re-enriched is not K.
  - Verify: the existing `logMatchWorker` tests pass unchanged.
- [x] 1.4 Commit witness WX as a table-driven test through the real match-worker request handler over temp logs, with an observer on every file-open and content-read API.
  - It covers rows X0–X4 for every candidate class (new and known in both collectors, orphan, backfill), the known A / excluded head B witness, and the controls (no set, `maxLogs` order, unexcluded real logs).
  - Verify: every row holds, and the test kills mutant M1 (exclusion moved after enrichment).

## 2. Bounded token windows and evidence (D2–D3)

- [x] 2.1 Replace the token read in `src/server/logmatch/logText.ts` with the one-descriptor reader:
  - head and tail windows of 200 KiB with the one-byte lookbehind, read once when they overlap;
  - `fstat` before and after; honor `bytesRead`; close in `finally`;
  - complete lines only; the 2,000-line tail limit; no whole-file API on any branch.
  - Verify: the existing `logText` tests pass or are updated row by row with the reason journaled.
- [x] 2.2 Return evidence K / U / C(n) / P(n) (D3), with K replacing `-1`.
  - C(n) requires both stable physical coverage and complete logical accounting.
  - Any failed predicate gives P(n), including a positive observed before a short read or generation change.
  - Carry the evidence kind and generation facts through the worker output.
  - Verify: table WE (E1–E11) committed verbatim through the reader with the all-API observer and independent generator truth.
- [x] 2.3 Make the three gates consume evidence per rows G0–G6: `getEntriesNeedingMatch` (`logMatchGate.ts`), the orphan gate in `buildOrphanEntries`, and the insert gate in `logPoller.ts`.
  - Rework both empty caches to the D3 admission and reuse rules: `zeroTokenLogCache` in `logText.ts`, and in `logPoller.ts`:
    - remove the unconditional size-cache skip at 818–820;
    - stop the no-session-id write at 833–836;
    - admit only `C(0)` at 907–909.
  - Verify: tables WG (minimum 0, 1, and generic 2; G6 unreachable at production 1) and WC committed verbatim, asserting cache state directly.
- [x] 2.4 Add witnesses O1 and O2 through the real worker and the poller, generated with bounded writes.
  - Verify: literal forms stay eligible, reach unchanged matching, insert with a null window, and enter neither empty cache; short-trailer forms bind the expected window. Each fails under mutant M3 (`P(n)` treated as `C(n)` or cached).
- [x] 2.5 Add properties P1 (seed `0x6b617761`, 200 cases, including the sparse 1 MiB / 1 GiB pair) and P2 over the same cases.
  - Verify: both pass, P1 kills mutant M2 (a whole-file read restored), and P2 kills M3.

## 3. Bounded `task_get` (D4–D5, later revision)

Groups 3–5 land in two steps (design D7, Sequencing): an unwired store and service checkpoint (3.1–3.3, 3.6, 4.1, P4, and the store and service rows), then one atomic registration commit (3.4, 3.5, 4.2, 4.3's adapter rows, and group 5). No item is ticked for a partial API.

- [ ] 3.1 Add `AgentTaskDetail`, the journal preview entry, and the bounds types to `src/shared/teamTasks.ts`.
  - Verify: `bun run typecheck`.
- [ ] 3.2 Add the windowed queries to `TaskStore` and `mailboxStore`:
  - journal rows with `length(CAST(text AS BLOB))` and `substr(CAST(text AS BLOB), 1, 2000)`, anchored on `(created_at, rowid)`;
  - newest subtasks and messages with `LIMIT`;
  - the three counts;
  - all in one synchronous read transaction.
  - Verify: store tests over `schemaDb()`, including entries that share a `created_at` and entries holding NUL.
- [ ] 3.3 Add `TaskService.agentGet` with the optional agent window, returning `AgentTaskDetail` with the seal (generalized over any detail with results) applied after.
  - Leave `TaskService.get` and the human `team-task-detail` path on `humanDetail` unchanged.
  - Verify: T15 holds.
- [ ] 3.4 Extend the `task_get` schema with `journal_before` and `journal_limit` (integer 1–200, default 50, one explicit range message) and the refusal `Unknown journal entry for this task: <id>`, routing it to `agentGet`.
  - Verify: the `taskTools` tests pass for both arguments.
- [ ] 3.5 Commit table T1–T16 verbatim (including the WP preview rows T-small, T-invalid, and T-large-readable) as a table-driven test through both the Claude (`createMailboxServer`) and the Codex (`dispatchTeamToolCall`) adapters. Refusal rows assert each adapter's own envelope.
  - Verify: the test passes, and with the test-side query observer, scoped as in design M4 and M5, it kills mutants M4 (windows taken from a full load) and M5 (whole text cut in JavaScript).
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

- [ ] 5.1 Update the `task_get` description, the task note in `teamPrompt.ts`, the delivered header line in `taskContext.ts`, and the task-tools facts in `docs/architecture/tasks.md` (not root `AGENTS.md`) so none promises the full journal and each names `journal_before`, `journal_limit`, and `task_journal_read`.
  - Verify: the prompt and header tests pass with the new text.
- [ ] 5.2 Update every enumeration test over the task tool names, and confirm the new name composes with tool-metrics normalization without an import cycle.
  - Verify: the enumeration tests pass.
- [ ] 5.3 Version the delivered task header (design D7, C1): `taskHeaderVersion` in the envelope metadata (absent is the legacy generation 1, current is 2), the legacy renderer kept byte-exact, and `formatEnvelope`/`parseEnvelope` choosing the renderer by version. Lands with 5.1's header line.
  - Verify: rows V1–V7 through `parseEnvelope`, both receipt extractors, transcript replay, and `reconcileMailbox`, with legacy fixtures as literal base `567ec21e` bytes.

## 6. Integration

- [ ] 6.1 Run `bun run check` on the clean committed tree for each submitted result.
  - Verify: it records a pass.
- [ ] 6.2 Produce the oracle map in each result: every in-scope row of WX, WE, WG, WC, O, T (including WP), R, and V, each of P1–P4, and each of M1–M5, with its test title and killed mutant. Rows belonging to a later revision are listed as deferred.
  - Verify: every id is mapped or deferred. No RSS or memory threshold is claimed.

## Workflow follow-up

- After deploy, ask the live Codex Leads to move to fresh chats, so their oversized rollouts stop growing.
- Archive the change once reviewed and landed.
