# Spec Delta

## Purpose

Lets the plan's owner apply a newer approved plan revision to a running execution in place. Kawai classifies each change, publishes new direction to changed work through task revisions, schedules added changes, and cancels removed ones. It refuses anything that would contradict a change that has already landed.

## ADDED Requirements

### Requirement: Only the owner applies a revision to a running execution
The human SHALL be able to apply the plan's current approved revision to its running execution, naming the execution's current revision, the target revision and content hash, a choice per changed change, and a rationale, under a command id. A replay SHALL return the prior result without publishing again; a different payload under the same id SHALL be refused naming the field. No agent tool SHALL apply a revision.

#### Scenario: A lost Apply result replays
- **WHEN** an Apply succeeds, its result is lost, and the dialog resends it
- **THEN** the same execution revision is returned, and no second revision row, task revision, or notice exists

#### Scenario: Agents cannot apply
- **WHEN** an agent looks for a tool to apply a revision, or calls the service path directly
- **THEN** no such tool exists and the direct call is refused with nothing written

### Requirement: Apply evaluates named preconditions
Apply SHALL evaluate in order: `plan-open`, `execution-running`, `execution-revision-unchanged`, `revision-current`, `revision-newer`, `validation-current`, `start-conditions-resolved`, `strategy-impact`, `landing-unchanged`, `landed-unchanged`, `merge-quiet`, `choices-complete`, and, for the changes it adds or re-dispatches, `changes-unclaimed`, `changes-on-base`, and `roles-routable`. Any failure SHALL refuse, naming every failing entry, and write nothing.

#### Scenario: A concurrent Apply wins
- **WHEN** two Apply commands name the same execution revision and the first commits
- **THEN** the second is refused as `execution-revision-unchanged`, naming the execution's new revision

#### Scenario: The target revision lacks standing
- **WHEN** the owner applies a revision whose validation report is out of date
- **THEN** Apply is refused as `validation-current` with V5's message

### Requirement: Kawai classifies every change against the running revision
Apply SHALL classify each change, by name, as unchanged, changed (listing its differing fields among dependencies, groups, acceptance, extra checks, guidance, and the effective review group), added, or removed. Every changed change that has a task SHALL need a choice of continue, adapt, or restart. A changed change without a task SHALL take the new definition when provisioned.

#### Scenario: The preview shows the delta
- **WHEN** the owner opens Apply for revision 4 over an execution of revision 3
- **THEN** the dialog lists each change's class and changed fields, and asks a choice only for changed changes that have tasks

#### Scenario: A missing choice is refused
- **WHEN** an Apply omits the choice for a changed change with a task
- **THEN** it is refused as `choices-complete`, naming the change

### Requirement: Landed work is never redefined
Apply SHALL refuse as `landed-unchanged` a revision that removes a landed change, changes a landed change's definition other than its dependencies, or changes plan-wide acceptance rules or extra checks once any change has landed. It SHALL refuse as `landing-unchanged` a change of landing mode or integration branch. Each refusal SHALL name the changes and point to a forward fix change.

#### Scenario: A landed change was edited
- **WHEN** revision 4 changes the acceptance of change `api`, which already landed
- **THEN** Apply is refused as `landed-unchanged`, naming `api` and suggesting a change that fixes it forward

#### Scenario: A forward fix is applied
- **WHEN** revision 4 leaves landed changes as they were and adds change `api-fix` whose `fixes` names the override's fix task
- **THEN** Apply succeeds and `api-fix` is scheduled in the running execution

### Requirement: Each choice publishes or dispatches as recorded
On Apply, a changed change chosen continue SHALL keep its running attempt; adapt SHALL publish the task's next revision with notify through task revision publication, returning the change for re-evaluation; restart SHALL supersede its assignment and dispatch a new attempt under the new revision. Added changes SHALL be scheduled by their dependencies. Removed unlanded changes SHALL be cancelled with their tasks.

#### Scenario: Adapt notifies the developer
- **WHEN** the owner applies revision 4 choosing adapt for change `ui`, whose developer holds its attempt
- **THEN** `ui`'s task has a new revision with the owner's rationale, the developer has the revision notice, and a fix attempt naming that revision follows

#### Scenario: A removed change is cancelled
- **WHEN** revision 4 drops unlanded change `docs`
- **THEN** `docs` is cancelled in the execution, its task is cancelled by Kawai, and its pending effects are cancelled

### Requirement: The publication commits atomically
Apply SHALL commit in one transaction the execution's next revision, a publication row per change with its class and choice, the task revisions Adapt published with their notices, the cancellations, and a `revision-applied` plan event. A crash before commit SHALL leave nothing; a retry after commit SHALL replay. Notices SHALL follow shipped mail delivery and receipt recovery.

#### Scenario: Crash before commit
- **WHEN** the server stops during Apply's transaction
- **THEN** after restart the execution keeps its previous revision and no task revision or notice from that Apply exists

#### Scenario: Retry after commit
- **WHEN** the server stops after Apply committed and the owner retries the same command
- **THEN** the retry replays the recorded result, and each task has exactly one new revision and notice

### Requirement: The execution keeps its revision history
Each execution SHALL keep every revision it held, with when and why it was applied and the publication rows, in `team-plan-detail` and `plan_get`. Attempt manifests SHALL keep the revision current at their dispatch. The execution SHALL complete when every change of its current revision has landed.

#### Scenario: Manifests keep their revision
- **WHEN** a change chosen continue fails review after revision 4 was applied
- **THEN** the running attempt's manifest still names revision 3, and the fix attempt's manifest names revision 4

#### Scenario: Completion after Apply
- **WHEN** every change of the applied revision 4 has landed and revision 4 is still approved
- **THEN** the execution completes and the plan is completed by the system
