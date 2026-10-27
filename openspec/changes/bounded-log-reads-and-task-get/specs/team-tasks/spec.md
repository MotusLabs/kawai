# Spec Delta

## ADDED Requirements

### Requirement: task_get bounds its growing lists
The agent `task_get` tool SHALL return the newest 50 journal entries (or `journal_limit`), the newest 100 subtasks, and the newest 50 messages, oldest first, each list with its total and truncation, applying those limits in SQL before rows reach JavaScript. Other sections, message bodies, and subtask summaries stay whole; no whole-response bound is claimed. The human's task detail SHALL NOT be bounded.

#### Scenario: Long-running task read by an agent
- **WHEN** an agent calls `task_get` on a task with 1,198 journal entries, 149 subtasks, and 60 messages
- **THEN** the result holds the newest 50 entries, 100 subtasks, and 50 messages, each oldest first
- **AND** it reports totals 1,198, 149, and 60, all three truncated

#### Scenario: Small task is whole
- **WHEN** an agent calls `task_get` on a task with 3 journal entries of at most 2,000 bytes, no subtasks, and 1 message
- **THEN** everything is returned whole and nothing is marked truncated or cut

#### Scenario: Results and revisions stay whole
- **WHEN** a task has more than 50 results or revisions, and a review handoff is outstanding
- **THEN** `task_get` returns every result and revision, with the blind-first seal applied as before

#### Scenario: Human detail stays complete
- **WHEN** the human opens the same long-running task in the Tasks tab
- **THEN** its detail carries the whole journal, every subtask, and every message

### Requirement: task_get journal previews are byte-bounded
Each journal entry in `task_get` SHALL carry a preview of at most its first 2,000 stored UTF-8 bytes, projected by the query and trimmed to a whole character, with its total byte length, whether it was cut, and the byte offset to resume reading from. The marker SHALL be metadata, never appended to the text. A preview that is not valid UTF-8 SHALL carry null text and resume offset 0.

#### Scenario: Oversized entry
- **WHEN** an entry holds 5,000 ASCII bytes
- **THEN** its preview is the first 2,000 bytes, marked cut, with total 5,000 and resume offset 2,000

#### Scenario: Character straddling the limit
- **WHEN** a four-byte character spans byte 2,000
- **THEN** the preview ends before it and the resume offset equals the preview length

#### Scenario: Invalid bytes in the preview
- **WHEN** the first 2,000 bytes are not valid UTF-8
- **THEN** the preview text is null and the resume offset is 0

### Requirement: task_get pages the journal
`task_get` SHALL accept an optional `journal_before`, an entry id of the task, and an optional integer `journal_limit` from 1 to 200 (default 50), returning the entries older than that entry by `(created_at, rowid)`, oldest first, with whether older entries remain and the next anchor. An id that is not an entry of the task SHALL be refused naming it; a limit out of range SHALL be refused.

#### Scenario: Reading older entries
- **WHEN** an agent pages from the newest window with each result's next anchor until no older entries remain
- **THEN** every entry of the unchanged journal is returned exactly once, including entries sharing a timestamp

#### Scenario: Last page
- **WHEN** `journal_before` names the 31st-oldest entry with limit 100
- **THEN** the 30 oldest entries are returned and no older entries remain

#### Scenario: Unknown or foreign entry id
- **WHEN** `journal_before` names an entry of another task or no entry
- **THEN** the call is refused naming the id, through either tool runtime

#### Scenario: Limit out of range
- **WHEN** `journal_limit` is 0, 201, or 1.5
- **THEN** the call is refused naming the range 1–200, through either tool runtime

### Requirement: task_journal_read returns any entry losslessly
A read-only `task_journal_read` tool SHALL take a task id, an entry id, and a byte offset (default 0), and return at most 8,192 stored bytes from that offset as base64, with the exact text when they are valid UTF-8 (else null), the total, and the next offset. Concatenating chunks from 0 SHALL reproduce the stored bytes, NUL and byte-order marks included. Entries SHALL never be rewritten.

#### Scenario: Reading a long entry
- **WHEN** an agent reads a 20,000-byte ASCII entry from offset 0 and follows each next offset
- **THEN** it receives chunks of at most 8,192 bytes whose concatenation equals the entry

#### Scenario: Entry with an embedded NUL
- **WHEN** an entry holds text, a NUL character, and a suffix
- **THEN** the total counts every byte and the reconstructed chunks include the suffix

#### Scenario: Chunk end inside a character
- **WHEN** a chunk would end inside a multi-byte character before the end of the entry
- **THEN** the chunk ends before that character, and the next offset starts at it

#### Scenario: Offset inside a character or invalid bytes
- **WHEN** the offset falls inside a character, or the bytes are not valid UTF-8
- **THEN** the text is null and the base64 carries at least one raw byte

#### Scenario: Offset at or past the end
- **WHEN** the offset equals the entry's byte length
- **THEN** an empty chunk is returned with no next offset
- **AND** an offset beyond it is refused naming the offset and the total

#### Scenario: Entry of another task or team
- **WHEN** the entry belongs to another task, or the task to another team
- **THEN** the call is refused as `task_get` would refuse it

### Requirement: Agents are told task_get is bounded
The `task_get` and `task_journal_read` descriptions, the system prompt's task note, and the delivered task-mail header SHALL state that `task_get` returns bounded windows with totals and byte-bounded previews, and name `journal_before`, `journal_limit`, and `task_journal_read`; none SHALL promise the full journal.

#### Scenario: Prompt names the paging
- **WHEN** an agent starts with the team prompt
- **THEN** its task note describes `task_get` as bounded and names `journal_before`, `journal_limit`, and `task_journal_read`

#### Scenario: Header stops promising the full journal
- **WHEN** task mail is delivered
- **THEN** its header names the bounded `task_get` and `task_journal_read` rather than a full journal
