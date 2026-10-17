# Spec Delta

## ADDED Requirements

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
