# team-tasks Specification

## Purpose

Gives a team one durable record per feature or request — direction, acceptance criteria, status, and a journal — that every participating agent follows, with direction controlled by the task's creator.

## Requirements

### Requirement: Tasks can be created by the human and by permitted groups
The human SHALL be able to create a task for a team from the UI. A chat agent SHALL be able to create a task with a tool only when its group's frontmatter sets `canCreateTasks: true`; otherwise the tool SHALL return an error. A task SHALL record title, direction, optional acceptance criteria, creator, creation time, and status `open`.

#### Scenario: Team lead creates a task
- **WHEN** a member of a group with `canCreateTasks: true` creates a task
- **THEN** the task exists with that agent as creator and status `open`

#### Scenario: Dev cannot create a task
- **WHEN** a member of a group without `canCreateTasks` calls the create tool
- **THEN** the tool returns an error and no task is created

#### Scenario: Human creates a task
- **WHEN** the user creates a task from the team's task list
- **THEN** the task exists with the human as creator

### Requirement: Tasks may have a parent, a worktree, and a linked change
A task SHALL optionally reference a parent task of the same team, a target worktree, and an OpenSpec change. A target worktree SHALL be the repository's main working tree or one of its linked worktrees; any other path SHALL be refused. A linked change SHALL exist in the repository's OpenSpec changes.

#### Scenario: Subtask
- **WHEN** a team lead creates a task with a parent task
- **THEN** the task detail of the parent lists the new task as a subtask

#### Scenario: Invalid worktree refused
- **WHEN** a task is created with a target path that is not a worktree of the team's repository
- **THEN** creation is refused with an error naming the path

### Requirement: Only the creator or the human amends direction
The task's direction and acceptance criteria SHALL be changeable only by the task's owner or the human; a task without an owner, only by the human or Kawai as before. A change SHALL become a new numbered revision only when published; the human's saved drafts are not revisions. Earlier revisions SHALL remain viewable. Other agents' attempts SHALL be refused with an error suggesting a journal note or a message to the owner.

#### Scenario: Creator amends
- **WHEN** the creating team lead amends the direction
- **THEN** the task shows the new direction as revision 2 and revision 1 remains viewable

#### Scenario: Contributor cannot amend
- **WHEN** a dev agent tries to amend a task it did not create
- **THEN** the tool returns an error and the direction is unchanged

#### Scenario: Human draft is not a revision
- **WHEN** the human saves a draft of a new direction without publishing it
- **THEN** the task still shows revision 1 as its direction

#### Scenario: New owner amends, former owner cannot
- **WHEN** ownership of `A`'s task moved to `B`, and then both try to amend it
- **THEN** `B`'s amendment becomes the next revision and `A`'s is refused naming `B` as the owner

### Requirement: Tasks have an append-only journal
Any team member and the human SHALL be able to append journal entries to a task. The system itself SHALL also append entries for actions it takes on a task's behalf, authored as kawai. Entries SHALL record author, time, and text and SHALL NOT be editable or deletable.

#### Scenario: Agent notes a decision
- **WHEN** a dev appends a note explaining a design choice
- **THEN** the note appears in the task's journal with the dev as author

#### Scenario: System entry
- **WHEN** kawai releases a task's spawned member
- **THEN** the task's journal shows the entry with kawai as author, and it cannot be edited or deleted

### Requirement: Task status and closing
Any team member SHALL be able to set a task to `active` or `blocked`. Only the task's owner SHALL be able to set it to `done` or `cancelled`, and Kawai only on the tasks it created. The human SHALL be able to set any status, including reopening a closed task.

#### Scenario: Contributor reports blocked
- **WHEN** a dev sets a task to `blocked` with a journal note
- **THEN** the task shows `blocked`

#### Scenario: Contributor cannot close
- **WHEN** a dev tries to set a task it did not create to `done`
- **THEN** the tool returns an error and the status is unchanged

#### Scenario: Human reopens
- **WHEN** the user reopens a `done` task
- **THEN** the task becomes `open`

#### Scenario: New owner closes
- **WHEN** lead `B` took over a task created by archived lead `A` and sets it to `done`
- **THEN** the task becomes `done`

### Requirement: Messages may reference a task
Sending, replying, and scheduling SHALL accept an optional task id of the sender's team. A reply SHALL inherit its original message's task when none is given. A task id of another team or an unknown task SHALL be refused.

#### Scenario: Reply inherits task
- **WHEN** a dev replies without a task id to a message that referenced task T
- **THEN** the reply references task T

#### Scenario: Message without a task
- **WHEN** an agent sends a quick question without a task id
- **THEN** the message is delivered with no task header

### Requirement: Delivered task messages carry the task context
When a message referencing a task is delivered, the recipient SHALL receive with it the task's title, current direction and acceptance criteria, revision number, contract identity and, when the revision carries a contract, its clauses and scope globs, status, linked change, target worktree, and its most recent journal entries. If the task has a linked OpenSpec change, the context SHALL state that the change's artifacts are the authoritative direction.

#### Scenario: Task header on delivery
- **WHEN** a QA agent receives a message referencing task T
- **THEN** the delivered turn includes T's title, direction, status, and latest journal entries

#### Scenario: Linked change is authoritative
- **WHEN** a message references a task linked to OpenSpec change `add-x`
- **THEN** the delivered context names `add-x` and says its proposal, design, and tasks are the authoritative direction

#### Scenario: Contract in the header
- **WHEN** a reviewer receives a message referencing a task whose revision 3 carries a contract
- **THEN** the delivered context includes the identity `r3#<hash>`, each clause with its id, and the scope globs

#### Scenario: No contract in the header
- **WHEN** a dev receives a message referencing a task whose current revision has no contract
- **THEN** the delivered context includes the revision's text identity and says the task has no contract

### Requirement: Tasks are inspectable in the UI
The UI SHALL list a team's tasks with title, status, creator, and participants, and SHALL show a task's direction with revision history and rationale, journal, subtasks, and messages. The human SHALL be able to change status, and to change direction from the task detail through **Save draft**, **Publish revision**, and **Publish and notify**. A chat session working on a task SHALL show the task in its header.

#### Scenario: Task detail
- **WHEN** the user opens a task
- **THEN** its direction, revisions, journal, subtasks, and messages are shown

#### Scenario: Three direction actions
- **WHEN** the user edits a task's direction in the detail
- **THEN** **Save draft**, **Publish revision**, and **Publish and notify** are offered as separate actions

### Requirement: Tasks persist
Tasks, revisions, and journal entries SHALL persist across server restart and SHALL remain after their participating sessions are archived or killed.

#### Scenario: Creator killed
- **WHEN** a task's creating session is killed
- **THEN** the task remains, and the human can still amend and close it

### Requirement: Tasks may link to a plan change
A task SHALL optionally name, at creation, a plan of its team and one change of that plan's current approved revision; both or neither SHALL be given. The plan SHALL be open and have an approved revision, and any other reference SHALL be refused naming it. The link SHALL be immutable after creation and SHALL survive later plan revisions.

#### Scenario: Linked at creation
- **WHEN** the lead creates a task naming plan P and its change `api`
- **THEN** the task records the link, and P's detail lists the task under `api`

#### Scenario: Plan without an approved revision refused
- **WHEN** a task names a plan that has only revisions in review
- **THEN** creation is refused naming the plan, and no task is created

#### Scenario: Unknown change refused
- **WHEN** a task names change `cli` of a plan whose approved revision has no change `cli`
- **THEN** creation is refused naming `cli`

#### Scenario: Another team's plan refused
- **WHEN** a task names a plan of another team
- **THEN** creation is refused as if the plan did not exist

### Requirement: Delivered mail for a linked task names its plan change
When a message referencing a task linked to a plan change is delivered, the task context SHALL name the plan's title and id, its current approved revision at delivery, and the change. Tasks without a link SHALL keep the existing context shape.

#### Scenario: Plan line on delivery
- **WHEN** an agent receives a message referencing a task linked to change `api` of plan P at approved revision 2
- **THEN** the delivered context names P, revision 2, and `api`

#### Scenario: Unlinked task unchanged
- **WHEN** an agent receives a message referencing a task without a plan link
- **THEN** the delivered context has no plan fields

### Requirement: Task status transitions are recorded
Every change of a task's status SHALL append one durable row naming the task, the previous and new status, the actor (the human, an agent session, or Kawai), and the time, in the same transaction as the change. Rows SHALL never be edited or deleted and SHALL survive restart and the actor's archive or kill. A request that leaves the status unchanged SHALL append nothing.

#### Scenario: Reopen is recorded
- **WHEN** the human reopens a `done` task
- **THEN** a transition from `done` to `open` by the human is recorded

#### Scenario: Acceptance closes the task
- **WHEN** accepting a result sets the task to `done`
- **THEN** a transition to `done` is recorded with the accepting actor

#### Scenario: Refused change
- **WHEN** a contributor's attempt to set `done` is refused
- **THEN** no transition is recorded

### Requirement: Kawai creates the tasks of a plan execution
A plan execution SHALL create its tasks with Kawai as the creator, shown as "Kawai", never as the human or an agent session. Kawai SHALL be a creator only through a plan execution, an owner's decision override, or a failed promotion, and SHALL close its tasks under the existing closing rights. An execution's task SHALL link to the plan change of the execution's revision, even when a later approved revision no longer names that change. A fix or correction task SHALL link to no plan change.

#### Scenario: Kawai's task in the task list
- **WHEN** an execution provisions change `api`
- **THEN** the team's task list shows a task for `api` created by Kawai, linked to the plan change and targeting `.worktrees/api`

#### Scenario: The link follows the execution's revision
- **WHEN** revision 4, approved during an execution of revision 3, drops change `cli`, and the execution then schedules `cli`
- **THEN** Kawai's task for `cli` links to `cli` of revision 3, and its creation is not refused

#### Scenario: An agent cannot close Kawai's task
- **WHEN** a dev sets the task Kawai created for its change to `done`
- **THEN** the tool returns an error, as for any task it did not create, and the status is unchanged

#### Scenario: Kawai's fix task for an override
- **WHEN** the owner overrides a Lead decision on a plan whose Lead role is `lead`
- **THEN** the task list shows a fix task created by Kawai, linked to no plan change, with its instruction dispatched to `lead`

### Requirement: Only Kawai links tasks to a running execution's changes
While a running execution owns a change, creating another task linked to that change SHALL be refused for the human and for agents, naming the execution. Links to other changes SHALL follow the plan-change link rules unchanged.

#### Scenario: A parallel task for a running change
- **WHEN** the Lead creates a task linked to change `api` while a running execution owns `api`
- **THEN** creation is refused naming the execution, and no task is created

#### Scenario: Linking after the execution
- **WHEN** the execution that owned `api` has finished
- **THEN** a task linked to `api` can be created under the plan-change link rules

### Requirement: Delivered mail for an execution task names its execution
When a message referencing a task that Kawai created for an execution is delivered, the task context SHALL also name the execution and the plan revision it runs, beside the plan's current approved revision. Other tasks SHALL keep their context shape.

#### Scenario: Execution line on delivery
- **WHEN** a dev receives a fix instruction for change `api` of an execution running revision 3 while revision 4 is approved
- **THEN** the context names the execution, revision 3 as the revision it runs, and revision 4 as the current approved revision

#### Scenario: Other tasks unchanged
- **WHEN** an agent receives mail for a task that no execution created
- **THEN** the delivered context has no execution fields

### Requirement: task_get bounds its growing lists
Agent `task_get` SHALL return the newest 50 journal entries (or `journal_limit`), 100 subtasks, and 50 messages, oldest first, each with its total and truncation, limited in SQL before rows reach JavaScript. Other lists SHALL keep their specified windows and preview caps. Not byte-bounded: current direction, acceptance, instruction, whole results except diffs, selected revision text, `full_messages` bodies, publication recipients, and task participants. Human task detail SHALL NOT be bounded.

#### Scenario: Long-running task read by an agent
- **WHEN** an agent calls `task_get` on a task with 1,198 journal entries, 149 subtasks, and 60 messages
- **THEN** the result holds the newest 50 entries, 100 subtasks, and 50 messages, each oldest first
- **AND** it reports totals 1,198, 149, and 60, all three truncated

#### Scenario: Small task is whole
- **WHEN** an agent calls `task_get` on a task with 3 journal entries of at most 2,000 bytes that are valid UTF-8, no subtasks, and 1 message
- **THEN** everything is returned whole and readable, and nothing is marked truncated or cut

#### Scenario: Results and revisions stay whole
- **WHEN** a task has more than 50 results or revisions, and a review handoff is outstanding
- **THEN** `task_get` returns the outstanding result whole with the blind-first seal applied as before, the newest 50 other results and revisions as rows, and anchors that reach every older one

#### Scenario: Umbrella task fits a context
- **WHEN** an agent calls `task_get` with default arguments on a task with 1,993 journal entries, 163 subtasks, 114 messages, 8 revisions, and 5 results
- **THEN** the serialized result is under 256 KB for the deterministic umbrella fixture defined in design.md; arbitrary whole current instructions and requested whole records have no universal byte cap

#### Scenario: Human detail stays complete
- **WHEN** the human opens the same long-running task in the Tasks tab
- **THEN** its detail carries the whole journal, every subtask, message, revision, and result, with full bodies, instructions, and diffs

### Requirement: task_get journal previews are byte-bounded
Each journal entry in `task_get` SHALL carry a preview of at most its first 2,000 stored UTF-8 bytes, projected by the query and trimmed to a whole character, with its total byte length, whether it was cut, and the byte offset to resume reading from. The marker SHALL be metadata, never appended to the text. A preview that is not valid UTF-8, at any length, SHALL carry null text and resume offset 0; stored bytes are never rewritten.

#### Scenario: Oversized entry
- **WHEN** an entry holds 5,000 ASCII bytes
- **THEN** its preview is the first 2,000 bytes, marked cut, with total 5,000 and resume offset 2,000

#### Scenario: Character straddling the limit
- **WHEN** a four-byte character spans byte 2,000
- **THEN** the preview ends before it and the resume offset equals the preview length

#### Scenario: Invalid bytes in the preview
- **WHEN** the first 2,000 bytes are not valid UTF-8
- **THEN** the preview text is null and the resume offset is 0

#### Scenario: Short invalid historical entry
- **WHEN** a task holds a one-byte entry `FF` beside a valid small entry
- **THEN** the `FF` preview has null text, resume offset 0, and total 1, and is not cut
- **AND** `task_journal_read` returns that byte exactly, and the valid sibling is returned whole

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

### Requirement: task_get revisions are rows
`task_get` SHALL return the newest 50 revisions as rows, oldest first: number, identity `r<N>#<hash12>`, contract hash, author, time, notify flag, direction and acceptance byte lengths without their text, and a rationale preview of at most 2,000 UTF-8 bytes with its length and cut flag. An optional `revisions_before`, a revision number of the task, SHALL return the 50 rows older than it. The list SHALL carry its total and next anchor.

#### Scenario: Eight revisions
- **WHEN** an agent calls `task_get` on a task with 8 revisions of up to 27 KB each
- **THEN** it receives 8 revision rows without text, each with the identity a whole read of that revision reports, and the current direction once, in `task`

#### Scenario: Long revision history
- **WHEN** a task has 70 revisions and the agent pages with each result's revisions anchor until none remains
- **THEN** the first read holds the newest 50 with total 70, and every revision row is returned exactly once

#### Scenario: Long rationale
- **WHEN** a revision's rationale is 5,000 ASCII bytes
- **THEN** its row carries the first 2,000 bytes, marked cut, with total 5,000

#### Scenario: Unknown revision anchor
- **WHEN** `revisions_before` is 0, 71 on a task with 70 revisions, or not an integer
- **THEN** the call is refused naming the value, through either tool runtime

### Requirement: task_get reads one revision whole
`task_get` SHALL accept an optional `revision`, an existing revision number of the task, and then also return that revision's full direction, acceptance, and rationale. A revision that does not exist SHALL be refused naming it.

#### Scenario: Reading an earlier revision
- **WHEN** the agent calls `task_get` with `revision` 3
- **THEN** the result also carries revision 3's direction, acceptance, and rationale whole

#### Scenario: Unknown revision
- **WHEN** `revision` is 9 on a task with 8 revisions, or 0
- **THEN** the call is refused naming the revision, through either tool runtime

### Requirement: task_get subtasks are compact rows
Each subtask in `task_get` SHALL be the compact row `task_list` returns, without direction, acceptance, assignment instruction, or participants. `task_get` SHALL accept an optional `subtasks_before`, a subtask id of the task, returning the newest 100 subtasks older than it by `(created_at, rowid)`, with the next anchor. An id that is not a subtask of the task SHALL be refused naming it.

#### Scenario: Umbrella task subtasks
- **WHEN** an agent calls `task_get` on a task with 163 subtasks whose directions total 336 KB
- **THEN** the 100 newest subtasks are compact rows, no direction text appears among them, and the bounds give total 163, truncated, and a next anchor

#### Scenario: Paging subtasks to the end
- **WHEN** the agent pages with each result's subtasks anchor until none remains
- **THEN** every subtask of the unchanged task is returned exactly once, including subtasks sharing a creation time

#### Scenario: Foreign subtask anchor
- **WHEN** `subtasks_before` names a task that is not a subtask of this task
- **THEN** the call is refused naming the id, through either tool runtime

### Requirement: task_get message bodies are previews
Each message in `task_get` SHALL carry a body of at most its first 2,000 UTF-8 bytes, trimmed to a whole character, with the body's total byte length and whether it was cut. `task_get` SHALL accept an optional `messages_before`, a message id of the task, returning the newest 50 messages older than it by `(created_at, rowid)`, with the next anchor. An id that is not a message of the task SHALL be refused naming it.

#### Scenario: Long instruction mail
- **WHEN** a task message's body is 6,000 ASCII bytes
- **THEN** its body is the first 2,000 bytes, marked cut, with total 6,000

#### Scenario: Paging messages to the end
- **WHEN** an agent pages a task's 114 messages with each result's messages anchor until none remains
- **THEN** every message is returned exactly once

### Requirement: task_get returns full message bodies on request
`task_get` SHALL accept an optional boolean `full_messages`, false by default. When it is true, every message in the window SHALL carry its whole body, with its total byte length and not cut; the window, its order, and its paging are unchanged. A value that is not a boolean SHALL be refused.

#### Scenario: Default stays a preview
- **WHEN** an agent calls `task_get` without `full_messages` on a task whose message body is 6,000 ASCII bytes
- **THEN** the body is the first 2,000 bytes, marked cut

#### Scenario: Asking for full bodies
- **WHEN** the agent calls `task_get` with `full_messages` true on the same task
- **THEN** the body is all 6,000 bytes, not cut, with total 6,000, and the other sections are unchanged

#### Scenario: Full bodies while paging
- **WHEN** the agent pages with `messages_before` and `full_messages` true
- **THEN** each page holds the same messages as without it, each with its whole body

#### Scenario: Non-boolean value
- **WHEN** `full_messages` is `"yes"`
- **THEN** the call is refused, through either tool runtime

### Requirement: task_get lists results as rows
`task_get` SHALL return the outstanding result whole, followed by the newest 50 other results as rows, newest first: id, commit, task revision, submitter, superseding result, acceptance, review verdict, submission time, and a summary preview of at most 2,000 UTF-8 bytes with its byte length and cut flag. An optional `results_before`, a non-outstanding result id of the task, SHALL return the 50 rows older than it. The rows SHALL carry their total and next anchor.

#### Scenario: Five results
- **WHEN** a task has one outstanding result and four superseded ones
- **THEN** the outstanding result is whole, the other four are rows, and their findings and maps are absent

#### Scenario: Long result history
- **WHEN** a task has one outstanding result and 70 superseded ones, and the agent pages with each result's results anchor until none remains
- **THEN** every superseded result row is returned exactly once, and the outstanding result is whole in every read

#### Scenario: Result anchor not of this task
- **WHEN** `results_before` names the outstanding result, a result of another task, or no result
- **THEN** the call is refused naming the id, through either tool runtime

### Requirement: task_get reads one result whole
`task_get` SHALL accept an optional `result_id`, a result of the task, and then return that result whole as `resultDetail` as well. In every whole result, the diff SHALL be a preview of at most 8,192 UTF-8 bytes, with its total byte length, whether it was cut, and the offset to resume reading from. The blind-first seal SHALL apply to every whole result returned.

#### Scenario: Reading a superseded result
- **WHEN** the agent calls `task_get` with the `result_id` of a superseded result
- **THEN** that result is returned whole beside the outstanding one

#### Scenario: Sealed reviewer asks for a result
- **WHEN** the reviewer holding the outstanding review handoff, with no map recorded, calls `task_get` with that result's `result_id`
- **THEN** the submitter's coverage map is withheld exactly as in the default read

#### Scenario: Large diff
- **WHEN** a result's diff is 300 KB of ASCII text
- **THEN** its diff is the first 8,192 bytes, marked cut, with total 307,200

#### Scenario: Diff fits the preview
- **WHEN** a result's diff is 2,001 or 8,192 bytes of ASCII text
- **THEN** its diff is whole, not cut, and its resume offset equals its total bytes

#### Scenario: Result of another task
- **WHEN** `result_id` names a result of another task or no result
- **THEN** the call is refused naming the id, through either tool runtime

### Requirement: task_result_diff_read returns any diff losslessly
The `kawai-team` server SHALL offer a read-only `task_result_diff_read` tool, taking a task id, a result id of that task, and an optional `offset_bytes` (default 0). It SHALL return up to 8,192 stored bytes of the result's diff from that offset as authoritative base64, their text when exact UTF-8 (else null), the diff's total bytes, and the next offset, null at the end. It SHALL apply `task_get`'s caller and team rules.

#### Scenario: Reading a diff-only result whole
- **WHEN** a result has no commit and a 300 KB diff, and an agent reads from offset 0 with each next offset until it is null
- **THEN** the concatenated bytes equal the stored diff exactly

#### Scenario: Continuing a preview
- **WHEN** an agent reads from a whole result's diff resume offset
- **THEN** the first chunk starts at the byte after the preview

#### Scenario: Offset beyond the diff
- **WHEN** `offset_bytes` exceeds the diff's total bytes, or is negative or not an integer
- **THEN** the call is refused naming the offset, through either tool runtime

#### Scenario: Result without a diff
- **WHEN** the result has a commit and no diff
- **THEN** the tool returns total 0, no bytes, and a null next offset

#### Scenario: Foreign result
- **WHEN** the result belongs to another task, or the task to another team
- **THEN** the call is refused as not found, through either tool runtime

### Requirement: task_get assignment history is compact
`task_get` SHALL return the newest 50 assignments, publications, and acknowledgements, each list with its total and truncation. Assignment rows SHALL omit the verbatim instruction, which the current assignment keeps in `task.assignment`. Publication rationales SHALL be previews of at most 2,000 stored bytes, with byte length and cut metadata; `revision` SHALL read the whole rationale.

#### Scenario: Instruction appears once
- **WHEN** an agent calls `task_get` on a task with an outstanding assignment and three superseded ones
- **THEN** the current instruction appears in `task.assignment`, and no assignment history row carries an instruction

#### Scenario: Long publication history
- **WHEN** a task has 70 acknowledgements
- **THEN** the newest 50 are returned with total 70, truncated

### Requirement: Remaining task histories have continuation anchors
`task_get` SHALL accept `assignments_before` (assignment id), `publications_before` (revision number), and `acknowledgements_before` (session_id and revision), scoped to the task. Each history SHALL return its newest 50 older rows, oldest first, with total, returned, truncated and nextBefore. Invalid or foreign anchors SHALL be refused without writes.

#### Scenario: Histories remain reachable
- **WHEN** a task has 70 assignments, publications, and acknowledgements, including equal timestamps, and the agent follows each history's anchors
- **THEN** each unchanged history is reached exactly once and the last nextBefore is null

#### Scenario: Invalid history anchors
- **WHEN** a history anchor is unknown, malformed, or belongs to another task
- **THEN** the call is refused naming the anchor and no stored row changes

### Requirement: Task read identities survive paging and concurrent writes
Every read SHALL report the current task identity and preserve each result's submission revision. Windows and totals SHALL describe one consistent read. Across calls pages SHALL use strict older-than ordering over current rows, not promise a frozen snapshot. A newly outstanding result SHALL be whole on the next read; an anchor that has become outstanding SHALL be refused.

#### Scenario: Result superseded between pages
- **WHEN** a new result supersedes the outstanding result between task_get calls
- **THEN** the next read names the new outstanding result and current identity, leaves old result pins unchanged, and applies current sealing rules

#### Scenario: New activity between pages
- **WHEN** later-created mail, assignments, publications, or acknowledgements arrive between pages
- **THEN** older-than paging does not repeat the anchor or include newer rows, and totals reflect the current read

### Requirement: Agents are told task_get is bounded
The `task_get` and `task_journal_read` descriptions, the system prompt's task note, and the delivered task-mail header SHALL state that `task_get` returns bounded windows with totals and byte-bounded previews, and name `journal_before`, `journal_limit`, and `task_journal_read`; none SHALL promise the full journal. The description and the task note SHALL also name every `task_get` paging and whole-read argument the prompt scenario lists, and `task_result_diff_read`.

#### Scenario: Prompt names the paging
- **WHEN** an agent starts with the team prompt
- **THEN** its task note describes `task_get` as bounded and names `journal_before`, `journal_limit`, `task_journal_read`, `subtasks_before`, `messages_before`, `full_messages`, `revisions_before`, `revision`, `results_before`, `result_id`, `task_result_diff_read`, `assignments_before`, `publications_before`, and `acknowledgements_before`

#### Scenario: Header stops promising the full journal
- **WHEN** task mail is delivered
- **THEN** its header names the bounded `task_get` and `task_journal_read` rather than a full journal

### Requirement: Agents without the journal reader are told to stop
The team prompt's task note SHALL tell every agent, whatever its group, that `task_get` is bounded on every call whatever a tool description says, to check the journal bounds and preview cuts, and, if `task_journal_read` is not among its tools, to stop before conclusions needing omitted entries or bytes and ask for a fresh Codex chat, never reading the journal another way. Codex SHALL get it on thread start and resume. This is guidance, not enforcement.

#### Scenario: Prompt tells every agent how to read without the reader
- **WHEN** an agent with any group, or none, starts with the team prompt
- **THEN** its task note says `task_get` is bounded on every call and names the bounds to check
- **AND** it says that without `task_journal_read` the agent stops before conclusions needing omitted entries or bytes and asks for a fresh Codex chat, and never reads the journal through the database, logs, the shell, or files

#### Scenario: A Codex thread keeps its start tools and gets the current guidance
- **WHEN** a Codex chat starts a thread and is later resumed by a restarted server
- **THEN** the start registers the current task tools, including the paged `task_get` and `task_journal_read`
- **AND** the resume registers no tools, and both pass the current team prompt with that guidance as developer instructions

### Requirement: Delivered task context stays compatible across header generations
A delivered task envelope SHALL record its task-header generation: an absent `taskHeaderVersion` is the legacy generation 1, and new task envelopes carry generation 2. Parsing SHALL rebuild the header only with the recorded generation's renderer, so task mail recorded before the bounded header still parses and its receipt stays found. An unknown or non-integer version, a version without a task, or a header not matching its version SHALL NOT parse.

#### Scenario: Task mail recorded before the bounded header
- **WHEN** a task envelope with journal entries and no version, recorded before the change, is read after it
- **THEN** it parses to its message id and peer body, and its receipt is found
- **AND** if it was pushed and not yet settled, reconciliation completes it as delivered rather than returning it to the queue

#### Scenario: Current task mail carries its generation
- **WHEN** task mail is delivered after the change
- **THEN** its metadata carries generation 2 and its header is the bounded one, and it parses back to the same message

#### Scenario: Mismatched or unknown generation
- **WHEN** an envelope's version is unknown or not an integer, is set without a task, or does not match the header it carries
- **THEN** it does not parse as delivered mail

### Requirement: task_list returns compact rows
Each row of the agent `task_list` tool SHALL carry the task's id, title, status, creator, owner, parent, worktree, linked change, plan id and plan change, revision, creation and update times, a compact assignee (target kind and id, role, claimant, derived state) or null, and the outstanding result's id, verdict, and acceptance or null. Rows SHALL NOT carry direction, acceptance, the assignment instruction, or participants.

#### Scenario: Row omits the task's text
- **WHEN** an agent lists a task whose direction is 10,000 characters and whose assignment instruction is 4,000 characters
- **THEN** its row carries the title, status, and identifiers, and neither text appears in the result

#### Scenario: Assignee and result are compact
- **WHEN** a task is claimed by a member of `middle-devs` and holds an outstanding result with a passing review
- **THEN** its row names the group, the claimant, and the state, and carries the result's id with verdict pass

#### Scenario: Unassigned task without a result
- **WHEN** a task has no outstanding assignment and no result
- **THEN** its row has a null assignee and a null result

#### Scenario: Human views stay whole
- **WHEN** the human opens the Tasks tab
- **THEN** the tasks there carry their direction, acceptance, assignment, and participants as before

#### Scenario: Row names the owner
- **WHEN** an agent lists a task that `A` created and `B` now owns
- **THEN** its row carries creator `A` and owner `B`

### Requirement: task_list excludes closed tasks by default
`task_list` SHALL accept an optional `status`, which is one task status or `all`. Without it, the tool SHALL return only `open`, `active`, and `blocked` tasks. A status returns only tasks with that status, and `all` returns every status. The result SHALL name the statuses it applied. An unknown status SHALL be refused, naming the accepted values.

#### Scenario: Default omits finished work
- **WHEN** a team holds 10 open, 4 active, 11 blocked, 405 done, and 12 cancelled tasks and an agent calls `task_list` with no status
- **THEN** the result's total is 25, every row is open, active, or blocked, and the applied statuses are those three

#### Scenario: Asking for done tasks
- **WHEN** the agent calls `task_list` with status `done`
- **THEN** only done tasks are listed, with total 405

#### Scenario: Asking for everything
- **WHEN** the agent calls `task_list` with status `all`
- **THEN** tasks of every status are listed, with total 442

#### Scenario: Unknown status
- **WHEN** the agent calls `task_list` with status `closed`
- **THEN** the call is refused naming the five statuses and `all`, through either tool runtime

### Requirement: task_list is bounded and paged
`task_list` SHALL return at most `limit` matching tasks (an integer from 1 to 200, default 50), newest first by `(created_at, rowid)`. It SHALL report the matching total, the returned count, whether it was truncated, and a next anchor, applying filter and limit in SQL. `before`, a task id of the team, SHALL return the matching tasks older than it. An id outside the team SHALL be refused naming it, as SHALL a limit out of range.

#### Scenario: Large backlog
- **WHEN** an agent calls `task_list` with status `done` on a team with 405 done tasks
- **THEN** it receives the 50 newest done tasks, newest first, with total 405, truncated, and a next anchor

#### Scenario: Paging to the end
- **WHEN** the agent pages with each result's next anchor until it is not truncated
- **THEN** every matching task of the unchanged team is returned exactly once, including tasks sharing a creation time, and the last page has no next anchor

#### Scenario: Anchor that does not match the filter
- **WHEN** `before` names a done task of the team and the status is the default
- **THEN** the open, active, and blocked tasks created before it are returned

#### Scenario: Small team is whole
- **WHEN** a team holds 3 open tasks and an agent calls `task_list`
- **THEN** all 3 are returned, not truncated, with no next anchor

#### Scenario: Unknown or foreign anchor
- **WHEN** `before` names a task of another team or no task
- **THEN** the call is refused naming the id, through either tool runtime

#### Scenario: Limit out of range
- **WHEN** `limit` is 0, 201, or 1.5
- **THEN** the call is refused naming the range 1–200, through either tool runtime

### Requirement: Agents are told task_list is compact and paged
The `task_list` description and the team prompt's task note SHALL state that `task_list` returns summaries without direction, excludes done and cancelled tasks unless `status` asks for them, and is paged with `limit` and `before`. They SHALL point to `task_get` for a task's direction.

#### Scenario: Prompt names the default and the paging
- **WHEN** an agent starts with the team prompt
- **THEN** its task note says `task_list` lists open, active, and blocked tasks by default, names `status: "all"`, `limit`, and `before`, and points to `task_get` for direction

### Requirement: Tasks have an owner
Every task created by an agent session SHALL have an owner, starting as that session. Tasks created by the human or by Kawai SHALL have no owner. Ownership SHALL change only through a transfer, and the creator SHALL stay recorded as the task's author.

#### Scenario: Owner starts as the creator
- **WHEN** lead `A` creates a task
- **THEN** the task's creator and owner are both `A`

#### Scenario: Human task has no owner
- **WHEN** the human creates a task
- **THEN** the task has no owner

#### Scenario: Creator kept after transfer
- **WHEN** ownership of `A`'s task moves to lead `B`
- **THEN** the task names `A` as creator and `B` as owner

### Requirement: Agents transfer task ownership
`task_transfer_owner` SHALL take a `task_id` or a `from_session` (exactly one) and an optional `to_session` (default the caller). The owner MAY transfer to any live, non-flagged session of its group. Another session of the owner's group MAY take ownership for itself only when the owner is not a live session or is context-exhausted. Each move SHALL be journaled.

#### Scenario: Owner hands a task over
- **WHEN** owner `A` transfers its task with `to_session` naming lead `B` of its group
- **THEN** `B` owns the task and its journal records the move from `A` to `B` by `A`

#### Scenario: Taking over from an archived owner
- **WHEN** lead `B` calls the tool with the `task_id` of a task whose owner `A` is archived
- **THEN** `B` owns the task and its journal records the takeover

#### Scenario: Taking every task of a departed owner
- **WHEN** lead `C` calls the tool with `from_session` naming context-exhausted lead `A`
- **THEN** every open, active, and blocked task owned by `A` moves to `C`, done and cancelled tasks keep `A`, and the result lists the moved task ids

#### Scenario: Live owner refuses a takeover
- **WHEN** lead `B` tries to take a task whose owner `A` is live and not flagged
- **THEN** the tool refuses naming `A`, suggests messaging `A`, and nothing changes

#### Scenario: Caller outside the owner's group
- **WHEN** a developer tries to take a lead's task
- **THEN** the tool refuses and nothing changes

#### Scenario: Target outside the group or flagged
- **WHEN** owner `A` names a `to_session` that is a developer, archived, or context-exhausted
- **THEN** the tool refuses naming the target and nothing changes

#### Scenario: Ownerless task
- **WHEN** an agent tries to transfer a task the human created
- **THEN** the tool refuses because the task has no owner

#### Scenario: Neither or both selectors
- **WHEN** the tool is called with both `task_id` and `from_session`, or with neither
- **THEN** the tool refuses and nothing changes

### Requirement: Task reads name the owner
The task section of `task_get` SHALL carry the owner session, or null when the task has none. The human's task detail SHALL show the owner beside the creator when they differ.

#### Scenario: task_get after a transfer
- **WHEN** an agent reads a task that `A` created and `B` now owns
- **THEN** its task section carries creator `A` and owner `B`

### Requirement: A task revision may carry a contract
Creating a task SHALL accept an optional contract in the implementation-contract grammar, from the human's task form and from `task_create`'s `contract` parameter. A contract that does not parse SHALL refuse the creation with every problem the parser reported, and create nothing. The contract SHALL become part of revision 1.

#### Scenario: Lead creates a task with a contract
- **WHEN** a lead calls `task_create` with a direction and a well-formed contract
- **THEN** the task's revision 1 carries that contract and its identity `r1#<hash>`

#### Scenario: Malformed contract refused
- **WHEN** a lead calls `task_create` with a contract that lacks the Scope heading
- **THEN** the tool returns an error naming the missing heading and its line, and no task is created

#### Scenario: Task without a contract
- **WHEN** the human creates a task without a contract
- **THEN** the task exists, and its revision 1 is labeled as having no contract

### Requirement: Amendments carry the contract forward or replace it
An amendment that omits the contract SHALL carry the previous revision's contract into the new revision unchanged. One that supplies a contract SHALL replace it, after it parses. A revision SHALL NOT drop a contract once a revision of the task carried one.

#### Scenario: Direction-only amendment
- **WHEN** the creator amends revision 2's direction without supplying a contract
- **THEN** revision 3 carries revision 2's contract, with the same hash

#### Scenario: Contract replaced
- **WHEN** the creator amends with a contract that adds invariant I3
- **THEN** revision 3 carries the new contract with a new hash, and revision 2 still shows the old one

#### Scenario: Contract cannot be removed
- **WHEN** the human publishes a draft that clears the contract of a task whose revision 2 carried one
- **THEN** the publication is refused naming the contract, and the draft remains

### Requirement: Task reads show each revision's contract
`task_get`, the Team page's task view, and its revision history SHALL show each revision's contract identity and, for a revision with a contract, its clauses and scope globs, or label it as having no contract.

#### Scenario: Revision history shows contracts
- **WHEN** the human opens the revision history of a task whose revision 1 had no contract and revision 2 has one
- **THEN** revision 1 is labeled as having no contract and revision 2 shows its identity, clauses, and scope
