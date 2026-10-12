# Spec Delta

## Purpose

Gives a team one durable record per feature or request — direction, acceptance criteria, status, and a journal — that every participating agent follows, with direction controlled by the task's creator.

## ADDED Requirements

### Requirement: Tasks can be created by the human and by permitted groups
The human SHALL be able to create a task for a team from the UI. A chat agent SHALL be able to create a task with a tool only when its group's frontmatter sets `canCreateTasks: true`; otherwise the tool SHALL return an error. A task SHALL record title, direction, optional acceptance criteria, creator, creation time, and status `open`.

#### Scenario: Team lead creates a task
- **WHEN** a member of a group with `canCreateTasks: true` creates a task
- **THEN** the task exists with that agent as creator and status `open`

#### Scenario: Dev cannot create a task
- **WHEN** a member of a group without `canCreateTasks` calls the create tool
- **THEN** the tool returns an error and no task is created

#### Scenario: Human creates a task
- **WHEN** the user creates a task from the team's task list
- **THEN** the task exists with the human as creator

### Requirement: Tasks may have a parent, a worktree, and a linked change
A task SHALL optionally reference a parent task of the same team, a target worktree, and an OpenSpec change. A target worktree SHALL be the repository's main working tree or one of its linked worktrees; any other path SHALL be refused. A linked change SHALL exist in the repository's OpenSpec changes.

#### Scenario: Subtask
- **WHEN** a team lead creates a task with a parent task
- **THEN** the task detail of the parent lists the new task as a subtask

#### Scenario: Invalid worktree refused
- **WHEN** a task is created with a target path that is not a worktree of the team's repository
- **THEN** creation is refused with an error naming the path

### Requirement: Only the creator or the human amends direction
The task's direction and acceptance criteria SHALL be changeable only by the task's creator or the human. Each change SHALL create a new numbered revision; earlier revisions SHALL remain viewable. Other agents' attempts SHALL be refused with an error suggesting a journal note or a message to the creator.

#### Scenario: Creator amends
- **WHEN** the creating team lead amends the direction
- **THEN** the task shows the new direction as revision 2 and revision 1 remains viewable

#### Scenario: Contributor cannot amend
- **WHEN** a dev agent tries to amend a task it did not create
- **THEN** the tool returns an error and the direction is unchanged

### Requirement: Tasks have an append-only journal
Any team member and the human SHALL be able to append journal entries to a task. Entries SHALL record author, time, and text and SHALL NOT be editable or deletable.

#### Scenario: Agent notes a decision
- **WHEN** a dev appends a note explaining a design choice
- **THEN** the note appears in the task's journal with the dev as author

### Requirement: Task status and closing
Any team member SHALL be able to set a task to `active` or `blocked`. Only the creator SHALL be able to set it to `done` or `cancelled`. The human SHALL be able to set any status, including reopening a closed task.

#### Scenario: Contributor reports blocked
- **WHEN** a dev sets a task to `blocked` with a journal note
- **THEN** the task shows `blocked`

#### Scenario: Contributor cannot close
- **WHEN** a dev tries to set a task it did not create to `done`
- **THEN** the tool returns an error and the status is unchanged

#### Scenario: Human reopens
- **WHEN** the user reopens a `done` task
- **THEN** the task becomes `open`

### Requirement: Messages may reference a task
Sending, replying, and scheduling SHALL accept an optional task id of the sender's team. A reply SHALL inherit its original message's task when none is given. A task id of another team or an unknown task SHALL be refused.

#### Scenario: Reply inherits task
- **WHEN** a dev replies without a task id to a message that referenced task T
- **THEN** the reply references task T

#### Scenario: Message without a task
- **WHEN** an agent sends a quick question without a task id
- **THEN** the message is delivered with no task header

### Requirement: Delivered task messages carry the task context
When a message referencing a task is delivered, the recipient SHALL receive with it the task's title, current direction and acceptance criteria, revision number, status, linked change, target worktree, and its most recent journal entries. If the task has a linked OpenSpec change, the context SHALL state that the change's artifacts are the authoritative direction.

#### Scenario: Task header on delivery
- **WHEN** a QA agent receives a message referencing task T
- **THEN** the delivered turn includes T's title, direction, status, and latest journal entries

#### Scenario: Linked change is authoritative
- **WHEN** a message references a task linked to OpenSpec change `add-x`
- **THEN** the delivered context names `add-x` and says its proposal, design, and tasks are the authoritative direction

### Requirement: Tasks are inspectable in the UI
The UI SHALL list a team's tasks with title, status, creator, and participants, and SHALL show a task's direction with revision history, journal, subtasks, and messages. The human SHALL be able to change status and amend direction from the task detail. A chat session working on a task SHALL show the task in its header.

#### Scenario: Task detail
- **WHEN** the user opens a task
- **THEN** its direction, revisions, journal, subtasks, and messages are shown

### Requirement: Tasks persist
Tasks, revisions, and journal entries SHALL persist across server restart and SHALL remain after their participating sessions are archived or killed.

#### Scenario: Creator killed
- **WHEN** a task's creating session is killed
- **THEN** the task remains, and the human can still amend and close it
