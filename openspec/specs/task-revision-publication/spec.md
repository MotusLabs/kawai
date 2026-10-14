# task-revision-publication Specification

## Purpose
Makes a change of a task's direction deliberate and traceable. The human drafts direction privately, then publishes one immutable revision per intent, with its rationale, and can notify each assignment holder directly. Per-recipient publication detail keeps queued, delivered, and acknowledged apart, and agents acknowledge the revision they work from.

## Requirements

### Requirement: A draft never publishes
The human SHALL be able to save a draft of a task's direction, acceptance, and rationale, based on a named published revision. A draft SHALL NOT change the task's current direction or revision, appear in delivered task context or in agent task tools, send or queue mail, interrupt any agent, or show acknowledgement state. Drafts SHALL persist across restart and SHALL be visible only to the human.

#### Scenario: Saving a draft publishes nothing
- **WHEN** the human saves a draft for a task at revision 1 while its developer is busy
- **THEN** the task stays at revision 1, no mail is queued, the developer's turn is not interrupted, and no acknowledgement state is shown for the draft

#### Scenario: Agents do not see drafts
- **WHEN** a draft exists and task mail is delivered or an agent reads the task with `task_get`
- **THEN** the delivered context and the tool result carry revision 1's direction and no draft text

#### Scenario: Draft survives restart
- **WHEN** the server restarts after the human saved a draft
- **THEN** the draft, its base revision, and its rationale are shown again in the task detail

### Requirement: Publication records one immutable revision per intent
Publishing SHALL record the next numbered revision with direction, acceptance, rationale, author, and time, and SHALL discard the published draft. A publication SHALL carry the revision it was based on and SHALL be refused as stale, keeping the draft, when a newer revision exists. A publication SHALL carry a command key; replaying the same key and payload SHALL return the prior revision, and the same key with a different payload SHALL be refused.

#### Scenario: Revision increments once
- **WHEN** the human publishes and notifies a draft based on revision 1 and the request is resent after a reconnect with the same command key
- **THEN** exactly one revision 2 exists, the replay returns it, the claimed holder has exactly one notice for revision 2, and exactly one revision-published fact exists for revision 2

#### Scenario: Concurrent same-key publishes
- **WHEN** two requests with the same command key and payload are processed at the same time
- **THEN** exactly one revision, one notice per holder, and one revision-published fact are written, and both requests return that revision

#### Scenario: Reused key with a different payload is refused
- **WHEN** a publication arrives with the command key of an earlier publication but a different direction, acceptance, rationale, notify choice, or base revision
- **THEN** it is refused naming the differing field, and no revision, notice, or revision-published fact is written

#### Scenario: Stale draft is refused
- **WHEN** the human publishes a draft based on revision 1 after another revision 2 was published
- **THEN** the publication is refused naming revision 2, nothing is published, and the draft remains

#### Scenario: Rationale is kept with the revision
- **WHEN** the human publishes revision 2 with a rationale
- **THEN** the revision history shows revision 2 with its rationale, author, and time, and revision 1 unchanged

### Requirement: Publish and notify reaches each assignment holder directly
Publish and notify SHALL, in the same transaction as the revision, send a normal-priority direct revision notice to the claimed agent of the task's outstanding assignment, bound to that assignment and the published revision. A notice SHALL NOT be sent as group mail. An outstanding group assignment with no claimed agent SHALL receive no notice; its queued instruction carries the current revision when delivered. Plain publish SHALL send no notice.

#### Scenario: Busy developer is notified without interruption
- **WHEN** the human publishes and notifies while the assignment's claimed developer is mid-turn
- **THEN** one direct notice for revision 2 is queued to that developer, and it is delivered only after the developer's turn ends

#### Scenario: Unclaimed group assignment needs no notice
- **WHEN** the human publishes and notifies while the task's group assignment is still queued with no claimed agent
- **THEN** no notice is sent, and the instruction, once delivered, carries the latest revision

#### Scenario: Plain publish sends nothing
- **WHEN** the human uses **Publish revision** without notify
- **THEN** the revision is recorded and its recipients show Not notified

### Requirement: Notification failure is retried without a new revision
A failed or missing notice SHALL NOT undo or alter the published revision. **Notify** and **Retry notification** on a published revision SHALL send a notice to each assignment holder that has neither received that revision nor holds a pending notice for it, under a stable command key; a replay SHALL send nothing more. Notify and retry SHALL NOT create a revision.

#### Scenario: Failed notice retried
- **WHEN** a revision 2 notice is dead-lettered and the human chooses **Retry notification**
- **THEN** one new notice for revision 2 is queued to the holder, the task stays at revision 2, and the failed notice remains in history

#### Scenario: Retry replay sends one notice
- **WHEN** the retry request is resent with the same command key
- **THEN** no further notice is queued and the prior outcome is returned

#### Scenario: Notify later after plain publish
- **WHEN** the human chooses **Notify** on revision 2 that was published without notify
- **THEN** each holder that has not received revision 2 gets one notice, and no revision is created

### Requirement: Publication detail separates queued, delivered, and acknowledged
Each published revision SHALL show, per assignment holder: notice state (Not notified, Queued, Delivered, Failed with reason, Uncertain), the delivered revision — the highest task revision carried by task mail confirmed delivered to that session — and the acknowledged revision. Delivery SHALL NOT be shown as acknowledgement. The detail SHALL stay current as notices move and acknowledgements arrive. Checkpointed/Paused is Wave C's.

#### Scenario: Delivered but not acknowledged
- **WHEN** the revision 2 notice is confirmed delivered and the developer has not acknowledged
- **THEN** the recipient shows delivered revision 2 and acknowledged revision 1, or none

#### Scenario: Acknowledgement arrives later
- **WHEN** the developer then acknowledges revision 2
- **THEN** the recipient shows delivered revision 2 and acknowledged revision 2, and the view updates without reopening

### Requirement: Agents acknowledge the revision they work from
The `kawai-team` server SHALL offer `task_acknowledge(task_id, revision)`, allowed without approval cards, bound to the calling session. It SHALL refuse a task of another team and a revision that is not published. It SHALL record the session, revision, time, and the session's outstanding assignment for the task, if any; repeating it SHALL be a no-op. Notices and the task note SHALL tell agents to acknowledge.

#### Scenario: Developer acknowledges
- **WHEN** the claimed developer calls `task_acknowledge` with revision 2 after reading the notice
- **THEN** its assignment shows acknowledged revision 2

#### Scenario: Unpublished revision refused
- **WHEN** an agent acknowledges revision 3 of a task at revision 2
- **THEN** the tool returns an error and nothing is recorded

#### Scenario: Draft cannot be acknowledged
- **WHEN** a draft exists for revision 3 and an agent acknowledges revision 3
- **THEN** the tool refuses it because revision 3 is not published

### Requirement: Replacement sessions acknowledge current inputs
An assignment's acknowledged revision SHALL be the one acknowledged by its current claimed agent only. When the claimant changes — reassignment, requeue to another member, or work forwarded after a provider limit — the assignment SHALL show no acknowledged revision until the new claimant acknowledges, and an earlier claimant's acknowledgement SHALL remain in history.

#### Scenario: Reassigned work starts unacknowledged
- **WHEN** a task acknowledged at revision 2 by one developer is reassigned and claimed by another
- **THEN** the new assignment shows no acknowledged revision until the new developer acknowledges revision 2

#### Scenario: Forwarded work is re-acknowledged
- **WHEN** an assignment's work is forwarded to another session after a provider limit
- **THEN** the forwarded recipient must acknowledge before the assignment shows an acknowledged revision

### Requirement: Delivered rows keep the revision they carried
Publishing, notifying, and acknowledging SHALL NOT change the task revision recorded on any message already pushed or delivered, nor the task context in a delivered peer turn. A notice SHALL carry the task context current at its delivery and SHALL name the revision it announces.

#### Scenario: Earlier peer context unchanged
- **WHEN** revision 2 is published after an instruction carrying revision 1 was delivered
- **THEN** that instruction's peer row and thread row still show revision 1, while the task shows revision 2

#### Scenario: Notice carries the latest revision
- **WHEN** revision 3 is published while the revision 2 notice is still queued, and the notice is then delivered
- **THEN** the notice names revision 2 as announced and its task context carries revision 3

### Requirement: Publication emits a revision-published fact
Each publication SHALL produce a durable, ordered fact — task (and its team), new revision, previous revision, author, rationale, time — as its published revision record, with the task naming its current revision; consumers SHALL compare against these records. An in-process announcement after commit MAY be offered and SHALL NOT be required. A replayed publication, drafts, notices, retries, and acknowledgements SHALL NOT produce it. Consumers decide its effect on earlier results.

#### Scenario: One fact per publication
- **WHEN** revision 2 is published, the publication is replayed with the same command key, and its notice is retried twice
- **THEN** exactly one revision-published fact exists for revision 2

#### Scenario: Draft emits nothing
- **WHEN** the human saves a draft
- **THEN** no revision-published fact is produced

### Requirement: Agent creators publish without drafts
`task_amend` SHALL keep its rights: only the task's creator or the human. An agent amendment SHALL publish immediately as the next revision, with an optional rationale, and SHALL send revision notices when it sets `notify`. Agents SHALL have no draft tool; a notice from an agent amendment is sent as that agent.

#### Scenario: Lead publishes and notifies
- **WHEN** the creating lead calls `task_amend` with a new direction, a rationale, and `notify` true
- **THEN** the next revision is published with that rationale and the assignment's claimed developer receives one notice from the lead

#### Scenario: Non-creator still refused
- **WHEN** a developer that did not create the task calls `task_amend`
- **THEN** the tool returns an error, no revision is published, and no notice is sent
