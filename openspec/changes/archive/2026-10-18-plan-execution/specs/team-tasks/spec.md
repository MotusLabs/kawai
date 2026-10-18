# Spec Delta

## ADDED Requirements

### Requirement: Kawai creates the tasks of a plan execution
A plan execution SHALL create its tasks with Kawai as the creator, shown as "Kawai", never as the human or an agent session. Kawai SHALL be a creator only through a plan execution, and SHALL close its tasks under the existing closing rights. A Kawai task SHALL link to the plan change of the execution's revision, even when a later approved revision no longer names that change.

#### Scenario: Kawai's task in the task list
- **WHEN** an execution provisions change `api`
- **THEN** the team's task list shows a task for `api` created by Kawai, linked to the plan change and targeting `.worktrees/api`

#### Scenario: The link follows the execution's revision
- **WHEN** revision 4, approved during an execution of revision 3, drops change `cli`, and the execution then schedules `cli`
- **THEN** Kawai's task for `cli` links to `cli` of revision 3, and its creation is not refused

#### Scenario: An agent cannot close Kawai's task
- **WHEN** a dev sets the task Kawai created for its change to `done`
- **THEN** the tool returns an error, as for any task it did not create, and the status is unchanged

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
