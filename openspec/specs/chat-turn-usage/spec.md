# chat-turn-usage Specification

## Purpose
Records the tokens every completed chat turn spent, attributed to its session, group, profile, model, task, and agent start, so a team's process cost can be measured without currency.

## Requirements

### Requirement: Kawai records usage per completed turn
When a chat turn completes, Kawai SHALL record one usage row naming the session, its team, group, profile, model, the turn's task pinned at its start (or none), the agent start that ran it, the outcome, the input, output, cache-read, and cache-creation token counts, and the steps the turn took. Every chat session's turns SHALL be recorded, with or without a group or task.

#### Scenario: A task-bound turn completes
- **WHEN** a dev working on task T completes a turn
- **THEN** one usage row names T, the dev's group, profile, model, and agent start, with its four token counts and steps

#### Scenario: A turn outside any task completes
- **WHEN** a lead with no associated task completes a turn
- **THEN** a usage row is recorded with no task and the lead's group

#### Scenario: A session without a group
- **WHEN** a chat with no group completes a turn
- **THEN** a usage row is recorded with no group

### Requirement: A turn's task is pinned when the turn starts
A turn started by delivered mail SHALL take that mail's task, and no task when the mail has none, even on a task-bound session. Any other turn SHALL take the session's task at turn start. Mail delivered or task associations changed while a turn runs SHALL NOT retarget that turn, and SHALL NOT carry over to the next turn.

#### Scenario: Task-less mail to a task-bound session
- **WHEN** a dev associated with task T starts a turn for mail that names no task
- **THEN** that turn's usage row names no task

#### Scenario: Association changes mid-turn
- **WHEN** a session's turn started under task T and task mail for U is delivered before it completes
- **THEN** that turn's usage row names T

#### Scenario: Mid-turn delivery does not carry over
- **WHEN** mail for task U is delivered during a turn and the next turn is started by the human
- **THEN** the next turn takes the session's task at its own start, not U's mail

### Requirement: Usage records are tokens only and state what they omit
Usage rows SHALL hold token counts and steps only, never a currency amount. Token fields the agent did not report SHALL read 0. Any view or tool that shows recorded usage SHALL state that usage spent by Task subagents and by turns that never completed is not counted.

#### Scenario: Missing token fields
- **WHEN** a turn's result reports output tokens but no cache fields
- **THEN** its usage row records the output tokens and 0 for both cache fields

#### Scenario: An interrupted turn
- **WHEN** a turn is interrupted before it completes
- **THEN** no usage row is written for it

### Requirement: A turn is recorded at most once
Kawai SHALL record a turn's usage at most once, keyed by its session and turn. A failure to record SHALL be logged and SHALL NOT affect the turn, its events, or mail settlement.

#### Scenario: Duplicate completion event
- **WHEN** the same turn's completion is handled twice
- **THEN** exactly one usage row exists for it

#### Scenario: The write fails
- **WHEN** writing a usage row fails
- **THEN** the turn completes normally and the failure is logged

### Requirement: Usage rows are retained for 60 days
Usage rows SHALL survive restart and SHALL be retained for at least 60 days after the turn ended; older rows MAY be pruned. Killing, archiving, or restoring a session SHALL NOT remove its usage rows.

#### Scenario: A killed session's usage
- **WHEN** a session is killed a day after its turns ran
- **THEN** its usage rows remain and still count toward its team

#### Scenario: Restart
- **WHEN** the server restarts
- **THEN** usage rows recorded before it are still present
