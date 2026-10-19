# Spec Delta

## ADDED Requirements

### Requirement: Mail dropped by an exhausted turn is dead-lettered
When a turn that flags its session as context-exhausted was handling delivered mail, that message SHALL move from delivered to dead with reason `context-exhausted`, recorded in its history. The Mailbox SHALL show a readable label for the code.

#### Scenario: Go mail dropped
- **WHEN** the lead's mail is delivered and the turn it starts ends with `blocking_limit`
- **THEN** the message is a dead letter with reason `context-exhausted`, not delivered

#### Scenario: Ordinary failure
- **WHEN** a turn handling delivered mail fails with `api_error`
- **THEN** the message stays delivered

### Requirement: Retry of a context-exhausted dead letter avoids the flagged session
Retrying a `context-exhausted` dead letter addressed to a group SHALL requeue it to that group, where the flagged session is not a candidate. Retrying one addressed to a session SHALL be refused while that session is flagged.

#### Scenario: Group mail retried
- **WHEN** the human retries a `context-exhausted` dead letter addressed to `middle-devs`
- **THEN** it is queued to the group and cannot go to the flagged member

#### Scenario: Direct mail retried
- **WHEN** the human retries one addressed to the still-flagged session
- **THEN** the retry is refused naming the flag

### Requirement: Direct mail to a flagged session is refused
New direct mail or a reply addressed to a flagged session SHALL be refused, from an agent or the human, naming the flag, with nothing queued. Direct mail already queued for a session SHALL be dead-lettered `context-exhausted` when it is flagged. A flagged archived session SHALL never be restored by mail.

#### Scenario: Lead replies to the dead dev
- **WHEN** the lead replies in a thread whose sender is the flagged session
- **THEN** the reply is refused naming the flag, and the session is not restored

#### Scenario: Queued direct mail
- **WHEN** a session is flagged while direct mail to it is queued
- **THEN** that mail becomes a `context-exhausted` dead letter
