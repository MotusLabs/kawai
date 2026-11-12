# Spec Delta

## ADDED Requirements

### Requirement: Tasks have an owner
Every task created by an agent session SHALL have an owner, starting as that session. Tasks created by the human or by Kawai SHALL have no owner. Ownership SHALL change only through a transfer, and the creator SHALL stay recorded as the task's author.

#### Scenario: Owner starts as the creator
- **WHEN** lead `A` creates a task
- **THEN** the task's creator and owner are both `A`

#### Scenario: Human task has no owner
- **WHEN** the human creates a task
- **THEN** the task has no owner

#### Scenario: Creator kept after transfer
- **WHEN** ownership of `A`'s task moves to lead `B`
- **THEN** the task names `A` as creator and `B` as owner

### Requirement: Agents transfer task ownership
`task_transfer_owner` SHALL take a `task_id` or a `from_session` (exactly one) and an optional `to_session` (default the caller). The owner MAY transfer to any live, non-flagged session of its group. Another session of the owner's group MAY take ownership for itself only when the owner is not a live session or is context-exhausted. Each move SHALL be journaled.

#### Scenario: Owner hands a task over
- **WHEN** owner `A` transfers its task with `to_session` naming lead `B` of its group
- **THEN** `B` owns the task and its journal records the move from `A` to `B` by `A`

#### Scenario: Taking over from an archived owner
- **WHEN** lead `B` calls the tool with the `task_id` of a task whose owner `A` is archived
- **THEN** `B` owns the task and its journal records the takeover

#### Scenario: Taking every task of a departed owner
- **WHEN** lead `C` calls the tool with `from_session` naming context-exhausted lead `A`
- **THEN** every open, active, and blocked task owned by `A` moves to `C`, done and cancelled tasks keep `A`, and the result lists the moved task ids

#### Scenario: Live owner refuses a takeover
- **WHEN** lead `B` tries to take a task whose owner `A` is live and not flagged
- **THEN** the tool refuses naming `A`, suggests messaging `A`, and nothing changes

#### Scenario: Caller outside the owner's group
- **WHEN** a developer tries to take a lead's task
- **THEN** the tool refuses and nothing changes

#### Scenario: Target outside the group or flagged
- **WHEN** owner `A` names a `to_session` that is a developer, archived, or context-exhausted
- **THEN** the tool refuses naming the target and nothing changes

#### Scenario: Ownerless task
- **WHEN** an agent tries to transfer a task the human created
- **THEN** the tool refuses because the task has no owner

#### Scenario: Neither or both selectors
- **WHEN** the tool is called with both `task_id` and `from_session`, or with neither
- **THEN** the tool refuses and nothing changes

### Requirement: Task reads name the owner
The task section of `task_get` SHALL carry the owner session, or null when the task has none. The human's task detail SHALL show the owner beside the creator when they differ.

#### Scenario: task_get after a transfer
- **WHEN** an agent reads a task that `A` created and `B` now owns
- **THEN** its task section carries creator `A` and owner `B`

## MODIFIED Requirements

### Requirement: Only the creator or the human amends direction
The task's direction and acceptance criteria SHALL be changeable only by the task's owner or the human; a task without an owner, only by the human or Kawai as before. A change SHALL become a new numbered revision only when published; the human's saved drafts are not revisions. Earlier revisions SHALL remain viewable. Other agents' attempts SHALL be refused with an error suggesting a journal note or a message to the owner.

#### Scenario: Creator amends
- **WHEN** the creating team lead amends the direction
- **THEN** the task shows the new direction as revision 2 and revision 1 remains viewable

#### Scenario: Contributor cannot amend
- **WHEN** a dev agent tries to amend a task it did not create
- **THEN** the tool returns an error and the direction is unchanged

#### Scenario: Human draft is not a revision
- **WHEN** the human saves a draft of a new direction without publishing it
- **THEN** the task still shows revision 1 as its direction

#### Scenario: New owner amends, former owner cannot
- **WHEN** ownership of `A`'s task moved to `B`, and then both try to amend it
- **THEN** `B`'s amendment becomes the next revision and `A`'s is refused naming `B` as the owner

### Requirement: Task status and closing
Any team member SHALL be able to set a task to `active` or `blocked`. Only the task's owner SHALL be able to set it to `done` or `cancelled`, and Kawai only on the tasks it created. The human SHALL be able to set any status, including reopening a closed task.

#### Scenario: Contributor reports blocked
- **WHEN** a dev sets a task to `blocked` with a journal note
- **THEN** the task shows `blocked`

#### Scenario: Contributor cannot close
- **WHEN** a dev tries to set a task it did not create to `done`
- **THEN** the tool returns an error and the status is unchanged

#### Scenario: Human reopens
- **WHEN** the user reopens a `done` task
- **THEN** the task becomes `open`

#### Scenario: New owner closes
- **WHEN** lead `B` took over a task created by archived lead `A` and sets it to `done`
- **THEN** the task becomes `done`

### Requirement: task_list returns compact rows
Each row of the agent `task_list` tool SHALL carry the task's id, title, status, creator, owner, parent, worktree, linked change, plan id and plan change, revision, creation and update times, a compact assignee (target kind and id, role, claimant, derived state) or null, and the outstanding result's id, verdict, and acceptance or null. Rows SHALL NOT carry direction, acceptance, the assignment instruction, or participants.

#### Scenario: Row omits the task's text
- **WHEN** an agent lists a task whose direction is 10,000 characters and whose assignment instruction is 4,000 characters
- **THEN** its row carries the title, status, and identifiers, and neither text appears in the result

#### Scenario: Assignee and result are compact
- **WHEN** a task is claimed by a member of `middle-devs` and holds an outstanding result with a passing review
- **THEN** its row names the group, the claimant, and the state, and carries the result's id with verdict pass

#### Scenario: Unassigned task without a result
- **WHEN** a task has no outstanding assignment and no result
- **THEN** its row has a null assignee and a null result

#### Scenario: Human views stay whole
- **WHEN** the human opens the Tasks tab
- **THEN** the tasks there carry their direction, acceptance, assignment, and participants as before

#### Scenario: Row names the owner
- **WHEN** an agent lists a task that `A` created and `B` now owns
- **THEN** its row carries creator `A` and owner `B`
