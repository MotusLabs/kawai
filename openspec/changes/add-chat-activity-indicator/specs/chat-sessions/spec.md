# Spec Delta

## ADDED Requirements

### Requirement: Chat transcript shows the in-flight turn's activity
While a chat turn is in flight, the chat view SHALL show one activity row as the last entry of the transcript, naming what the agent is doing and how long it has been in that phase. The phases are: waiting for the model, thinking, preparing a tool's input, running a tool, and retrying an API request. The elapsed time SHALL count up live without new server messages.

#### Scenario: Waiting for the first token
- **WHEN** the user sends a message and the model has not yet produced any content
- **THEN** the transcript ends with a row reading "Waiting for model…" and an elapsed time that increases each second

#### Scenario: Model is thinking
- **WHEN** the model starts a thinking block
- **THEN** the activity row reads "Thinking…" and its elapsed time restarts from zero

#### Scenario: Tool input is being written
- **WHEN** the model starts a tool-use block whose input is still streaming
- **THEN** the activity row names that tool as being prepared, for example "Writing Edit input…"

#### Scenario: A tool is running
- **WHEN** a tool call has been shown and its result has not yet arrived
- **THEN** the activity row reads "Running <tool>…" with the time since that phase began

#### Scenario: Several tools are running
- **WHEN** more than one tool call of the turn is awaiting its result
- **THEN** the activity row reads "Running <n> tools…"

#### Scenario: API request is retried
- **WHEN** Claude Code reports an API retry with an attempt number, a maximum, and an error status
- **THEN** the activity row reads "Retrying (<attempt>/<max>, <status>)…"

#### Scenario: Turn ends
- **WHEN** the turn completes, is interrupted, or the agent process dies
- **THEN** no activity row is shown

### Requirement: Activity row yields to other visible progress
The chat view SHALL hide the activity row while assistant text is streaming, while an approval or question card awaits the user, and in archived or otherwise read-only chats. The row SHALL return when the turn enters another activity phase.

#### Scenario: Text is streaming
- **WHEN** the model is streaming assistant text
- **THEN** no activity row is shown below the streaming text

#### Scenario: Approval card pending
- **WHEN** a tool approval or agent question awaits the user
- **THEN** no activity row is shown, and after the user answers the row resumes with the next phase

#### Scenario: Archived chat
- **WHEN** the user opens an archived chat
- **THEN** no activity row is shown

### Requirement: Activity is live-only and restored on reconnect
Activity SHALL be ephemeral: it is not part of the conversation history, is not persisted, and does not change the session-list status. A client attaching or reconnecting during a turn SHALL receive the current activity phase and its start time so the row and elapsed time resume.

#### Scenario: Reconnect while thinking
- **WHEN** a client reconnects to a chat whose turn has been thinking for 10 seconds
- **THEN** the transcript ends with "Thinking…" showing roughly 10 seconds elapsed

#### Scenario: History has no activity rows
- **WHEN** a chat with completed turns is reopened or replayed from history
- **THEN** the transcript contains no activity rows

#### Scenario: Session list is unaffected
- **WHEN** a turn moves between activity phases
- **THEN** the session list still reports the session as working and receives no additional updates for the phase changes
