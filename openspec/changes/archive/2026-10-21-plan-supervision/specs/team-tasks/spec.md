# Spec Delta

## MODIFIED Requirements

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
