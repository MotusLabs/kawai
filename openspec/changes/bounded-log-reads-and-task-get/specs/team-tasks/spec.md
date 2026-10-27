# Spec Delta

## ADDED Requirements

### Requirement: task_get returns a bounded record
The agent `task_get` tool SHALL bound the lists that grow with a task's life:
- the newest 50 journal entries, each cut at 2,000 characters with the cut marked;
- the newest 100 subtasks;
- the newest 50 messages.

Each bounded list SHALL report its total and whether it was truncated. The task, revisions, assignments, publications, acknowledgements, and results SHALL stay whole. The human's task detail SHALL NOT be bounded.

#### Scenario: Long-running task read by an agent
- **WHEN** an agent calls `task_get` on a task with 1,198 journal entries, 149 subtasks, and 2 messages
- **THEN** the result holds the newest 50 journal entries oldest first, the newest 100 subtasks, and both messages
- **AND** it reports totals 1,198, 149, and 2, with the journal and subtasks marked truncated and the messages not

#### Scenario: Oversized journal entry
- **WHEN** a journal entry's text exceeds 2,000 characters
- **THEN** `task_get` returns its first 2,000 characters followed by a marker stating the entry was cut and its full length

#### Scenario: Small task is unchanged
- **WHEN** an agent calls `task_get` on a task with 3 journal entries, no subtasks, and 1 message
- **THEN** every entry, subtask, and message is returned whole, and no list is marked truncated

#### Scenario: Human detail stays complete
- **WHEN** the human opens the same long-running task in the Tasks tab
- **THEN** its detail carries the whole journal, every subtask, and every message, as before

#### Scenario: Results stay whole
- **WHEN** a task has more than 50 results or revisions
- **THEN** `task_get` returns every result with its findings and every revision

### Requirement: task_get pages the journal
`task_get` SHALL accept an optional `journal_before`, an entry id of the task, and an optional `journal_limit` from 1 to 200 (default 50). Together they return the entries older than the named entry, newest of them first in the window and oldest first in the list, with the same total and truncation report. An id that is not an entry of the task SHALL be refused naming it. A limit out of range SHALL be refused naming the range.

#### Scenario: Reading older entries
- **WHEN** an agent calls `task_get` with `journal_before` set to the oldest entry of its previous result and `journal_limit` 100
- **THEN** the result's journal holds the 100 entries immediately older than that entry, oldest first, and reports truncation when older entries remain

#### Scenario: Unknown entry id
- **WHEN** `journal_before` names an entry of another task or no entry at all
- **THEN** the call is refused naming the id, and nothing else is returned

#### Scenario: Limit out of range
- **WHEN** `journal_limit` is 0 or 201
- **THEN** the call is refused naming the range 1–200

### Requirement: Agents are told task_get is bounded
The `task_get` tool description and the system prompt's task note SHALL state that the journal, subtasks, and messages are bounded to their newest entries with totals reported, and that older journal entries are read with `journal_before`.

#### Scenario: Prompt names the paging
- **WHEN** an agent starts with the team prompt
- **THEN** its task note describes `task_get` as bounded and names `journal_before` and `journal_limit`
