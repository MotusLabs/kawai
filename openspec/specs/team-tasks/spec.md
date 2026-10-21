# team-tasks Specification

## Purpose

Gives a team one durable record per feature or request — direction, acceptance criteria, status, and a journal — that every participating agent follows, with direction controlled by the task's creator.

## Requirements

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
The task's direction and acceptance criteria SHALL be changeable only by the task's creator or the human. A change SHALL become a new numbered revision only when published; the human's saved drafts are not revisions. Earlier revisions SHALL remain viewable. Other agents' attempts SHALL be refused with an error suggesting a journal note or a message to the creator.

#### Scenario: Creator amends
- **WHEN** the creating team lead amends the direction
- **THEN** the task shows the new direction as revision 2 and revision 1 remains viewable

#### Scenario: Contributor cannot amend
- **WHEN** a dev agent tries to amend a task it did not create
- **THEN** the tool returns an error and the direction is unchanged

#### Scenario: Human draft is not a revision
- **WHEN** the human saves a draft of a new direction without publishing it
- **THEN** the task still shows revision 1 as its direction

### Requirement: Tasks have an append-only journal
Any team member and the human SHALL be able to append journal entries to a task. The system itself SHALL also append entries for actions it takes on a task's behalf, authored as kawai. Entries SHALL record author, time, and text and SHALL NOT be editable or deletable.

#### Scenario: Agent notes a decision
- **WHEN** a dev appends a note explaining a design choice
- **THEN** the note appears in the task's journal with the dev as author

#### Scenario: System entry
- **WHEN** kawai releases a task's spawned member
- **THEN** the task's journal shows the entry with kawai as author, and it cannot be edited or deleted

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
The UI SHALL list a team's tasks with title, status, creator, and participants, and SHALL show a task's direction with revision history and rationale, journal, subtasks, and messages. The human SHALL be able to change status, and to change direction from the task detail through **Save draft**, **Publish revision**, and **Publish and notify**. A chat session working on a task SHALL show the task in its header.

#### Scenario: Task detail
- **WHEN** the user opens a task
- **THEN** its direction, revisions, journal, subtasks, and messages are shown

#### Scenario: Three direction actions
- **WHEN** the user edits a task's direction in the detail
- **THEN** **Save draft**, **Publish revision**, and **Publish and notify** are offered as separate actions

### Requirement: Tasks persist
Tasks, revisions, and journal entries SHALL persist across server restart and SHALL remain after their participating sessions are archived or killed.

#### Scenario: Creator killed
- **WHEN** a task's creating session is killed
- **THEN** the task remains, and the human can still amend and close it

### Requirement: Tasks may link to a plan change
A task SHALL optionally name, at creation, a plan of its team and one change of that plan's current approved revision; both or neither SHALL be given. The plan SHALL be open and have an approved revision, and any other reference SHALL be refused naming it. The link SHALL be immutable after creation and SHALL survive later plan revisions.

#### Scenario: Linked at creation
- **WHEN** the lead creates a task naming plan P and its change `api`
- **THEN** the task records the link, and P's detail lists the task under `api`

#### Scenario: Plan without an approved revision refused
- **WHEN** a task names a plan that has only revisions in review
- **THEN** creation is refused naming the plan, and no task is created

#### Scenario: Unknown change refused
- **WHEN** a task names change `cli` of a plan whose approved revision has no change `cli`
- **THEN** creation is refused naming `cli`

#### Scenario: Another team's plan refused
- **WHEN** a task names a plan of another team
- **THEN** creation is refused as if the plan did not exist

### Requirement: Delivered mail for a linked task names its plan change
When a message referencing a task linked to a plan change is delivered, the task context SHALL name the plan's title and id, its current approved revision at delivery, and the change. Tasks without a link SHALL keep the existing context shape.

#### Scenario: Plan line on delivery
- **WHEN** an agent receives a message referencing a task linked to change `api` of plan P at approved revision 2
- **THEN** the delivered context names P, revision 2, and `api`

#### Scenario: Unlinked task unchanged
- **WHEN** an agent receives a message referencing a task without a plan link
- **THEN** the delivered context has no plan fields

### Requirement: Task status transitions are recorded
Every change of a task's status SHALL append one durable row naming the task, the previous and new status, the actor (the human, an agent session, or Kawai), and the time, in the same transaction as the change. Rows SHALL never be edited or deleted and SHALL survive restart and the actor's archive or kill. A request that leaves the status unchanged SHALL append nothing.

#### Scenario: Reopen is recorded
- **WHEN** the human reopens a `done` task
- **THEN** a transition from `done` to `open` by the human is recorded

#### Scenario: Acceptance closes the task
- **WHEN** accepting a result sets the task to `done`
- **THEN** a transition to `done` is recorded with the accepting actor

#### Scenario: Refused change
- **WHEN** a contributor's attempt to set `done` is refused
- **THEN** no transition is recorded

### Requirement: Kawai creates the tasks of a plan execution
A plan execution SHALL create its tasks with Kawai as the creator, shown as "Kawai", never as the human or an agent session. Kawai SHALL be a creator only through a plan execution, an owner's decision override, or a failed promotion, and SHALL close its tasks under the existing closing rights. An execution's task SHALL link to the plan change of the execution's revision, even when a later approved revision no longer names that change. A fix or correction task SHALL link to no plan change.

#### Scenario: Kawai's task in the task list
- **WHEN** an execution provisions change `api`
- **THEN** the team's task list shows a task for `api` created by Kawai, linked to the plan change and targeting `.worktrees/api`

#### Scenario: The link follows the execution's revision
- **WHEN** revision 4, approved during an execution of revision 3, drops change `cli`, and the execution then schedules `cli`
- **THEN** Kawai's task for `cli` links to `cli` of revision 3, and its creation is not refused

#### Scenario: An agent cannot close Kawai's task
- **WHEN** a dev sets the task Kawai created for its change to `done`
- **THEN** the tool returns an error, as for any task it did not create, and the status is unchanged

#### Scenario: Kawai's fix task for an override
- **WHEN** the owner overrides a Lead decision on a plan whose Lead role is `lead`
- **THEN** the task list shows a fix task created by Kawai, linked to no plan change, with its instruction dispatched to `lead`

### Requirement: Only Kawai links tasks to a running execution's changes
While a running execution owns a change, creating another task linked to that change SHALL be refused for the human and for agents, naming the execution. Links to other changes SHALL follow the plan-change link rules unchanged.

#### Scenario: A parallel task for a running change
- **WHEN** the Lead creates a task linked to change `api` while a running execution owns `api`
- **THEN** creation is refused naming the execution, and no task is created

#### Scenario: Linking after the execution
- **WHEN** the execution that owned `api` has finished
- **THEN** a task linked to `api` can be created under the plan-change link rules

### Requirement: Delivered mail for an execution task names its execution
When a message referencing a task that Kawai created for an execution is delivered, the task context SHALL also name the execution and the plan revision it runs, beside the plan's current approved revision. Other tasks SHALL keep their context shape.

#### Scenario: Execution line on delivery
- **WHEN** a dev receives a fix instruction for change `api` of an execution running revision 3 while revision 4 is approved
- **THEN** the context names the execution, revision 3 as the revision it runs, and revision 4 as the current approved revision

#### Scenario: Other tasks unchanged
- **WHEN** an agent receives mail for a task that no execution created
- **THEN** the delivered context has no execution fields
