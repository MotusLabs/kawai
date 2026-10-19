# Spec Delta

## ADDED Requirements

### Requirement: A result marked as an error completes the turn as failed
A turn SHALL count as failed when its result's subtype is not `success` or the result is marked as an error. A failed turn SHALL show an error in the transcript that names the terminal reason when one is given. Every reader of turn success SHALL treat it as failed: mail outcomes, turn-end records, turn usage, and process metrics.

#### Scenario: Success subtype with an error flag
- **WHEN** a result arrives with subtype `success`, `is_error: true`, text `Prompt is too long`, and terminal reason `blocking_limit`
- **THEN** the turn completes as failed, and the transcript shows an error naming `Prompt is too long` and `blocking_limit`

#### Scenario: Turn-end record
- **WHEN** such a turn ends in a task-bound session
- **THEN** its turn-end record marks it not successful

#### Scenario: Older history
- **WHEN** a stored turn completion has no error flag
- **THEN** it reads as before, by its subtype

### Requirement: Turn completion records the terminal reason
A completed turn SHALL carry the agent's terminal reason when the result gives one, so the transcript, the session's records, and recovery can read why it ended.

#### Scenario: Reason recorded
- **WHEN** a turn ends with terminal reason `max_turns`
- **THEN** its completion carries `max_turns`

### Requirement: Replayed history marks API error replies
Replay of a stored conversation SHALL show an assistant reply that the agent recorded as an API error as an error row, not as an ordinary assistant message.

#### Scenario: Reloaded exhausted turn
- **WHEN** a chat whose last reply was a recorded `Prompt is too long` API error is replayed after restart
- **THEN** that reply shows as an error row

### Requirement: Sessions show the context-exhausted flag
A flagged session SHALL carry the flag, with its time and reason, in the session list. The navigator row SHALL show a badge, and the chat header SHALL show a row stating that the context is exhausted and that `/compact` or a new session is needed. Both SHALL disappear when the flag clears.

#### Scenario: Header row
- **WHEN** the human opens a flagged chat
- **THEN** the header states the context is exhausted with its reason, and suggests `/compact` or a new session

#### Scenario: Flag clears
- **WHEN** the session reports a compaction boundary
- **THEN** the badge and the header row disappear
