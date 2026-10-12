# Spec Delta

## ADDED Requirements

### Requirement: Chat views show the session's current model
The chat view header SHALL show the model the agent reports for the session,
as session metadata delivered with the session's turns. The display SHALL be
absent until the agent first reports a model, rather than showing a
placeholder or the profile's configured model.

#### Scenario: Model appears with the first turn
- **WHEN** a chat session that has not yet run a turn receives the agent's session metadata naming its model
- **THEN** the chat view header shows that model

#### Scenario: No model before the agent reports one
- **WHEN** a chat session has not yet received session metadata naming a model
- **THEN** the chat view header shows no model

#### Scenario: Model coexists with header chrome
- **WHEN** a chat view is open for a live session that has reported a model
- **THEN** the model is shown beside the session status and the profile, project path, context meter, and session controls remain present

#### Scenario: Archived chat shows its last model
- **WHEN** an archived chat session had reported a model before archiving
- **THEN** opening the archived chat shows that model and no later update

### Requirement: The displayed model follows mid-session changes
The displayed model SHALL be the latest one the agent reports, so a model
change made during the session (such as a `/model` switch) replaces the
displayed model once the agent reports metadata for a subsequent turn.

#### Scenario: Model switch updates the display
- **WHEN** the user switches the session's model mid-conversation and the next turn's session metadata names the new model
- **THEN** the chat view header shows the new model in place of the previous one

#### Scenario: Reconnect sees the latest model
- **WHEN** a client reconnects to a session whose model changed after the client last saw it
- **THEN** the reconnected client shows the latest model

### Requirement: The current model survives restarts and archives
The latest reported model SHALL be stored with the chat session and kept
across server restarts, conversation resume, archive, and restore. A restored
session SHALL show its last known model until the agent reports one again.

#### Scenario: Model survives server restart
- **WHEN** a chat session has reported a model and the server restarts before the next turn
- **THEN** the chat view shows the stored model rather than no model

#### Scenario: Model survives restore
- **WHEN** an archived chat session is restored
- **THEN** it shows its stored model and the next reported model updates it
