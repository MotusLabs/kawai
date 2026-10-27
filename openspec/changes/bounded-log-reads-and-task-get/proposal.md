# Proposal

## Why

On 2026-10-27 the workspace container was OOM-killed at its 18 GiB limit (17:27:25Z), and kawai had already stalled and restarted twice in the hour before. Every live agent died each time. Two causes combined:

- **The terminal-log poller reads whole agent logs.** About every 15 s it reads each recently modified log in full. That includes Codex chat rollouts, which it then discards as chat transcripts. With rollouts at 743 MiB and 544 MiB, each poll pushed the server from ~240 MB to 1.1–3.2 GiB for about a second.
- **`task_get` returns unbounded records.** The rollouts grew that large because each Lead's `task_get` on the long-running "Lead log" task returns the whole record. That is ~9 MB per call, 8 MB of it from 1,198 journal entries, and every call is written into the caller's transcript.

As long-lived tasks and Codex chats keep growing, both costs grow without bound, so the next OOM is a matter of time.

## What Changes

- **Excluded chat logs are dropped before enrichment.** Log discovery identifies a chat transcript by its file name and bounded head, and drops it before any content beyond that head is read. Today the exclusion runs only after enrichment has read the whole file.
- **Log reads for token counting are bounded.** Counting a log's message tokens reads at most the configured tail window (200 KiB). The empty-tail fallback reads at most a bounded head (200 KiB). The read never scales with file size.
- **`task_get` returns a bounded record.**
  - The newest 50 journal entries, each cut at 2,000 characters with the cut marked.
  - Subtasks capped at 100, newest first.
  - Messages capped at the newest 50.
  - Totals for each list and a flag when a list was truncated.
- **New optional `task_get` arguments page the journal:** `journal_before` (an entry id) and `journal_limit` (1–200). Older entries stay reachable without returning the whole record.
- **The tool description and the system prompt's task note** say the record is bounded and how to page it.
- **BREAKING (agent-visible):** an agent that relied on `task_get` returning every journal entry, subtask, or message now gets the newest window plus totals, and must page the journal. The human's task detail (`team-task-detail`) is unchanged.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `terminal-streaming`: adds a requirement that log discovery and matching read bounded portions of each log and skip excluded chat transcripts before reading their content.
- `team-tasks`: adds a requirement that the agent `task_get` tool returns a bounded record with totals, truncation flags, and journal paging.

## Impact

- **Log polling code:**
  - `src/server/logPollData.ts`: exclusion before `enrichLogEntry`.
  - `src/server/logmatch/logText.ts`: bounded reads in `getLogTokenCount` and `readLogContent`.
  - The matching tests.
- **Task tool code:**
  - `src/server/team/taskTools.ts`: schema, description, and handler.
  - `src/server/team/TaskService.ts` or a new bounding helper beside it.
  - `src/shared/teamTasks.ts`: an agent-detail type with totals.
  - The system prompt's task note.
  - `task_get` tests.
- **Unchanged:**
  - The human UI's task detail.
  - Delivered task-mail headers, which already carry the last 5 journal entries.
  - Codex history replay and mail-receipt reads of rollouts. These run on attach and turn end, not on a timer, and are out of scope.
- **No schema migration and no new dependency.**
