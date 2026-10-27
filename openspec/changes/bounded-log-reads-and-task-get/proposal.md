# Proposal

## Why

The author reports that on 2026-10-27 the workspace container was OOM-killed at its 18 GiB limit (17:27:25Z), after kawai had stalled and restarted twice in the hour before, and every live agent died each time. These figures are the author's observations and have not been independently reproduced. Two mechanisms the source confirms can produce that growth:

- **The terminal-log poller reads whole agent logs.** About every 15 s, `getLogTokenCount` reads each recently modified unknown log in full (`readFileSync`), including Codex chat rollouts that the collectors only discard as chat transcripts afterwards. The author reports rollouts of 743 MiB and 544 MiB and per-poll server growth from ~240 MB to 1.1–3.2 GiB.
- **`task_get` returns unbounded records.** It loads every journal entry, subtask, and message, with each entry's whole text, and the result is written into the caller's transcript. The author reports ~9 MB per call on the long-running "Lead log" task (1,198 journal entries).

Both costs grow with a log's size and a task's life.

## What Changes

- **Excluded chat logs are dropped before their content is read.** The match worker drops a log whose file-name thread id, known session id, or candidate record id belongs to a chat before opening it, and one whose head session id does right after the existing head identity parse. This covers both collectors, orphan rematch, and last-message backfill. The newest-`maxLogs` selection still happens first.
- **Token enrichment reads bounded windows.** It reads at most a 200 KiB head and a 200 KiB tail through one file descriptor, plus a one-byte lookbehind, never the whole file.
- **Token evidence replaces the bare count.** Enrichment reports *positive*, *proven empty*, *incomplete*, or *unavailable*. Gates reject a log on token grounds only on complete evidence. An *incomplete* log (no message text in the windows of a larger file) stays eligible for the existing exact matching, so terminal sessions whose only message lies outside the windows are still matched. Only *proven empty* evidence is cached as empty.
- **`task_get` bounds its growing lists in SQL.** The newest 50 journal entries (1–200 on request), the newest 100 subtasks, and the newest 50 messages, each with its total and truncation state. Each journal entry carries a preview of at most its first 2,000 stored UTF-8 bytes, projected in the query, with its total byte length and the offset to resume from.
- **New optional `task_get` arguments page the journal:** `journal_before` (an entry id) and `journal_limit` (1–200, default 50).
- **New read-only tool `task_journal_read`** returns any journal entry losslessly by byte offset, in chunks of at most 8,192 stored bytes, as base64 plus the exact text when the chunk is valid UTF-8. It replaces the need for any database-copy workaround, and existing entries (including ones with NUL characters) are never rewritten.
- **The tool descriptions, the system prompt's task note, and the delivered task-mail header** stop promising the full journal and name the paging and the reader.
- **BREAKING (agent-visible):** an agent that relied on `task_get` returning every journal entry, subtask, message, or whole entry text now gets windows, previews, totals, and must page or read entries. The human's task detail (`team-task-detail`) is unchanged.

What this change does **not** claim:

- No whole-response size bound for `task_get`. The task, revisions, assignments, publications, acknowledgements, results (diffs, coverage, checks), message bodies, and subtask summaries stay whole.
- No native SQLite memory bound. Projecting a 2,000-byte preview or an 8,192-byte chunk still makes SQLite read the stored value; the bound is on what reaches kawai's JavaScript and the response.
- No whole-poll I/O bound. Exact matching keeps its `rg` search over candidate files, last-message extraction keeps its own windows, and head identity parsing keeps its expansion to 1 MiB.
- No RSS threshold. Any memory measurement needs its own reviewed recipe.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `terminal-streaming`: adds requirements that the match worker excludes chat transcripts before reading their content, reads bounded windows for token enrichment, and keeps logs with incomplete token evidence eligible for matching.
- `team-tasks`: adds requirements that `task_get` bounds its growing lists in SQL with byte-bounded journal previews and journal paging, that `task_journal_read` returns any entry losslessly, and that agents are told so.

## Impact

- **Log polling code (first production path):**
  - `src/server/logPollData.ts`: exclusion order in both collectors; token evidence on entries.
  - `src/server/logMatchWorker.ts`: the same exclusion before orphan rematch, last-message backfill, and last-message reads; orphan gate on evidence.
  - `src/server/logmatch/logText.ts`: the bounded one-descriptor token reader and evidence classification; the proven-empty cache.
  - `src/server/logMatchGate.ts`, `src/server/logPoller.ts`: gates and the insert-time empty cache consume evidence.
  - The matching tests.
- **Task tool code (later revision):**
  - `src/server/team/taskStore.ts`, `src/server/team/mailboxStore.ts`: windowed, projected queries and counts.
  - `src/server/team/TaskService.ts`: the agent window and the entry reader.
  - `src/server/team/taskTools.ts`: schemas, descriptions, handlers, and the new tool name.
  - `src/shared/teamTasks.ts`: the agent detail and chunk types.
  - `src/server/team/teamPrompt.ts`, `src/server/team/taskContext.ts`, and the task-tools bullet in `AGENTS.md`, in the Lead's integration order.
  - `task_get` and `task_journal_read` tests through both the Claude and the Codex tool adapters.
- **Unchanged:**
  - The human UI's task detail.
  - Exact `rg` matching, last-message extraction windows, head identity expansion.
  - Codex history replay and mail-receipt reads of rollouts (event-driven, not periodic).
- **No schema migration and no new dependency.**
