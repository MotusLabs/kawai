# Spec Delta

## ADDED Requirements

### Requirement: Turns the agent starts on its own are shown
When the agent starts a turn without a user message, such as after a
background task ends or a Monitor reports an event, the system SHALL show
that turn in the transcript like any other: streamed output, tool
activity, approvals, and a completion. The turn SHALL open with a line
naming its trigger instead of a user message. The session SHALL report
`working` until the turn ends.

#### Scenario: Background completion wakes the agent
- **WHEN** a background task ends while the chat is idle and the agent starts a turn in response
- **THEN** the transcript shows a trigger line with the task's summary, followed by the agent's streamed output and tool activity

#### Scenario: Agent-started turn reports working
- **WHEN** the agent starts a turn on its own
- **THEN** the session is reported as `working` until that turn completes, then returns to `waiting`

#### Scenario: Agent-started turn can be interrupted
- **WHEN** the user presses Stop during a turn the agent started on its own
- **THEN** the turn is interrupted exactly as a user-started turn would be

#### Scenario: Replayed history shows the trigger, not raw markup
- **WHEN** a client attaches to a chat whose history contains a turn the agent started because a background task ended
- **THEN** the turn opens with the same trigger line, and no user message bubble with notification markup is shown

#### Scenario: Trigger without a known cause
- **WHEN** the agent starts a turn on its own and no task notification preceded it
- **THEN** the turn opens with a generic trigger line saying the agent continued on its own
