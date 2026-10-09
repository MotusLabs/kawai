# Spec Delta

## ADDED Requirements

### Requirement: Chat views show context window usage
The chat view header SHALL show how much of the session's context window the
conversation is using, as a percentage together with the used and window
token counts. The reading SHALL be absent until the session has produced a
model request, rather than showing a zero reading.

#### Scenario: Meter appears after the first model request
- **WHEN** a chat session completes its first model request
- **THEN** the chat view header shows the used token count, the window token count, and the percentage of the window in use

#### Scenario: No meter before any model request
- **WHEN** a chat session has not yet produced a model request
- **THEN** the chat view header shows no context meter

#### Scenario: Meter coexists with header chrome
- **WHEN** a chat view is open for a live session that has produced a model request
- **THEN** the context meter is shown beside the session status and the profile, project path, and session controls remain present

### Requirement: Context usage tracks the conversation as it grows
The reported context usage SHALL follow the conversation's window occupancy
as the turn proceeds, updating when each new model request's usage is
observed, so the reading moves during a long turn and not only at turn
completion.

#### Scenario: Reading grows during a multi-step turn
- **WHEN** a turn makes several model requests in sequence, each with a larger prompt than the last
- **THEN** the reported context usage rises after each request rather than only when the turn completes

#### Scenario: Reading is the current window, not cumulative traffic
- **WHEN** a turn has made many model requests so the session's cumulative token counts far exceed the window
- **THEN** the reported used tokens stay within the session's context window and describe the latest request's prompt size

### Requirement: Compaction resets the reported context usage
When the agent compacts the conversation, the system SHALL report the context
usage measured after that compaction at the moment the compaction is
signalled, so the meter drops alongside the compaction notice rather than
waiting for the next model request.

#### Scenario: Meter drops when the conversation auto-compacts
- **WHEN** a running conversation reaches its compaction threshold and auto-compaction summarises it
- **THEN** the reported context usage falls to the post-compaction size when the compaction is signalled to the chat view

#### Scenario: Manual compaction drops the meter too
- **WHEN** the conversation is compacted explicitly rather than by auto-compaction
- **THEN** the reported context usage falls to the post-compaction size in the same way

### Requirement: Context usage is measured against the session's window
The percentage and window token count SHALL use the context window of the
session's resolved model configuration, so a session whose profile configures
a different window meters against that window rather than a fixed default.

#### Scenario: Profile-configured window is the denominator
- **WHEN** a chat session runs under a profile that configures a 1000000-token context window
- **THEN** its percentage is computed against 1000000 and its window token count reads 1000000

#### Scenario: Unoverridden sessions meter against the model window
- **WHEN** a chat session runs without a profile context-window override
- **THEN** its percentage is computed against its model's context window

### Requirement: Context usage survives restarts and archives
The latest context usage SHALL be stored with the chat session and kept
across server restarts, conversation resume, archive, and restore. A restored
session SHALL show its last known reading. An archived session SHALL show its
final reading as history and SHALL NOT refresh it.

#### Scenario: Reading survives server restart
- **WHEN** a chat session has reported a context usage and the server restarts before the next model request
- **THEN** the chat view shows the stored reading rather than an empty meter

#### Scenario: Archived chat keeps its final reading
- **WHEN** a chat session is archived after producing a context usage
- **THEN** opening the archived chat shows that reading and no later update

#### Scenario: Reading survives restore
- **WHEN** an archived chat session is restored
- **THEN** it shows its stored reading and the next model request updates it
