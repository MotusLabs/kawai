# Spec Delta

## MODIFIED Requirements

### Requirement: A running execution keeps its revision
Approving another revision of the plan SHALL NOT change a running execution. It SHALL keep its revision, manifests, tasks, and instructions until the owner applies a newer approved revision to it through Apply. Apply SHALL be the only way a running execution's revision changes, and only forward; manifests SHALL keep the revision current at their dispatch. Without Apply, a newer revision SHALL run only in a new execution that skips changes already landed.

#### Scenario: Approval during an execution
- **WHEN** the owner approves revision 4 while an execution of revision 3 runs
- **THEN** the execution continues on revision 3, and Start for revision 4 is refused as `one-execution` until it finishes or is stopped

#### Scenario: Later instructions keep the revision
- **WHEN** revision 4 is approved but not applied while a change of revision 3's execution awaits review, and the review fails
- **THEN** the fix attempt's instruction and manifest still name revision 3

#### Scenario: Apply moves the execution forward
- **WHEN** the owner applies revision 4 to the running execution of revision 3
- **THEN** the execution's current revision is 4, and its history lists revisions 3 and 4

### Requirement: An execution records what it started from
An execution SHALL record its inputs at Start, and they SHALL never change afterwards:
- the plan, the revision, and the content hash;
- the validation report and input hash;
- the base branch and its commit;
- the floor checks with their CI mapping and the floor version;
- the landing mode, the parallel limit, and the merge method;
- who started it, and when.

The revision, content hash, report, and input hash recorded at Start SHALL stay as the first entry of the execution's revision history. Apply SHALL only append later entries and advance the execution's current revision; it SHALL change no other Start input. A later edit of the team's settings SHALL apply only to later executions.

#### Scenario: Settings edited during an execution
- **WHEN** the operator changes the team's parallel limit while an execution runs
- **THEN** the running execution keeps the limit it recorded and the next execution uses the new one

#### Scenario: The base branch moves on
- **WHEN** the base branch advances after Start and a change is provisioned later
- **THEN** the execution's recorded base commit is unchanged, and the change records the base branch's commit at its provisioning as its baseline

#### Scenario: Start's record survives an Apply
- **WHEN** the owner applies revision 4 to an execution started on revision 3, then resends the original Start
- **THEN** the history's first entry still names revision 3 with its hash and report, the Start replays to the same execution, and its base, floor, landing, and limits are unchanged
