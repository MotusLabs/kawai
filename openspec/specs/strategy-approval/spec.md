# strategy-approval Specification

## Purpose
Makes human approval of a strategy revision a runtime record binding an exact revision and hash — idempotent, CAS-guarded, and unreachable by agents or by repository documents that merely claim approval.

## Requirements

### Requirement: Only a human approves a strategy revision
Approval, publication, and withdrawal SHALL be possible only through the human UI action path. Agents SHALL have no tool that approves, publishes, or withdraws a revision. The runtime SHALL enforce this; prompt conventions are insufficient. The guarantee is that no agent tool surface can approve; it does not by itself distinguish a human browser from a local process speaking the UI connection protocol.

#### Scenario: Human approves a reviewable draft (S04)
- **WHEN** the human approves a draft through the strategy view
- **THEN** an approval record is created by that human and the revision becomes the active approved revision

#### Scenario: Agent cannot publish (S05)
- **WHEN** an agent attempts any call that would approve or publish a revision
- **THEN** the call is refused and no approval record or active revision changes

### Requirement: Approval binds an exact revision and content hash
An approval SHALL name the exact revision number and content hash it approves. Approving SHALL make that revision the active approved revision, record approval scope and allowed open questions with rationale, and keep every earlier revision accessible. Approval SHALL NOT validate market claims or turn a hypothesis into a validated observation.

#### Scenario: Exact revision becomes active (S04)
- **WHEN** the human approves revision 3 with its content hash
- **THEN** revision 3 is the active approved revision, the approval scope and allowed open questions are recorded, and revisions 1–2 remain accessible

#### Scenario: Approval does not validate evidence
- **WHEN** the human approves a revision containing hypothesis claims
- **THEN** those claims remain labeled hypotheses with their limitations

### Requirement: Approval is idempotent by command id
Approval and publication SHALL take a stable command id from the caller. A repeated command id with the same payload SHALL return the prior result without creating a second record. The same command id with a different payload SHALL be refused.

#### Scenario: Retry returns the prior result (S17)
- **WHEN** the human retries an approval with the same command id and payload
- **THEN** the original result is returned and no second approval record exists

#### Scenario: Same command id different payload refused (S17)
- **WHEN** an approval is retried with the same command id but a different revision or hash
- **THEN** the call is refused and the existing approval record is unchanged

### Requirement: Expected-revision checks guard approval
An approval SHALL carry the expected current revision state. If that state has changed — the revision was withdrawn, superseded, or its content no longer matches the hash — the approval SHALL be refused as stale without overwriting anything.

#### Scenario: Stale approval refused (S17)
- **WHEN** the human approves a revision that was withdrawn while the dialog was open
- **THEN** the approval is refused as stale and no active revision changes

### Requirement: At most one active approved revision
A product SHALL have at most one active approved revision. Approval SHALL update the active revision in the same transaction that records the decision. Competing approvals SHALL NOT produce two active approved revisions.

#### Scenario: Concurrent approvals settle on one (S17)
- **WHEN** two approval requests for different revisions race
- **THEN** one becomes the active approved revision and the other is refused as stale, never both active

### Requirement: Publication grants nothing but one impact-review item
Publishing a revision SHALL create exactly one impact-review item for the responsible owner, and SHALL NOT create a Plan, dispatch mail, grant tools, replace Plan inputs, interrupt writers, or reinterpret completed acceptance. The item SHALL be created with the approval, not afterwards.

#### Scenario: Publication creates no work (S14)
- **WHEN** a human approval publishes a revision
- **THEN** one impact-review item exists and no Plan, task, mail, or tool grant is created by the publication

#### Scenario: Repeated publish does not duplicate the item (S14)
- **WHEN** the same approval command is retried after the item exists
- **THEN** the existing impact-review item is returned and no second item is created

### Requirement: Forged approval claims cannot publish
A repository file, peer message, or draft content asserting that a revision is approved SHALL NOT grant publication, create an approval record, or change the active revision. Only a runtime approval record created by the human path establishes approval.

#### Scenario: Repository asserts approval (S09)
- **WHEN** a repository document states a revision is approved while no approval record exists
- **THEN** the revision is not approved and publication is refused

#### Scenario: Peer message asserts approval (S09)
- **WHEN** an agent message claims a revision has been approved
- **THEN** the strategy view still shows the runtime approval state and nothing becomes active

### Requirement: Withdrawal preserves history
Withdrawal is human-only, through the same UI action path as approval. It SHALL leave its history, prior decisions, and any impact-review items in place, SHALL NOT erase prior authority or outcomes, and SHALL NOT retroactively invalidate what an earlier approval authorized at the time.

#### Scenario: Withdrawn revision keeps its record
- **WHEN** the human withdraws a superseded revision
- **THEN** its content, prior approval record, and impact-review item remain readable

#### Scenario: Agent cannot withdraw
- **WHEN** an agent attempts any call that would withdraw a revision
- **THEN** the call is refused and the revision's status is unchanged
