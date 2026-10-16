## MODIFIED Requirements

### Requirement: Task rows show workflow stage separately from task status
Each task row SHALL show its title, task status, workflow stage, accountable session or role, worktree, current waiting reason, and next action. The workflow stage SHALL be projected from the task's assignment and its result, findings, and handoff records, and displayed separately from task status. A finished agent turn SHALL NOT mark a task done.
#### Scenario: Stage and status are distinct
- **WHEN** an assigned task's agent finishes a turn with no result submitted
- **THEN** the row still shows the task's own status and a workflow stage of Implementing, not done

#### Scenario: A review request moves the stage
- **WHEN** a result's review handoff is outstanding
- **THEN** the row shows a workflow stage of In review alongside the unchanged task status

#### Scenario: A queued review handoff already shows In review
- **WHEN** a review handoff is dispatched and still queued while its result is unaccepted
- **THEN** the row shows In review — the ladder's handoff order precedes Awaiting acceptance

#### Scenario: Failing findings show Fixes requested
- **WHEN** no handoff is outstanding and the newest findings bound to the task's unaccepted outstanding result have the verdict fail
- **THEN** the row shows a workflow stage of Fixes requested and a next action of Wait for fixes, not Awaiting acceptance

#### Scenario: Passing findings leave the result awaiting acceptance
- **WHEN** the newest findings bound to the unaccepted outstanding result have the verdict pass, or the result has no findings
- **THEN** the row shows a workflow stage of Awaiting acceptance

#### Scenario: A closed task shows no stage
- **WHEN** a task's status is done while its last assignment stands delivered
- **THEN** the row shows no workflow stage, not Implementing

#### Scenario: Accountability falls back to the requested role
- **WHEN** a group assignment is queued with no claimed agent
- **THEN** the row shows the requested role as the accountable party and names no session

### Requirement: The attention queue lists what needs a human or is waiting on an agent
The attention queue SHALL consolidate pending approvals and questions, uncertain deliveries, staffing waits, pending acceptance, and results whose review requested fixes. Each item SHALL show its cause, owner, impact scope, next action, and a link to its card, task, or message. Human-required items SHALL be separated from agent-owned waits. Pending acceptance SHALL be owned by the party expected to close the task.
#### Scenario: An open approval is a human-required item (E05)
- **WHEN** a session has a pending approval
- **THEN** the queue lists it as human-required with the session as owner, its task as impact scope, and a link to that chat's approval card

#### Scenario: A staffing wait is agent-owned (E05)
- **WHEN** a message waits on a group cap
- **THEN** the queue lists it under agent-owned waits with the capacity as its cause and a link to the message

#### Scenario: An uncertain delivery needs the human
- **WHEN** a message is held as an uncertain delivery
- **THEN** the queue lists it as human-required with retry or discard as its next action and a link to the message

#### Scenario: Pending acceptance needs the human
- **WHEN** a submitted result of a task the human created awaits **Accept result**, and its newest findings, if any, pass
- **THEN** the queue lists it as human-required with the task as impact scope and a link to the task

#### Scenario: An agent-created task's acceptance waits on its creator
- **WHEN** a submitted result of a task created by a live agent session awaits acceptance, and its newest findings, if any, pass
- **THEN** the queue lists it under agent-owned waits with that session as owner, the task as impact scope, and a link to the task
- **AND** the human can still accept the result from the task

#### Scenario: A creator that is gone hands acceptance to the human
- **WHEN** the agent session that created the task is archived or killed and the task's result awaits acceptance
- **THEN** the queue lists that pending acceptance as human-required

#### Scenario: Failing findings are a wait for fixes
- **WHEN** the newest findings bound to a task's unaccepted outstanding result have the verdict fail
- **THEN** the queue lists one agent-owned fixes-requested item with the result's submitter as owner, Wait for fixes as its next action, the task as impact scope, and a link to the task
- **AND** no pending acceptance is listed for that result
