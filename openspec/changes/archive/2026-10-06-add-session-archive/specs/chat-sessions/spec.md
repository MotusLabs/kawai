# Spec Delta

## ADDED Requirements

### Requirement: Users can archive a chat session
The system SHALL let a user archive a chat session from the chat view header and from the session's row in the navigator. Archiving SHALL stop the session's agent process and keep the session record, its conversation ID, its transcript, and its protocol log. Archiving SHALL be recorded durably and SHALL survive server restarts. Every attached client SHALL see the change.

#### Scenario: Archive an idle chat
- **WHEN** the user archives a chat session that has no turn in flight
- **THEN** the agent process is stopped, the session is marked archived for every attached client, and its conversation remains available

#### Scenario: Archive during a turn asks first
- **WHEN** the user archives a chat session while a turn is in flight
- **THEN** the system asks for confirmation, and on confirmation interrupts the turn, cancels pending approvals and questions for every attached client, and archives the session

#### Scenario: Archive is cancelled
- **WHEN** the user declines the confirmation for archiving a chat with a turn in flight
- **THEN** the turn continues and the session is not archived

#### Scenario: Archived state survives a restart
- **WHEN** the server restarts while a chat session is archived
- **THEN** the session is still listed as archived and no agent process is started for it

### Requirement: Archived chats open read-only without starting an agent
The system SHALL display an archived chat session's prior conversation read-only, with a Restore action and without a message composer, stop control, or pending-request actions. Opening, attaching to, or reconnecting to an archived chat session MUST NOT start an agent process. Messages sent to an archived chat session SHALL be refused with an error.

#### Scenario: Open an archived chat
- **WHEN** the user selects an archived chat session
- **THEN** its prior conversation is displayed with a Restore action, no composer is offered, and no agent process is started

#### Scenario: Message sent to an archived chat
- **WHEN** a client sends a message to an archived chat session
- **THEN** no agent process is started and the client receives an error saying the session is archived

### Requirement: Users can restore an archived chat session
The system SHALL let a user restore an archived chat session from the read-only chat view and from the session's row in the navigator. A restored session SHALL behave as before it was archived: the next message continues the same conversation.

#### Scenario: Restore and continue
- **WHEN** the user restores an archived chat session and then sends a message
- **THEN** the session is no longer archived for every attached client, the composer is offered, and the message continues the same conversation with prior history intact

### Requirement: Archived chats are kept until restored or killed
Archived chat sessions SHALL NOT be hidden or removed by the history lookback window. Kill SHALL remain available for archived chat sessions and SHALL remain the only action that permanently removes a chat session.

#### Scenario: Archived chat older than the lookback window
- **WHEN** a chat session was archived longer ago than the configured history lookback
- **THEN** it is still listed among archived sessions

#### Scenario: Kill an archived chat
- **WHEN** the user kills an archived chat session
- **THEN** the session, its record, and its protocol log are removed and it leaves the session list
