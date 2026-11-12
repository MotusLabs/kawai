# Spec Delta

## Purpose

Tells the coordinator of a manually managed task when the task keeps gathering mail without progress, so advisory loops that formal-review signals never count become visible. The notice is advisory: nothing waits on it.

## ADDED Requirements

### Requirement: A stall episode is measured from the task's last progress
Kawai SHALL measure a task's stall from its anchor: the latest of the task's creation, its newest revision, its newest submitted result, its newest counted review, and its newest stall notice. Only mail on the task created after the anchor from an agent or the human SHALL count; Kawai's own mail never counts.

#### Scenario: A revision restarts the count
- **GIVEN** a task with 9 counted messages since its creation
- **WHEN** its creator publishes revision 2 and one more agent message arrives on the task
- **THEN** the count since the anchor is 1, and no notice is sent

#### Scenario: Kawai's mail is not counted
- **GIVEN** a task whose only mail since its anchor is 12 assignment and revision notices from Kawai
- **WHEN** the count is taken
- **THEN** the count is 0

### Requirement: A notice is sent when both thresholds are met
When a new message from an agent or the human is enqueued on a task and commits, Kawai SHALL send a stall notice if the task is active or open, no execution owns it, at least 10 counted messages arrived since the anchor, and at least 3 hours passed since the anchor. Otherwise it SHALL send nothing. A rolled-back message, a claim or delivery of an old message, and a task that receives no mail SHALL never trigger a notice.

#### Scenario: An advisory loop crosses both thresholds
- **GIVEN** an active manual task whose anchor is 3 h 10 min old with 9 counted messages after it
- **WHEN** a tenth agent message on the task commits
- **THEN** Kawai sends one stall notice for the task

#### Scenario: A rolled-back message triggers nothing
- **GIVEN** an active manual task whose anchor is 3 h old with 10 counted messages after it, gathered in its first 40 minutes
- **WHEN** an eleventh message on the task is enqueued inside a transaction that rolls back
- **THEN** no notice is sent

#### Scenario: Delivering old mail triggers nothing
- **GIVEN** an active manual task whose anchor is 3 h old with 10 counted messages after it, gathered in its first 40 minutes
- **WHEN** one of those messages is claimed and delivered
- **THEN** no notice is sent

#### Scenario: Many messages in a short time
- **GIVEN** an active manual task whose anchor is 40 minutes old
- **WHEN** its fifteenth counted message commits
- **THEN** no notice is sent

#### Scenario: An execution's task is left to plan supervision
- **GIVEN** a task an execution owns, past both thresholds
- **WHEN** another agent message on it commits
- **THEN** no stall notice is sent

#### Scenario: A blocked task is not noticed
- **GIVEN** a blocked task past both thresholds
- **WHEN** another agent message on it commits
- **THEN** no stall notice is sent

### Requirement: The notice is journaled and sent to a session creator
A stall notice SHALL journal on the task the counted messages, the elapsed time, the anchor's kind and time, and the counted senders. When the task's creator is a session, Kawai SHALL send it one system message tagged `task-stall` naming the same facts and the advisory-checkpoint rules. The notice SHALL NOT change the task's status, assignment, or any finding.

#### Scenario: The Lead's task stalls
- **GIVEN** a task created by a Lead session that crosses both thresholds
- **WHEN** the notice is sent
- **THEN** the task's journal has one Kawai entry naming the count, the elapsed time, and the last progress, and the Lead receives one message tagged `task-stall` on the task

#### Scenario: The human's task stalls
- **GIVEN** a task the human created that crosses both thresholds
- **WHEN** the notice is sent
- **THEN** the journal entry is written and no message is sent

#### Scenario: Nothing waits on the notice
- **WHEN** a stall notice is sent for an active task
- **THEN** the task stays active, its assignment is unchanged, and later mail on it is delivered as before

### Requirement: Each episode sends at most one notice
Kawai SHALL send at most one stall notice per task and anchor, across concurrent evaluations, replays, and restarts. A notice SHALL become the task's new anchor, so a loop that continues gets its next notice only after both thresholds are met again.

#### Scenario: Two messages commit together past the thresholds
- **GIVEN** a task past both thresholds
- **WHEN** two counted messages on it commit and both evaluations run
- **THEN** exactly one notice row, one journal entry, and at most one message exist for that anchor

#### Scenario: The loop continues after a notice
- **GIVEN** a task that received a stall notice
- **WHEN** 10 more counted messages arrive within 1 hour of the notice
- **THEN** no second notice is sent until 3 hours have passed since the first one

#### Scenario: A dropped evaluation is recovered by the next message
- **GIVEN** a counted message that crosses both thresholds committed, and the server stopped before evaluating it
- **WHEN** the next counted message on the task commits after the restart
- **THEN** exactly one notice is sent, measured from the original last progress

#### Scenario: A restart does not repeat a notice
- **GIVEN** a task noticed before the server restarted
- **WHEN** the next counted message on it commits after the restart, before the thresholds are met again
- **THEN** no notice is sent
