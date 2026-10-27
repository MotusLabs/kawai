# Design

## Context

See proposal.md, Why. The relevant current code:

- **`collectLogEntryBatch` and `collectLogEntriesForPaths`** (`src/server/logPollData.ts`) call `enrichLogEntry` on every recent log and apply `isExcludedChatLog` to its result.
- **For an unknown log**, enrichment calls `getLogTokenCount`, which reads the whole file with `readLogContent`. It does so in order to apply a 200 KiB / 2,000-line tail limit, and then scans the whole copy from the head when the tail holds no message text.
- **Codex chat rollouts are never known sessions**, so every recent rollout is read in full on every poll (~15 s). The poll runs in the match worker, which shares kawai's process memory.
- **Head reads are already bounded.** `readLogHead` reads at most 64 KiB, and `extractSessionId` and the codex header checks use it. The exclusion facts are the file-name thread id and the head session id, so both are available without a content read.
- **`task_get`** (`src/server/team/taskTools.ts` → `TaskService.get` → `TaskStore.detail`) returns `TeamTaskDetail` with the whole journal, every subtask summary, and every message.
- **`TaskStore.journal(id, limit)`** already supports a newest-N window in SQL.
- **The human's `team-task-detail`** is built through a different path (`HumanTaskDetail`) and is out of scope.

## Goals / Non-Goals

**Goals:**
- A poll's read volume and peak memory are independent of any one log's size.
- No byte of an excluded chat transcript beyond its head is read by the poller.
- One `task_get` call carries at most ~100 KiB of journal (50 entries × 2,000 characters), even on a task with thousands of entries.
- The bounded rows are loaded with SQL limits, not by loading everything and slicing.

**Non-Goals:**
- Codex history replay and mail-receipt reads of a whole rollout (event-driven, not periodic).
- Shrinking existing rollouts or transcripts. Old 9 MB lines stay in files that are already written.
- Bounding `task_list`, the human UI, or delivered task-mail headers.
- Changing the memory cgroup, `memory.oom.group`, or suite-run budgets.

## Decisions

### D1 — Exclude before enrichment, from cheap identity facts

Split enrichment in two:
1. **An identity step.** It reads the file-name thread id and runs `extractSessionId` over the existing 64 KiB head read.
2. **The content step.** This is the token count.

`isExcludedChatLog` runs between the two, in both collectors, so an excluded log never reaches the content step. The known-session path is unchanged: it already skips content reads.

*Alternative considered:* recognize rollouts by path prefix (`~/.codex/sessions`) and skip them all. Rejected: terminal Codex sessions also write rollouts there and must still be matched.

### D2 — Bounded tail and head reads for token counting

`getLogTokenCount` makes two bounded reads:
- **The tail.** It reads the last `byteLimit` bytes (200 KiB) with `readSync` at an offset, drops the partial first line, and applies the line limit. It reuses the logic of `readLogTail`.
- **The head fallback.** Only when the tail yields no message text, it reads the first `byteLimit` bytes and runs `findFirstMessageTokenCount` on them.

The zero-token cache keeps its file-size key. `readLogContent`'s callers get the same bounded-tail behaviour, so no path reads a whole log.

*Trade-off:* a log whose only message text sits beyond both windows (in the middle of a file over 400 KiB) counts as having no text. Such a log is already past the matcher's minimum-token gate in any realistic session, because its head holds the first user message. The spec allows this explicitly.

### D3 — `task_get` bounds in the service, with SQL limits

`TaskService.get` takes an optional window `{ journalBefore?, journalLimit? }` and returns `AgentTaskDetail`. That type is `TeamTaskDetail` plus `bounds: { journal, subtasks, messages }`, each `{ total, returned, truncated }`.

The store gains three queries:
- **Journal before an entry:** `journalWindow(taskId, beforeId?, limit)`, which uses the existing `ORDER BY created_at DESC, rowid DESC LIMIT ?` with a `(created_at, rowid) < (anchor)` predicate.
- **Newest subtasks:** `subtasks(taskId, limit)`.
- **Newest messages:** `taskMessages(taskId, limit)`.

It also gains `COUNT(*)` queries for the three totals. Entry text is cut at 2,000 characters, followed by `… [cut: <n> chars]`, in one pure function `boundJournalEntry`. Only the agent tool path uses the window. `team-task-detail` keeps calling the unbounded `detail`.

*Alternative considered:* bound in the tool handler by slicing the full detail. Rejected: it still loads 9 MB from SQLite per call.

### D4 — Arguments and refusals

The `task_get` Zod schema adds:
- `journal_before`: string, optional.
- `journal_limit`: integer 1–200, optional, default 50.

Zod refuses an out-of-range limit with the range. An unknown or other-task entry id is refused by the service with `Unknown journal entry for this task: <id>`, through the same error envelope as every task tool refusal. The tool description and the prompt's task note (`teamPrompt.ts`) are updated in the same change.

### Acceptance oracles

**Exclusion before content read (D1)**, through the real `collectLogEntryBatch` with a spy on content reads. Here, *thread id* means the file-name thread id is in the exclude set, *head id* means the head session id is, and *content read* means a byte past the head was read.

| id | thread id | head id | known session | content read | in batch |
|----|-----------|---------|---------------|--------------|----------|
| X1 | yes | * | no | no | no |
| X2 | no | yes | no | no | no |
| X3 | no | no | no | yes (bounded) | yes |
| X4 | no | no | yes | no | yes |
| X5 | yes | * | yes | no | no |

Unreachable: none. A known session that is also excluded (X5) is a chat whose transcript was once matched, and it must stay excluded.

**`task_get` windows (D3/D4)**, through the real `kawai-team` tool handler (hazard M1). *Entries* is the task's entry count and *returned* is the journal it gets back, oldest first.

| id | entries | `journal_before` | `journal_limit` | outcome |
|----|---------|------------------|-----------------|---------|
| T1 | ≤ 50 | — | — | all entries, truncated=false |
| T2 | 1,198 | — | — | newest 50, truncated=true, total 1,198 |
| T3 | 1,198 | id of entry k | 100 | entries k−100…k−1, truncated = (k−100 > 0) |
| T4 | 1,198 | id of entry 30 | 100 | entries 0…29, truncated=false |
| T5 | * | other task's id | * | refused naming the id |
| T6 | * | * | 0 or 201 | refused naming 1–200 |
| T7 | * | unknown id | * | refused naming the id |

Refusal rows T5–T7 assert the same error envelope as a successful call's failure path (the command-surface hazard).

**Properties:**
- **P1, poll reads are bounded.** For generated logs of 0 B to 64 MiB, with random line lengths up to 16 MiB and message text placed at random offsets, the bytes `getLogTokenCount` reads are ≤ head limit + tail limit. The count equals the count over those windows computed by the old function on a file truncated to them.
  - Generator: a seeded PRNG (seed `0x6b617761`), 200 cases.
  - Seam: an `fs.readSync` byte-counting wrapper.
- **P2, paging is lossless.** For generated journals of 0–600 entries, some sharing a `created_at` value, paging from the newest window with random limits in 1–200 until `truncated` is false yields every entry exactly once, in store order.
  - Generator: seed `0x7461736b`, 200 cases.
  - Seam: an in-memory `schemaDb()`.

## Risks / Trade-offs

- **[Agents that relied on the full journal]** → The truncation flags and totals make the gap visible, and the prompt names the paging arguments. The Lead's own working notes (the memory "Read Lead notes via DB copy") already go through a DB copy for full text.
- **[A log with text only mid-file is unmatched]** → Accepted in D2. The head fallback covers the observed huge-pasted-line case.
- **[Concurrent journal appends while paging]** → `journal_before` anchors on an entry id, so new entries never shift an older page. A page can only miss entries appended after the first call, and those appear in a fresh newest window.
- **[Existing huge rollouts still load on attach or replay]** → A non-goal here. It stays bounded by user action (opening the chat), not by a timer.

## Migration Plan

- No schema migration. Deploy is the usual build swap.
- Rollback restores whole reads. That is safe but reintroduces the memory risk.
- After deploy, live Leads should start fresh Codex chats so their oversized rollouts stop growing the attach and replay cost.
