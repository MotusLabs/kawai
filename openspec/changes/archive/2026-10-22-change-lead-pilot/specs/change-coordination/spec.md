# Spec Delta

## Purpose

Lets a team delegate detailed coordination of a complex change to a named Change Lead while preserving independent review, creator rights, and cross-change integration ownership. Provides a bounded pilot with traceable evidence and safe withdrawal.

## ADDED Requirements

### Requirement: Delegation is explicit and bounded
The pilot protocol SHALL require a Team Lead-owned parent task identifying one manually coordinated OpenSpec change, its Change Lead session, approved scope, contract boundaries, escalation triggers, evaluation window, and baseline selection. Only one change SHALL participate at a time. Installing the protocol SHALL NOT enroll work or start agents.

#### Scenario: Eligible change enrolled
- **WHEN** the Team Lead enrolls a complex change outside a running execution
- **THEN** the parent task records the named coordinator, scope, boundaries, evaluation plan, and next action before implementation assignments are dispatched

#### Scenario: Ordinary task stays direct
- **WHEN** a task has no explicit pilot delegation
- **THEN** its developer and reviewer follow the existing Team Lead reporting path

#### Scenario: Execution owns the change
- **WHEN** a running execution owns a candidate change
- **THEN** the protocol excludes it from manual pilot dispatch and preserves Kawai's execution-owned handoffs

### Requirement: The Change Lead uses existing rights
The repository SHALL provide a Change Lead role permitted to create tasks and coordinate across worktrees. Its protocol SHALL use existing creator, assignment, mailbox, and release rights without granting ownership by hierarchy. Plan creation, team-wide mailbox management, and process-report submission SHALL remain outside this role.

#### Scenario: Creating implementation subtasks
- **WHEN** the named Change Lead decomposes an enrolled change
- **THEN** it creates subtasks with itself as creator, the Team Lead's task as parent, the linked change, and bounded direction and acceptance

#### Scenario: Parent owner cannot amend child
- **WHEN** the Team Lead needs a Change Lead-created subtask amended
- **THEN** it requests an amendment from that creator or the human rather than treating parent ownership as amendment authority

### Requirement: Local decisions have an escalation boundary
The Change Lead SHALL resolve implementation clarifications and assignments within the approved scope and published contracts. Changes to cross-change contracts, scope, shared schema or protocol commitments, and reserved human decisions SHALL return to the Team Lead or human as applicable. Dependent work SHALL wait for authoritative direction; independent authorized work SHALL continue.

#### Scenario: Local clarification resolved
- **WHEN** a developer asks an implementation question within unchanged scope and contracts
- **THEN** the Change Lead records a decision and amends its subtask revision when direction changes, without requiring duplicate Team Lead approval

#### Scenario: Contract change discovered
- **WHEN** a proposed fix changes another change's published contract
- **THEN** the Change Lead records the impact and escalates before dependent implementation proceeds

### Requirement: Developers remain a shared resource
The pilot SHALL assign coherent task groups from existing developer roles without creating dedicated pools or increasing caps. Each implementation assignment SHALL name one writer and one worktree. Conflicting assignments or shared-file ownership SHALL be reconciled before concurrent dispatch.

#### Scenario: Two independent task groups
- **WHEN** the Change Lead dispatches two independently implementable groups
- **THEN** each has a separate worktree, explicit ownership, and dependency/contract references

#### Scenario: Same developer already committed
- **WHEN** a candidate developer holds another active assignment
- **THEN** the coordinator reconciles availability with the responsible coordinator or records a wait instead of assuming exclusive access

### Requirement: Pilot reporting names one coordinator
Pilot subtask direction SHALL identify the coordinator session and parent task. Routine developer and reviewer reports SHALL go directly to that coordinator, include task and result or finding references, and omit a mailbox task binding. Technical clarification SHALL retain task references. Non-pilot reporting SHALL remain unchanged.

#### Scenario: Result reported locally
- **WHEN** a developer submits a result for an enrolled subtask
- **THEN** it reports the result id directly to the named Change Lead without also dispatching the same stage to the Team Lead

#### Scenario: Reporting conflicts with direction
- **WHEN** an assignment message names a different coordinator from the current task direction
- **THEN** the recipient seeks reconciliation and does not infer reassignment from the message alone

### Requirement: Independent review survives delegation
The Change Lead SHALL coordinate one formal review per submitted result under existing cross-model routing and exact-result/exact-commit rules. It SHALL NOT substitute its own sign-off for independent findings or bypass existing result acceptance rights. Changed integration code SHALL receive review and checks for the resulting head.

#### Scenario: Fix creates a new result
- **WHEN** a developer fixes blocking findings
- **THEN** the new result receives findings for its own commit and does not inherit approval from the earlier result

#### Scenario: Reviewer unavailable
- **WHEN** no eligible independent reviewer is available
- **THEN** the Change Lead records a named wait and next availability check instead of approving its own coordinated work

### Requirement: Team Lead receives assembled evidence
Before final landing, the Change Lead SHALL present the assembled head, subtask results and findings, requirement coverage, contract/integration evidence, unresolved risks, and verification outcomes to the Team Lead. The Team Lead SHALL own cross-change integration order, final landing, and closure of its parent task. Subtask completion SHALL NOT imply parent completion.

#### Scenario: Subtasks pass but integration fails
- **WHEN** all component reviews pass but the assembled change violates a contract
- **THEN** the change remains incomplete and correction work receives new evidence and review before landing

#### Scenario: Local closure and formal acceptance differ
- **WHEN** the Change Lead closes a subtask it created after its criteria hold
- **THEN** it records closure without claiming that status closure alone recorded acceptance of that result

### Requirement: Coordinator recovery respects durable ownership
The protocol SHALL require a replacement or withdrawal record with outstanding assignments, mail and handoff references, branches, results, next actions, and creator-bound operations. A replacement SHALL NOT claim amendment or closing rights over another session's tasks. Recovery SHALL use the original creator when available or the human for those operations.

#### Scenario: Coordinator lost
- **WHEN** the Change Lead becomes unavailable
- **THEN** participants report the blocked coordination to the Team Lead and avoid duplicate dispatch while recovery is recorded

#### Scenario: Coordinator replaced
- **WHEN** a replacement session is named
- **THEN** affected direction is updated by an authorized creator or the human and participants acknowledge it before following the new coordinator

### Requirement: Pilot evaluation distinguishes quality speed and cost
The pilot SHALL record baseline and candidate task identifiers, comparable scope/risk and model/resource conditions, elapsed time, clarification waits, correction rounds, integration defects, and available token/cost evidence. Failed and abandoned work SHALL be included. Unknown values and quota, suite, reviewer, or human waits SHALL be identified separately; one pilot SHALL NOT establish a general causal improvement.

#### Scenario: Cost evidence incomplete
- **WHEN** usage records do not cover all pilot participants
- **THEN** the report marks total cost unknown or partial and does not infer it from provider quota percentages

#### Scenario: Pilot reviewed
- **WHEN** the enrolled change lands or is withdrawn, or its recorded evaluation window ends
- **THEN** the Team Lead records a continue, revise, or withdraw recommendation with evidence and limitations; expansion requires a human decision

### Requirement: Withdrawal preserves work and default routing
The protocol SHALL support withdrawal at a safe checkpoint. It SHALL stop new pilot assignments, reconcile existing work and creator rights, restore default reporting through authorized direction updates, and retain all evidence. Withdrawal SHALL NOT kill sessions, delete work, duplicate pending handoffs, or remove the role while unresolved pilot work depends on it.

#### Scenario: Review pending during withdrawal
- **WHEN** the pilot is withdrawn with an outstanding review handoff
- **THEN** that review remains singular and its result and next coordinator are recorded before reporting changes

#### Scenario: Running prompt is older
- **WHEN** role instructions change while an agent is running
- **THEN** adoption uses an explicit safe-checkpoint instruction or the agent's next ordinary start, without an automatic restart
