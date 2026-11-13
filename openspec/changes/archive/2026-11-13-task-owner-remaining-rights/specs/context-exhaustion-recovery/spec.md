## MODIFIED Requirements

### Requirement: The dispatcher is asked to decide
When a session is flagged while bound to a task, kawai SHALL send one normal-priority direct note tagged `context-exhausted` with that task to the dispatcher of the task's outstanding assignment, else to the task's owner. It SHALL send nothing when that recipient is the human, killed, archived, or itself flagged.

#### Scenario: Lead dispatched the work
- **WHEN** a dev spawned for a task the lead assigned is flagged
- **THEN** the lead receives one normal-priority `context-exhausted` note on that task

#### Scenario: Human dispatched the work
- **WHEN** the outstanding assignment was dispatched by the human
- **THEN** no note is sent, and the attention queue shows the item to the human

#### Scenario: Dispatcher itself exhausted
- **WHEN** the dispatcher session is flagged too
- **THEN** no note is sent to it, and the attention queue shows the item to the human

#### Scenario: Unassigned work goes to the owner
- **WHEN** a session bound to a task with no assignment is flagged, after the task's creator handed it to another lead
- **THEN** that lead, the task's owner, receives the note, and the creator receives none
