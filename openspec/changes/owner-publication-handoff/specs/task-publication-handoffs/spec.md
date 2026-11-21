# Spec Delta

## Purpose

Lets an agent hand a prepared task revision to the party who may publish it — the human, or the task's live agent owner — as a durable, reviewable request that stays tracked from submission until an actual matching publication or an explicit terminal disposition.

## ADDED Requirements

### Requirement: Task authors may request an owner publication
The `kawai-team` server SHALL offer `task_request_publication` to an agent session whose group may create tasks, for a task of its team that it may not publish itself. The task's live agent owner SHALL be refused and pointed to `task_amend`. Other agents SHALL be refused, suggesting a journal note or a message to the owner. A request SHALL never publish, notify, or change the task.

#### Scenario: A Lead prepares a correction for a Kawai task
- **WHEN** a session of a group that may create tasks requests a publication for a task Kawai created, based on its current revision 1
- **THEN** one open handoff is recorded for that task, the task stays at revision 1, and no revision notice or revision-published fact is written

#### Scenario: A developer cannot request
- **WHEN** a session of a group that may not create tasks calls `task_request_publication`
- **THEN** the tool returns an error suggesting `task_note` or a message to the owner, and no handoff is recorded

#### Scenario: The owner is told to amend
- **WHEN** the task's live agent owner calls `task_request_publication` for its own task
- **THEN** the tool returns an error naming `task_amend`, and no handoff is recorded

### Requirement: A request is validated before it is recorded
A request SHALL name the task, the base revision, a rationale, and at least one of direction, acceptance, or contract. It SHALL be refused, recording nothing, when the task belongs to another team (without revealing it), the task is done or cancelled, the base revision is not the task's current revision, the contract does not parse, or a field exceeds its size limit.

#### Scenario: A stale base is refused
- **WHEN** an agent requests a publication based on revision 1 of a task at revision 2
- **THEN** the tool returns an error naming revision 2, and no handoff is recorded

#### Scenario: A malformed contract is refused
- **WHEN** a request's contract has two clauses with id I2
- **THEN** the tool returns an error naming I2, and no handoff is recorded

#### Scenario: A closed task is refused
- **WHEN** an agent requests a publication for a task whose status is done
- **THEN** the tool returns an error naming the status, and no handoff is recorded

#### Scenario: A foreign task is refused without disclosure
- **WHEN** an agent requests a publication for a task of another team
- **THEN** the tool returns the same not-found error as for an unknown task id, and nothing is recorded

#### Scenario: A request without content is refused
- **WHEN** a request carries a rationale but no direction, acceptance, or contract
- **THEN** the tool returns an error, and no handoff is recorded

### Requirement: A handoff records its exact provenance
Each handoff SHALL record the task, its team, the base revision and that revision's contract identity, the requester session and group, the time, a payload hash Kawai computes over the prepared fields and notify choice, the notify choice, an optional base commit, and optional evidence references. A base commit SHALL be a full commit id that resolves in the task's worktree or the team's repository; otherwise the request SHALL be refused.

#### Scenario: Provenance is shown with the handoff
- **WHEN** a handoff based on revision 1 with base commit C is recorded
- **THEN** reading it shows the task, revision 1 and its contract identity, the requester, commit C, the evidence references, and a payload hash that changes when any prepared field changes

#### Scenario: An unknown base commit is refused
- **WHEN** a request names a base commit that does not resolve in the task's worktree or repository
- **THEN** the tool returns an error naming the commit, and no handoff is recorded

### Requirement: Requests are idempotent under a request key
A request SHALL carry a request key. Replaying the same key and payload SHALL return the existing handoff and record nothing more; the same key with a different payload SHALL be refused naming the differing field.

#### Scenario: A resent request returns the same handoff
- **WHEN** a request is resent with the same request key and payload after a reconnect
- **THEN** exactly one handoff exists and both calls return it

#### Scenario: A reused key with another payload is refused
- **WHEN** a request reuses an earlier request key with a different direction
- **THEN** it is refused naming the direction, and the earlier handoff is unchanged

#### Scenario: A replay after the task moved on returns the handoff
- **WHEN** a request is resent with the same key and payload after its handoff became stale or its task closed
- **THEN** the existing handoff is returned in its current state, and nothing is recorded or refused

### Requirement: A task has at most one pending handoff
A task SHALL have at most one handoff that is open or stale. A new request from the pending handoff's requester or from a session of the same group SHALL supersede it in the same transaction; a request from any other session SHALL be refused naming the pending handoff and its requester.

#### Scenario: The requester re-prepares
- **WHEN** the requester of an open handoff H1 submits a new request H2 for the same task
- **THEN** H1 reads superseded by H2, H2 is open, and exactly one handoff of the task is pending

#### Scenario: Another group cannot replace it
- **WHEN** a session of another group requests a publication while H1 is open
- **THEN** the request is refused naming H1 and its requester, and H1 stays open

### Requirement: A handoff is never a revision
A pending handoff SHALL NOT change the task's direction, acceptance, contract, or revision, appear as the task's direction in delivered task context, count as an acknowledgement target, or reopen a review window. The human's draft of the task SHALL be untouched by a request.

#### Scenario: Delivered context keeps the published revision
- **WHEN** a handoff for revision 2 is open and task mail is delivered to the holder
- **THEN** the delivered context carries revision 1's direction and names the pending handoff only as pending

#### Scenario: A draft survives a request
- **WHEN** the human has a saved draft and an agent records a handoff for the same task
- **THEN** the draft is unchanged

### Requirement: The publisher publishes a handoff with one action
The human, and a live agent owner, SHALL be able to publish an open handoff as prepared with one action. It SHALL publish through the task's normal publication — same rights, parsing, findings re-map, revision-published fact, and notices when the handoff's notify choice is set — based on the handoff's base revision, and SHALL mark the handoff published with that revision in the same transaction.

#### Scenario: The human publishes a prepared correction
- **WHEN** the human chooses **Publish prepared revision** on an open handoff based on revision 1 with notify set
- **THEN** revision 2 carries the handoff's direction, acceptance, contract, and rationale with the human as author, the handoff reads published as revision 2, and the claimed holder receives one notice

#### Scenario: A live owner publishes with task_amend
- **WHEN** the task's live agent owner calls `task_amend` naming the open handoff
- **THEN** the next revision carries the handoff's prepared fields with the owner as author, and the handoff reads published

#### Scenario: No other party can publish it
- **WHEN** an agent that is not the task's owner, or Kawai, tries to publish the handoff
- **THEN** it is refused as any publication by them is, and the handoff stays open

### Requirement: Editing before publishing still fulfills the handoff
The human SHALL be able to load an open handoff into the task's draft and edit it before publishing. When a draft already exists, loading SHALL require confirming its replacement. Publishing that draft SHALL fulfill the handoff and record that it was published as edited, with the published payload's hash beside the prepared one.

#### Scenario: Published as edited
- **WHEN** the human loads handoff H into the draft, changes one clause, and publishes
- **THEN** H reads published as edited with the new revision, and both the prepared and published payload hashes are shown

#### Scenario: An existing draft is not overwritten silently
- **WHEN** the human loads handoff H while a draft exists and does not confirm replacing it
- **THEN** the draft is unchanged and H stays open

#### Scenario: A stale handoff cannot be loaded
- **WHEN** the human loads handoff H after it became stale
- **THEN** it is refused naming stale, and the draft is unchanged

#### Scenario: A linked draft outlives its handoff
- **WHEN** the human publishes a draft loaded from handoff H after H was declined
- **THEN** the revision is published as an ordinary revision, and H stays declined

### Requirement: A handoff is published at most once
A handoff SHALL be fulfilled only by a revision recorded as published from it; a key or matching content SHALL never fulfill it. A replay or concurrent duplicate SHALL return the same revision and write nothing more. Publishing a handoff no longer open SHALL be refused naming its state. Every other publication, a linked draft's included, SHALL be refused a handoff-namespace key, and the two publish actions SHALL NOT replay each other.

#### Scenario: Two clicks publish once
- **WHEN** two **Publish prepared revision** requests for handoff H are processed at the same time
- **THEN** exactly one revision, one notice per holder, and one revision-published fact are written, and both return that revision

#### Scenario: A declined handoff cannot be published
- **WHEN** the human tries to publish handoff H after it was declined
- **THEN** it is refused naming declined, and no revision is written

#### Scenario: An ordinary publication cannot take a handoff's key
- **WHEN** the human publishes a draft with a command key in the handoff namespace while handoff H is open
- **THEN** the publication is refused naming the reserved key, nothing is published, and H stays open

#### Scenario: Surrounding whitespace does not hide a handoff key
- **WHEN** the human publishes, with or without a draft loaded from handoff H, using a command key that is H's handoff-namespace key with a leading space, a tab and newline, or trailing spaces around it
- **THEN** the publication is refused naming the reserved key, nothing is published, the draft is unchanged, and H stays open

#### Scenario: A padded ordinary key works as before
- **WHEN** the human publishes with an ordinary command key surrounded by spaces
- **THEN** the revision is published, and a resend with the same key padded differently returns that revision

#### Scenario: A linked draft cannot take a handoff's key
- **WHEN** the human loads handoff H into the draft, edits it, and publishes it with a command key in the handoff namespace
- **THEN** the publication is refused naming the reserved key, nothing is published, the draft is unchanged, and H stays open

#### Scenario: The two publish actions never replay each other
- **WHEN** the human publishes handoff H through its linked draft and then chooses **Publish prepared revision** for H
- **THEN** the second action is refused naming H as published with the linked revision, and exactly one revision is published from H

#### Scenario: A key is never proof of fulfillment after restart
- **WHEN** handoff H became stale through another revision and Kawai restarts
- **THEN** H still reads stale, whatever request keys earlier revisions carry

### Requirement: Another publication makes a pending handoff stale
When a revision not published from a pending handoff is published for its task, an open handoff SHALL read stale in the same transaction, naming that revision. A stale handoff SHALL NOT be publishable; it SHALL stay pending until it is superseded, withdrawn, declined, or its task closes.

#### Scenario: The human publishes their own draft first
- **WHEN** the human publishes a draft as revision 2 while handoff H based on revision 1 is open
- **THEN** H reads stale naming revision 2, and **Publish prepared revision** is refused for H

#### Scenario: Re-preparing a stale handoff
- **WHEN** the requester of stale handoff H submits a new request based on revision 2
- **THEN** H reads superseded, and the new handoff is open

### Requirement: A handoff ends only by an explicit disposition
A pending handoff SHALL end only as published, declined by a publisher with a reason, withdrawn by its requester or a session of its group with a reason, superseded, or closed with its task. Ended handoffs SHALL stay readable with their disposition, actor, reason, and time.

#### Scenario: The human declines
- **WHEN** the human declines open handoff H with the reason "scope stays as published"
- **THEN** H reads declined by the human with that reason, and the task's revision is unchanged

#### Scenario: Closing the task ends the handoff
- **WHEN** the task of open handoff H is set to cancelled
- **THEN** H reads closed with its task, and no revision is published

#### Scenario: An override's cancellation closes the handoff
- **WHEN** the owner overrides a decision, and the override cancels the earlier fix task that holds open handoff H
- **THEN** H reads closed with that task, and the override changes nothing else on H

#### Scenario: The requester withdraws
- **WHEN** the requester calls `task_settle_publication` withdrawing H with a reason
- **THEN** H reads withdrawn with that reason, and the task is unchanged

### Requirement: Answers, time, and archival never settle a handoff
A decision-card answer, decision, or override, a journal note, mail, elapsed time, a restart, and archiving or exhausting the requester or the holder SHALL NOT publish, decline, withdraw, or otherwise change a handoff's state.

#### Scenario: A yes on a card is not a publication
- **WHEN** the human answers a decision card that asks whether to publish a prepared correction, choosing "Publish", while that correction's handoff is open
- **THEN** the handoff stays open, the task's revision is unchanged, and the handoff is still listed for the human

#### Scenario: An archived requester leaves the handoff pending
- **WHEN** the requester of open handoff H is archived
- **THEN** H stays open and publishable

### Requirement: Each disposition wakes the next actor once
On publication, decline, staleness, and task closure Kawai SHALL send one direct message about the handoff to its requester when that session is live, else one group message to the requester's group. Each message SHALL be keyed by the handoff and the transition, so a replay, retry, or restart sends no second message. A failed message SHALL NOT undo the transition.

#### Scenario: The requester learns of the publication
- **WHEN** the human publishes handoff H as revision 2
- **THEN** H's requester receives exactly one message naming H and revision 2

#### Scenario: A gone requester's group is woken
- **WHEN** handoff H becomes stale while its requester is archived
- **THEN** one message naming H and the new revision is sent to the requester's group, and none to the archived session

#### Scenario: A replay sends nothing more
- **WHEN** the publication of H is replayed with the same command key
- **THEN** no further message about H is sent

### Requirement: Handoffs survive restart and reconcile once
Handoffs and their transitions SHALL persist. At startup Kawai SHALL mark stale, closed, or published every pending handoff whose task moved past its base revision, closed, or holds a revision published from it, once, sending the transition's message if it was not yet sent.

#### Scenario: A crash after publication
- **WHEN** Kawai restarts after a publication committed but before the requester's message was sent
- **THEN** the handoff reads published, and exactly one message about it is sent after startup

#### Scenario: A refused key changes nothing at restart
- **WHEN** an ordinary publication with a key in H's handoff namespace was refused while H is open with a current base, and Kawai restarts
- **THEN** H still reads open, and no message about H is sent

#### Scenario: A restart changes nothing settled
- **WHEN** Kawai restarts with one open handoff whose base is current and one declined handoff
- **THEN** both read as before, and no message is sent

### Requirement: Agents read a task's handoffs
`task_get` SHALL show the task's pending handoff and its newest ended handoffs as bounded rows — identity, state, base revision, requester, payload hash, disposition and published revision — and SHALL read one handoff whole by id. Reads SHALL be team-scoped.

#### Scenario: The holder sees a pending correction
- **WHEN** the task's holder calls `task_get` while handoff H is open
- **THEN** the result lists H as open with its base revision and requester, and the direction remains the published revision's

#### Scenario: A handoff of another team is not readable
- **WHEN** an agent reads a handoff id belonging to another team's task
- **THEN** the read returns not found
