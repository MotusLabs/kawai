# Spec Delta

## MODIFIED Requirements

### Requirement: Chat session status derives from conversation events
The system SHALL derive a chat session's status directly from its
conversation events and spawned workers: working while a turn is in flight
or while any spawned worker is running, permission while an approval is
pending, and waiting when idle — without parsing agent log
files. Status changes SHALL be broadcast through the existing session-update
mechanism.

#### Scenario: Turn in flight reports working
- **WHEN** a chat session's turn starts producing events
- **THEN** the session is reported as working in the session list

#### Scenario: Pending approval reports permission
- **WHEN** a chat session has an unanswered approval card
- **THEN** the session is reported as permission in the session list

#### Scenario: Idle session reports waiting
- **WHEN** a chat session's turn completes with no pending approval
- **THEN** the session is reported as waiting in the session list

#### Scenario: Background workers keep the session working
- **WHEN** a chat session's turn has completed but one or more spawned workers are still running
- **THEN** the session is reported as working in the session list

#### Scenario: Session returns to waiting when the last worker settles
- **WHEN** the last running worker of a chat session settles and no turn is in flight
- **THEN** the session is reported as waiting in the session list

#### Scenario: A worker that has left the running set does not hold the session
- **WHEN** a worker is no longer reported among the running work and has not yet reported its result, and no turn is in flight
- **THEN** the session is reported as waiting in the session list

#### Scenario: Composer accepts messages while workers run
- **WHEN** a chat session is reported as working only because spawned workers are running
- **THEN** the user can still submit a new message and the agent accepts it
