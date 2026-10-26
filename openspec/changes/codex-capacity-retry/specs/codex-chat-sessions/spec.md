# Spec Delta

## MODIFIED Requirements

### Requirement: Codex turns stream into the chat transcript
The system SHALL show a Codex turn in the chat transcript through the same event kinds Claude turns use. Streamed agent text SHALL appear as it arrives and be completed by the final message. Command executions, file changes, MCP and dynamic tool calls, and web searches SHALL appear as tool calls with their results. Logical turn completion SHALL settle status to waiting, and a terminal failure SHALL show its error. Capacity recovery SHALL keep the logical turn open between attempts.

#### Scenario: Streaming reply
- **WHEN** Codex streams an agent message
- **THEN** the transcript shows the text growing and then the completed message

#### Scenario: Command execution
- **WHEN** Codex runs a shell command during a turn
- **THEN** the transcript shows a tool call with the command, then its output and exit result

#### Scenario: Failed turn
- **WHEN** a Codex turn completes with an error outside an eligible capacity recovery
- **THEN** the transcript shows the error and the session status becomes waiting

#### Scenario: Capacity attempt fails
- **WHEN** an eligible capacity failure schedules a retry
- **THEN** the logical turn remains working, earlier text and tool results remain visible, and no terminal completion or idle transition is emitted between attempts

## ADDED Requirements

### Requirement: Codex capacity failures recover within a bounded window
After a turn fails with the structured error `serverOverloaded`, Kawai SHALL retry on the same thread and model within a ten-minute window measured from the first such terminal failure in the logical turn. Retries SHALL use exponential backoff with jitter and delays capped at sixty seconds. No retry SHALL start at or after the deadline. An attempt already running SHALL be allowed to finish; a later capacity failure SHALL end recovery.

#### Scenario: Capacity clears
- **WHEN** a failed capacity attempt is followed by a successful retry inside the window
- **THEN** the logical turn completes successfully on the same thread and model without human input

#### Scenario: Capacity persists
- **WHEN** capacity continues failing until the retry deadline
- **THEN** Kawai stops scheduling attempts, shows the capacity error and retry exhaustion, and settles the logical turn to waiting

#### Scenario: Attempt crosses the deadline
- **WHEN** an attempt started before the deadline is still running when the deadline passes
- **THEN** it is allowed to finish, its success is accepted, and a capacity failure after the deadline schedules no further attempt

#### Scenario: Other errors
- **WHEN** a failure has a different structured error kind, even if its text mentions capacity
- **THEN** this capacity retry policy does not retry it

### Requirement: Capacity recovery preserves conversation and work
Automatic capacity retries SHALL continue from the existing thread history, preserving completed tool work and approval policy. They SHALL NOT resubmit the original human message or peer envelope, redeliver mail, or automatically replay completed tool calls. Retry continuation input SHALL be identifiable as internal recovery in both live history and replay.

#### Scenario: Work before overload
- **WHEN** Codex completes a file edit and subsequently encounters capacity pressure
- **THEN** the retry continues with that edit and its result in context, without Kawai executing the edit again or adding another copy of the original request

#### Scenario: Mail recovery
- **WHEN** a turn processing delivered mail retries a capacity failure
- **THEN** the message remains held by that session, its receipt is unchanged, and retry alone does not park, forward, or release it

#### Scenario: Replay recovery history
- **WHEN** the conversation is reopened after capacity recovery
- **THEN** original user and peer input appear once, completed tool results remain available, and any recovery continuation input is marked as internal rather than shown as a new human instruction

### Requirement: Codex internal retries retain control of their attempt
When Codex reports `willRetry: true`, Kawai SHALL display retry activity and SHALL NOT start a competing capacity retry. Kawai SHALL schedule its own retry only after the matching attempt has terminally failed with `serverOverloaded`. Duplicate or stale notifications SHALL NOT start extra attempts or extend the deadline.

#### Scenario: Codex retries internally
- **WHEN** Codex reports a retrying capacity error before eventually succeeding
- **THEN** Kawai starts no additional turn and no capacity recovery window is needed

#### Scenario: Terminal duplicate
- **WHEN** the same failed attempt completion arrives twice
- **THEN** only one retry is scheduled and its deadline is unchanged

### Requirement: Capacity retries are visible and cancellable
While waiting for a capacity retry, the chat SHALL display its attempt number, time until the next attempt, and retry deadline. Stop SHALL cancel the pending retry immediately. Interrupt, archive, kill, shutdown, process exit, and superseding human input SHALL invalidate pending recovery. A browser reconnect SHALL restore current retry activity without scheduling an extra retry; backend restart SHALL NOT automatically resume an old retry timer.

#### Scenario: Stop during backoff
- **WHEN** the user presses Stop while waiting for a retry
- **THEN** the logical turn is interrupted, retry activity clears, and no delayed callback starts another attempt

#### Scenario: Human input during backoff
- **WHEN** the user sends a new message while waiting for a retry
- **THEN** the old recovery is cancelled and only the new input is sent to the same thread

#### Scenario: Lifecycle termination
- **WHEN** a session with a pending retry is archived, killed, shut down, or loses its agent process
- **THEN** the pending retry is cancelled and late callbacks cannot revive it

#### Scenario: Browser reconnect
- **WHEN** a browser reconnects while the backend is waiting for a retry
- **THEN** it shows the existing attempt and deadline and the backend retains only one pending retry

#### Scenario: Backend restart
- **WHEN** the backend restarts while waiting for a retry
- **THEN** the old timer does not resume and the conversation remains available for explicit continuation
