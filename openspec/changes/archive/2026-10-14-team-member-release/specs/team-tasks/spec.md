# Spec Delta

## MODIFIED Requirements

### Requirement: Tasks have an append-only journal
Any team member and the human SHALL be able to append journal entries to a task. The system itself SHALL also append entries for actions it takes on a task's behalf, authored as kawai. Entries SHALL record author, time, and text and SHALL NOT be editable or deletable.

#### Scenario: Agent notes a decision
- **WHEN** a dev appends a note explaining a design choice
- **THEN** the note appears in the task's journal with the dev as author

#### Scenario: System entry
- **WHEN** kawai releases a task's spawned member
- **THEN** the task's journal shows the entry with kawai as author, and it cannot be edited or deleted
