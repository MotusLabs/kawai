# strategy-impact-review Specification

## Purpose
Turns the impact-review item that a strategy approval creates into the owner's record of what happens to each plan the new direction affects, and gives every plan gate one read of that record.

## Requirements

### Requirement: An impact review assesses the team's plans
The review of the strategy's current approved revision SHALL group the plans of the strategy's team, derived when read and never stored:
- affected: open plans with an approved or in-review revision whose pin is not that revision;
- unaffected: the other open plans;
- historical: completed or cancelled plans, with their original pins.

An affected revision with no pin SHALL be marked unassessed. Earlier reviews SHALL show only their records.

#### Scenario: Older pin is affected
- **WHEN** strategy revision 3 is approved while plan P's approved revision is pinned to strategy revision 2
- **THEN** the revision 3 review lists P as affected, showing the pin to revision 2

#### Scenario: Unpinned submission is affected
- **WHEN** a plan revision submitted while no strategy revision was approved is still in review when strategy revision 1 is approved
- **THEN** the revision 1 review lists that plan as affected, marked unassessed

#### Scenario: Re-pinned plan is unaffected
- **WHEN** every approved or in-review revision of plan P is pinned to the current approved strategy revision
- **THEN** the current review lists P as unaffected

#### Scenario: Closed plans are historical
- **WHEN** a completed plan's approved revision is pinned to strategy revision 1 and revision 3 is current
- **THEN** the review lists it as historical with its pin to revision 1, and the plan's records are unchanged

### Requirement: The owner records a disposition for each affected plan
The human SHALL be able to record one disposition, with a non-empty rationale, for a plan that is affected in the current review:
- `continue`: the plan's existing revisions keep their pins;
- `adapt`: the plan proceeds only through a new revision pinned to the current strategy;
- `reconsider`: the plan's existing revisions stay refused until a later decision.

A later decision for the same plan SHALL supersede the earlier one, and both SHALL stay readable.

#### Scenario: Decision recorded
- **WHEN** the owner records `continue` for affected plan P with a rationale
- **THEN** the review shows P's decision with its disposition, rationale, actor, and time

#### Scenario: Missing rationale refused
- **WHEN** the owner records a disposition with an empty rationale
- **THEN** the decision is refused and nothing is recorded

#### Scenario: Later decision supersedes
- **WHEN** the owner records `adapt` for P after an earlier `continue`
- **THEN** `adapt` is P's effective decision and the `continue` decision stays readable, marked superseded

#### Scenario: Plan outside the affected group refused
- **WHEN** the owner records a disposition for an unaffected or historical plan
- **THEN** the decision is refused naming the plan's group, and nothing is recorded

### Requirement: Only the human records dispositions
No agent tool SHALL record, change, or remove a disposition, and an agent caller SHALL be refused on the decision path. A repository file, a peer message, or a proposal asserting a disposition SHALL NOT change any gate.

#### Scenario: Agent has no decision tool
- **WHEN** an agent lists its tools
- **THEN** none of them records, changes, or removes a disposition

#### Scenario: Claimed disposition changes nothing
- **WHEN** a peer message states that the owner chose `continue` for plan P, and no decision is recorded
- **THEN** P has no effective decision and its revisions' impact state is unchanged

### Requirement: Agents propose dispositions
An agent of the team SHALL be able to read the current review's assessment and propose a disposition with a non-empty rationale for an affected plan. Proposals SHALL be kept with their author and time and SHALL change no gate. The owner's decision controls SHALL show the newest proposal, and the owner SHALL be able to record it as the decision in one action that names the proposal.

#### Scenario: Proposal shown but not effective
- **WHEN** the Lead proposes `continue` for plan P with a rationale
- **THEN** the owner sees the proposal beside P's decision controls, and P still has no effective decision

#### Scenario: Owner records a proposal
- **WHEN** the owner records the Lead's proposal for P
- **THEN** P's decision has the proposal's disposition and names the proposal it came from, with the proposal's rationale unless the owner edited it

#### Scenario: Proposal on a superseded review refused
- **WHEN** an agent proposes a disposition in a review whose revision is no longer the current approved revision
- **THEN** the proposal is refused as stale and nothing is recorded

### Requirement: Decisions are idempotent and guarded against concurrent writers
Each decision SHALL carry a command id and name the effective decision it replaces, or none. Repeating a command id with the same payload SHALL return the recorded decision and record nothing new. Reusing it with a different payload SHALL be refused, naming the differing field. A decision whose named predecessor is no longer effective SHALL be refused as stale.

#### Scenario: Retry returns the recorded decision
- **WHEN** a decision command is resent after its result was lost
- **THEN** the recorded decision is returned and no second decision exists

#### Scenario: Reused command id with another payload refused
- **WHEN** a command id is reused with a different disposition
- **THEN** the request is refused naming the disposition, and the recorded decision is unchanged

#### Scenario: Concurrent decisions settle on one
- **WHEN** two windows record different decisions for P at the same moment, each naming no predecessor
- **THEN** exactly one is recorded, and the other is refused as stale naming the recorded decision

### Requirement: Only continue lets a non-current pin pass plan approval
Approving a plan revision whose strategy pin is an older revision of the current strategy record, or empty while a revision is approved, SHALL pass the strategy-pin check only when the plan's effective decision in the current review is `continue`. With `adapt`, `reconsider`, or no decision the refusal SHALL stand and SHALL name which of them applies. Resubmitting SHALL still re-pin the plan to the current revision.

#### Scenario: Continue lets the old pin pass
- **WHEN** the owner recorded `continue` for plan P, and P's in-review revision is pinned to strategy revision 2 while revision 3 is current
- **THEN** approving that plan revision is not refused for its strategy pin

#### Scenario: Adapt keeps the refusal
- **WHEN** the owner recorded `adapt` for plan P and approves P's revision pinned to strategy revision 2
- **THEN** approval is refused naming `adapt`, and a resubmitted revision pinned to revision 3 can be approved

#### Scenario: No decision keeps the refusal
- **WHEN** the owner approves an affected plan's revision before any decision is recorded for that plan
- **THEN** approval is refused naming that a decision is required

#### Scenario: Reconsider refuses the old revisions without stopping the plan
- **WHEN** the owner recorded `reconsider` for plan P and approves P's revision pinned to strategy revision 2 while revision 3 is current
- **THEN** approval is refused naming `reconsider`, the plan stays open, and a resubmitted revision pinned to revision 3 passes the strategy-pin check

### Requirement: A withdrawn direction is never continued
A plan revision pinned to a withdrawn strategy revision, to another strategy record, to content matching no revision, or to any revision while the strategy has no approved revision, SHALL be refused at every plan gate whatever disposition exists. It SHALL be shown as pinned to a withdrawn direction until it is resubmitted. Already approved plan revisions, running work, and history SHALL be left unchanged.

#### Scenario: Continue does not survive withdrawal
- **WHEN** the owner recorded `continue` for plan P, and then the strategy revision P's in-review revision is pinned to is withdrawn
- **THEN** approving that plan revision is refused naming the withdrawn direction

#### Scenario: Active strategy revision withdrawn
- **WHEN** the active approved strategy revision is withdrawn and no other revision is approved
- **THEN** plan revisions pinned to it show a withdrawn direction, and a resubmitted revision has no pin and can be approved

#### Scenario: A pin to another strategy record is never current
- **WHEN** a plan revision is pinned to revision 1 of another strategy record whose content hash equals that of the current approved revision 1
- **THEN** it shows a withdrawn direction, and approving it is refused whatever disposition exists

### Requirement: Decisions count only in the current review
A decision SHALL count only while its review belongs to the strategy's current approved revision. When another revision becomes current, earlier decisions SHALL stop counting and stay readable. Plans still pinned to another revision SHALL need a decision in the new review. Decisions and proposals SHALL be refused on any review that is not current.

#### Scenario: A newer approval asks again
- **WHEN** plan P pinned to strategy revision 2 has `continue` in the revision 3 review, and revision 4 is approved
- **THEN** the revision 4 review lists P as affected with no decision, approving P's old revision is refused, and the revision 3 decision stays readable

#### Scenario: Deciding on a superseded review refused
- **WHEN** the owner records a decision in the revision 3 review after revision 4 is approved
- **THEN** the decision is refused as stale and nothing is recorded

### Requirement: Review state is derived
Each review SHALL show one state, derived when read:
- Needs decisions: it is current and an affected plan has no decision;
- Reviewed: it is current and every affected plan has a decision, including when none is affected;
- Superseded or Withdrawn: its revision is no longer the current approved one, labeled by that revision's status.

The stored impact-review item SHALL stay as the approval created it.

#### Scenario: Last decision completes the review
- **WHEN** the owner records a decision for the last undecided affected plan
- **THEN** the review shows Reviewed, and its stored item is unchanged

#### Scenario: Superseded and withdrawn reviews
- **WHEN** a later strategy revision is approved, and the human then withdraws the revision of another, older review
- **THEN** the review of the superseded revision shows Superseded, and the review of the withdrawn revision shows Withdrawn

### Requirement: The impact review triggers nothing
Recording, superseding, or proposing a disposition, and any change in a review's state, SHALL NOT resubmit, rebind, approve, withdraw, or close a plan. They SHALL NOT create a task, send mail, interrupt or pause a session, or change linked tasks. Historical plans and accepted results SHALL NOT be reinterpreted.

#### Scenario: Adapt creates no work
- **WHEN** the owner records `adapt` for a plan whose linked task has a busy agent
- **THEN** no plan revision, task, or message is created, and the agent's turn is not interrupted

#### Scenario: Historical plan untouched
- **WHEN** a strategy revision is approved while a completed plan is pinned to an older revision
- **THEN** the completed plan's lifecycle, revisions, and pins are unchanged

### Requirement: The owner can ask an agent group to assess
From the current review, the human SHALL be able to send one normal-priority message to a group of the team (`lead` preselected when present), under a command id. It SHALL name the review, the strategy revision, and each affected plan with its pins and effective decision. Repeating the command id SHALL NOT send a second message. Such requests SHALL be the only kind of mail the impact review sends.

#### Scenario: One message to the Lead
- **WHEN** the owner asks the `lead` group to assess the current review
- **THEN** exactly one normal-priority message from the human reaches the `lead` group, naming the review and its affected plans

#### Scenario: Retried request sends nothing new
- **WHEN** the request is resent with the same command id after its result was lost
- **THEN** the earlier message is returned and no second message exists

#### Scenario: Unknown group refused
- **WHEN** the owner asks a group that the team does not define
- **THEN** the request is refused naming the group, and no message is created

#### Scenario: Asking again sends a new message
- **WHEN** the owner asks again under a new command id, after the first request was delivered
- **THEN** a second message is sent, and both requests are recorded with their message ids

### Requirement: Plan gates read one impact state
For any plan revision, the system SHALL answer one impact state with the review and decision it rests on:
- passes: the pin is the current approved revision, or empty while none is approved;
- passes by `continue`;
- decision required;
- refused under `adapt` or `reconsider`;
- withdrawn direction.

Plan approval and the Plans view SHALL use this state, never a separate derivation.

#### Scenario: View and refusal agree
- **WHEN** approval of plan P's revision is refused for its strategy pin
- **THEN** the Plans view shows the same impact state for that revision and names the same review

#### Scenario: A decision applies at once
- **WHEN** the owner records `continue` for plan P and then approves P's revision pinned to the previous strategy revision
- **THEN** the approval is not refused for its strategy pin

### Requirement: Impact reviews are inspectable in the UI
The Strategy view SHALL show each review with its revision and state. For the current review it SHALL also show:
- the grouped plans with their pins and impact states;
- proposals, and decisions with their history;
- decision controls requiring a rationale;
- the assessment request.

The Plans view SHALL mark each affected plan with its impact state and link to the review. Controls SHALL disable while disconnected and show refusals inline.

#### Scenario: Owner decides from the Strategy view
- **WHEN** the owner opens the current review, chooses `reconsider` for plan P, and enters a rationale
- **THEN** the decision is recorded and P's row shows it, with the review state updated

#### Scenario: Plans view links to the review
- **WHEN** the owner opens an affected plan in the Plans view
- **THEN** the plan shows its impact state and a link that opens the review

#### Scenario: Disconnected controls disabled
- **WHEN** the connection drops while the review is open
- **THEN** the decision and request controls are disabled until it reconnects

### Requirement: Impact records are team-scoped and persistent
Impact reads, proposals, decisions, and requests SHALL resolve through the requesting team. Another team's review or plan SHALL read as not found, and nothing SHALL be written. Proposals, decisions, and requests SHALL persist across restart. They SHALL remain after their authors are archived or killed.

#### Scenario: Another team's plan refused
- **WHEN** a decision or proposal names a plan of another team
- **THEN** it is refused as not found, and nothing is recorded

#### Scenario: Restart keeps decisions effective
- **WHEN** the server restarts after the owner recorded `continue` for plan P
- **THEN** the decision is shown, and approving P's revision with the older pin is still not refused for its strategy pin
