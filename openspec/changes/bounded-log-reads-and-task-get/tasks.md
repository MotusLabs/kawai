# Tasks

## 1. Exclude chat transcripts before enrichment (D1)

- [ ] 1.1 Split `enrichLogEntry` (`src/server/logPollData.ts`) into an identity step and a content step:
  - The identity step covers the file-name thread id and `extractSessionId` over the 64 KiB head. The content step is the token count.
  - Apply `isExcludedChatLog` between the two in both `collectLogEntryBatch` and `collectLogEntriesForPaths`.
  - Verify: the existing `logPollData` tests pass unchanged.
- [ ] 1.2 Commit the exclusion table (X1–X5) verbatim as a table-driven test.
  - It runs through the real `collectLogEntryBatch` over temp logs, with a byte-counting `fs.readSync` spy.
  - Verify: every row holds, and the test kills the mutant "exclusion filter moved back after `enrichLogEntry`", where X1 and X2 read past the head.

## 2. Bounded token-count reads (D2)

- [ ] 2.1 Rewrite `getLogTokenCount` and `readLogContent` (`src/server/logmatch/logText.ts`) to read only the bounded tail, plus the bounded head as the empty-tail fallback.
  - Reuse `readLogTail`'s offset read. Keep the zero-token cache keyed by size.
  - Verify: the existing `logText` tests pass, including the huge-pasted-line case.
- [ ] 2.2 Add property P1 (seed `0x6b617761`, 200 cases, logs up to 64 MiB):
  - Bytes read are ≤ head + tail limits.
  - The count equals the old function's count over the windowed file.
  - Verify: the property passes and kills the mutant "`readFileSync` restored in `readLogContent`".
- [ ] 2.3 Measure one poll over a 700 MiB synthetic rollout (excluded) and a 700 MiB terminal log (not excluded), and record the peak RSS of each in the task result.
  - Verify: neither poll raises the worker's RSS by more than 10 MiB over a run against a 1 MiB log.

## 3. Bounded `task_get` (D3–D4)

- [ ] 3.1 Add the `AgentTaskDetail` type with `bounds` to `src/shared/teamTasks.ts`, and add the pure `boundJournalEntry` (2,000-character cut plus marker).
  - Verify: unit tests cover lengths 1,999, 2,000, and 2,001, and multi-byte characters at the cut.
- [ ] 3.2 Add the windowed store queries `journalWindow(taskId, beforeId?, limit)`, `subtasks(taskId, limit)`, `taskMessages(taskId, limit)`, and the three counts to `TaskStore`.
  - Order by `(created_at, rowid)` and anchor on an entry id.
  - Verify: store tests over `schemaDb()`, including entries that share a `created_at`.
- [ ] 3.3 Give `TaskService.get` the optional window, returning `AgentTaskDetail` for the agent path. Leave the human's `team-task-detail` path on the unbounded `detail`.
  - Verify: a test proves the human detail of a 1,198-entry task is still complete.
- [ ] 3.4 Extend the `task_get` schema with `journal_before` and `journal_limit` (1–200, default 50), and the refusal `Unknown journal entry for this task: <id>`.
  - Verify: the `taskTools` tests pass for both arguments.
- [ ] 3.5 Commit table T1–T7 verbatim as a table-driven test through the real `kawai-team` tool handler (hazard M1).
  - Refusal rows assert the tool error envelope.
  - Verify: the test kills the mutants "window applied after a full `detail` load" (asserted through a query-count seam) and "`journal_before` comparison `<` changed to `<=`" (T3 returns the anchor twice).
- [ ] 3.6 Add property P2 (seed `0x7461736b`, 200 cases): paging until `truncated` is false yields every entry exactly once in store order.
  - Verify: it kills the mutant "tie-break on `rowid` dropped".
- [ ] 3.7 Update the `task_get` description in `taskTools.ts` and the task note in `src/server/team/teamPrompt.ts` (bounded lists, totals, `journal_before`/`journal_limit`), plus the `task_get` line in `AGENTS.md`'s task-tools bullet.
  - Verify: the prompt snapshot test passes with the new text, and the Scenario "Prompt names the paging" holds.

## 4. Integration

- [ ] 4.1 Run `bun run check` on the clean committed tree.
  - Verify: it records a pass.
- [ ] 4.2 Produce the oracle map in the result: each of X1–X5, T1–T7, P1, and P2 with its test title and killed mutant.
  - Verify: every id is mapped.

## Workflow follow-up

- After deploy, ask the two Codex Leads ("Change Lead", "Team Lead CX") to move to fresh chats so their oversized rollouts stop growing.
- Archive the change once reviewed and landed.
