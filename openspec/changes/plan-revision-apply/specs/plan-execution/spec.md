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
