# Spec Delta

## Purpose

Makes approving a plan revision a human-only runtime decision bound to an exact revision and content hash. Approval is idempotent, refuses stale state, evaluates named preconditions, and grants or triggers nothing beyond the approval itself.

## ADDED Requirements

### Requirement: Only the human approves a plan revision
Approving a plan revision SHALL be a human action only, and the service SHALL refuse an agent caller. No agent tool SHALL approve. A repository file, peer message, or draft claiming a plan is approved SHALL grant nothing; only a recorded approval event makes a revision approved.

#### Scenario: Agent caller refused
- **WHEN** an approval reaches the plan service with an agent as the actor
- **THEN** it is refused and nothing is written

#### Scenario: Forged approval claim grants nothing
- **WHEN** a submitted revision's content states that the owner approved it
- **THEN** the revision stays `in_review` and the plan stays Draft until the human approves it

### Requirement: Approval binds an exact revision and content hash
An approval SHALL name the revision number and content hash the human reviewed. It SHALL be refused when that revision is not `in_review` or its hash differs. The approved revision's event SHALL record the approving actor, time, revision, hash, and command id.

#### Scenario: Hash mismatch refused
- **WHEN** the human approves revision 2 with a hash other than revision 2's content hash
- **THEN** approval is refused as `hash-matches` and revision 2 stays `in_review`

#### Scenario: Withdrawn revision refused
- **WHEN** the human approves a revision that was withdrawn
- **THEN** approval is refused as `revision-in-review`

### Requirement: Approval is idempotent by command id
Each approval SHALL carry a command id unique within its plan. Repeating a command id with the same payload SHALL return the prior result without writing. Repeating it with a different payload SHALL be refused, naming the differing field.

#### Scenario: Reconnect resend returns the prior result
- **WHEN** the client resends an approval with the same command id and payload after a reconnect
- **THEN** the prior result is returned, and exactly one approval event exists

#### Scenario: Changed payload refused
- **WHEN** a command id that approved revision 2 is reused to approve revision 3
- **THEN** the request is refused naming the revision, and revision 3 is unchanged

### Requirement: Stale approvals are refused
An approval SHALL carry the approved revision the human saw, or none. When the plan's active approved revision differs at commit time, the approval SHALL be refused as stale. Two racing approvals SHALL therefore never leave two active revisions.

#### Scenario: Racing approvals
- **WHEN** two clients that both saw approved revision 1 approve revisions 2 and 3 at once
- **THEN** one approval commits, the other is refused as stale, and exactly one revision is `approved`

#### Scenario: Approval after a newer approval
- **WHEN** the human approves revision 2 from a view that predates the approval of revision 3
- **THEN** approval is refused as `approved-revision-unchanged`, and revision 3 stays approved

### Requirement: Approval supersedes the previous approved revision
Approving a revision SHALL, in one transaction, mark it `approved`, mark the previously approved revision `superseded`, and set the plan's current approved revision. The superseded revision SHALL stay readable, and tasks linked to its changes SHALL keep their links.

#### Scenario: Revision 2 supersedes revision 1
- **WHEN** the human approves revision 2 of a plan whose revision 1 is approved
- **THEN** revision 2 is `approved`, revision 1 is `superseded`, and the plan's current approved revision is 2

#### Scenario: Linked tasks keep their links
- **WHEN** a newer revision is approved while tasks are linked to changes of the older one
- **THEN** every linked task keeps its plan and change exactly as created

### Requirement: Approval evaluates named preconditions
Approval SHALL evaluate an ordered list of named preconditions inside its transaction: `plan-open`, `revision-in-review`, `hash-matches`, `approved-revision-unchanged`, and `strategy-pin-current`. A refusal SHALL name every failing precondition with an actionable message and SHALL write nothing. Later capabilities MAY add preconditions to the list.

#### Scenario: Closed plan refused
- **WHEN** the human approves a revision of a cancelled plan
- **THEN** approval is refused naming `plan-open`

#### Scenario: Several failures named together
- **WHEN** an approval targets a withdrawn revision with a wrong hash
- **THEN** the refusal names both `revision-in-review` and `hash-matches`

### Requirement: A stale strategy pin blocks approval
When the team's current approved strategy revision differs from a revision's pin, approval SHALL be refused by `strategy-pin-current` and SHALL tell the author to resubmit so the pin is current. This includes a strategy approved after an unpinned submission. Approval with an older pin SHALL be possible only through a recorded disposition that a later capability defines.

#### Scenario: Strategy approved between submission and approval
- **WHEN** strategy revision 3 is approved after a plan revision pinned to strategy revision 2 was submitted
- **THEN** approving that plan revision is refused as `strategy-pin-current`

#### Scenario: Resubmission re-pins
- **WHEN** the author resubmits the same draft after strategy revision 3 is approved
- **THEN** the new plan revision pins strategy revision 3 and can be approved

### Requirement: Approval grants and triggers nothing else
Approving or withdrawing a plan revision SHALL change only the plan's revisions, its current approved revision, and its events. It SHALL create no task, mail, dispatch, tool grant, or interruption. It SHALL NOT rebind, amend, or notify linked tasks or their sessions.

#### Scenario: Busy linked agent is not interrupted
- **WHEN** a new revision is approved while an agent works on a task linked to the plan
- **THEN** no mail is sent, the agent's turn is not interrupted, and the task is unchanged

#### Scenario: No work is created
- **WHEN** the first revision of a plan is approved
- **THEN** no task, assignment, or message is created

### Requirement: Withdrawal preserves history
The human SHALL be able to withdraw an `in_review` revision or discard a draft. A withdrawn revision SHALL stay readable with status `withdrawn`, and each withdrawal or discard SHALL record a plan event. Approved and superseded revisions SHALL NOT be withdrawable.

#### Scenario: Withdraw a revision in review
- **WHEN** the human withdraws revision 2 while it is `in_review`
- **THEN** revision 2 is `withdrawn`, its content stays readable, and the history shows the withdrawal

#### Scenario: Approved revision cannot be withdrawn
- **WHEN** the human tries to withdraw the plan's approved revision
- **THEN** the request is refused and the revision stays approved
