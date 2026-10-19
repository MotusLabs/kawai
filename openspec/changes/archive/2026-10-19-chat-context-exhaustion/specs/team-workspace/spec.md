# Spec Delta

## ADDED Requirements

### Requirement: Failed turns are not finished work
The morning summary SHALL count only turns that completed successfully as finished turns. A turn the agent reported as failed, including one marked as an error under a success subtype, SHALL never count.

#### Scenario: Exhausted turn in the summary
- **WHEN** a task-bound session's turn ended with `Prompt is too long`
- **THEN** the morning summary does not count it as a finished turn

### Requirement: The attention queue lists exhausted sessions
The attention queue SHALL list each context-exhaustion item with its cause (the session and terminal reason), its owner, its impact (the dropped message and task, if any), and a next action that opens its source. A dropped message's item opens its Mailbox row, and otherwise the item opens the chat.

#### Scenario: Item with a dropped message
- **WHEN** an exhaustion dead-lettered the lead's go mail
- **THEN** the item names the session and reason, is owned by the lead, and its action opens that Mailbox row expanded

#### Scenario: Item without mail
- **WHEN** a human-created session is flagged during a human-typed turn
- **THEN** the item is under needs you and its action opens the chat
