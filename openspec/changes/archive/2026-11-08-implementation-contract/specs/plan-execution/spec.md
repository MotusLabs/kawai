# Spec Delta

## MODIFIED Requirements

### Requirement: Kawai creates and dispatches one task per change
After provisioning, the execution SHALL create one task for the change. Its creator SHALL be Kawai. The task SHALL be linked to the plan change, target the worktree, name the OpenSpec change, and carry the change's guidance and acceptance rules. Its revision 1 SHALL carry the contract parsed from the `## Implementation contract` section of the change's `design.md` at the change's baseline commit; when that section is missing or does not parse, the task SHALL be created without a contract and Kawai SHALL journal why. Kawai SHALL then dispatch it to the change's implementing group. The instruction SHALL name the change, branch, plan revision, and contract identity, ask for a committed result through the result tool, and say that Kawai pushes.

#### Scenario: The implementer receives Kawai's instruction
- **WHEN** a change is provisioned
- **THEN** its task exists with Kawai as creator and one assignment dispatched by Kawai, and a member of the implementing group in that worktree receives the instruction

#### Scenario: A later execution creates fresh tasks
- **WHEN** the owner starts a new execution after stopping one
- **THEN** each unlanded change gets a new task created by Kawai, and the stopped execution's cancelled tasks stay as they were

#### Scenario: The task carries the design's contract
- **WHEN** a change whose `design.md` at the baseline commit has a well-formed Implementation contract section is provisioned
- **THEN** its task's revision 1 carries that contract, and the instruction names its identity `r1#<hash>`

#### Scenario: A change without a contract section
- **WHEN** a change whose `design.md` at the baseline commit has no Implementation contract section is provisioned
- **THEN** its task is created and dispatched without a contract, and the task journal says the section was missing

## ADDED Requirements

### Requirement: Artifact edits never change an execution task's contract
After its task is created, a change's contract SHALL change only when the human publishes a new task revision. Edits to the change's artifacts on its branch, on the base branch, or in any worktree SHALL NOT change the task's contract or its identity.

#### Scenario: Design edited on the change branch
- **WHEN** the implementer commits an edit to the Implementation contract section of the change's `design.md`
- **THEN** the task's contract and identity are unchanged

#### Scenario: Human publishes a new contract
- **WHEN** the human publishes a new revision of a running change's task with a replaced contract
- **THEN** the new revision carries that contract, and the change is returned for re-evaluation as for any new task revision
