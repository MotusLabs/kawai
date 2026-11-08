# Spec Delta

## MODIFIED Requirements

### Requirement: A draft never publishes
The human SHALL be able to save a draft of a task's direction, acceptance, contract, and rationale, based on a named published revision. A draft SHALL NOT change the task's current direction or revision, appear in delivered task context or in agent task tools, send or queue mail, interrupt any agent, or show acknowledgement state. Drafts SHALL persist across restart and SHALL be visible only to the human.

#### Scenario: Saving a draft publishes nothing
- **WHEN** the human saves a draft for a task at revision 1 while its developer is busy
- **THEN** the task stays at revision 1, no mail is queued, the developer's turn is not interrupted, and no acknowledgement state is shown for the draft

#### Scenario: Agents do not see drafts
- **WHEN** a draft exists and task mail is delivered or an agent reads the task with `task_get`
- **THEN** the delivered context and the tool result carry revision 1's direction and no draft text

#### Scenario: Draft survives restart
- **WHEN** the server restarts after the human saved a draft
- **THEN** the draft, its base revision, and its rationale are shown again in the task detail

#### Scenario: Draft contract survives restart unparsed
- **WHEN** the human saves a draft whose contract text does not yet parse, and the server restarts
- **THEN** the draft's contract text is shown again with the parser's problems, and nothing is published

### Requirement: Publication records one immutable revision per intent
Publishing SHALL record the next numbered revision with direction, acceptance, contract and its hash, rationale, author, and time, and SHALL discard the published draft. A publication whose contract does not parse SHALL be refused, keeping the draft. A publication SHALL carry the revision it was based on and SHALL be refused as stale, keeping the draft, when a newer revision exists. A publication SHALL carry a command key; replaying the same key and payload SHALL return the prior revision, and the same key with a different payload SHALL be refused.

#### Scenario: Revision increments once
- **WHEN** the human publishes and notifies a draft based on revision 1 and the request is resent after a reconnect with the same command key
- **THEN** exactly one revision 2 exists, the replay returns it, the claimed holder has exactly one notice for revision 2, and exactly one revision-published fact exists for revision 2

#### Scenario: Concurrent same-key publishes
- **WHEN** two requests with the same command key and payload are processed at the same time
- **THEN** exactly one revision, one notice per holder, and one revision-published fact are written, and both requests return that revision

#### Scenario: Reused key with a different payload is refused
- **WHEN** a publication arrives with the command key of an earlier publication but a different direction, acceptance, contract, rationale, notify choice, or base revision
- **THEN** it is refused naming the differing field, and no revision, notice, or revision-published fact is written

#### Scenario: Stale draft is refused
- **WHEN** the human publishes a draft based on revision 1 after another revision 2 was published
- **THEN** the publication is refused naming revision 2, nothing is published, and the draft remains

#### Scenario: Rationale is kept with the revision
- **WHEN** the human publishes revision 2 with a rationale
- **THEN** the revision history shows revision 2 with its rationale, author, and time, and revision 1 unchanged

#### Scenario: Malformed contract is refused
- **WHEN** the human publishes a draft whose contract has two clauses with id I2
- **THEN** the publication is refused naming I2, nothing is published, and the draft remains

#### Scenario: Contract-only revision notifies
- **WHEN** the human publishes and notifies a draft that changes only the contract
- **THEN** a new revision is published with the new contract identity, and the claimed holder receives one notice naming it

### Requirement: Agent creators publish without drafts
`task_amend` SHALL keep its rights: only the task's creator or the human. An agent amendment SHALL publish immediately as the next revision, with an optional rationale and an optional contract, and SHALL send revision notices when it sets `notify`. A contract that does not parse SHALL refuse the amendment with the parser's problems and publish nothing. Agents SHALL have no draft tool; a notice from an agent amendment is sent as that agent.

#### Scenario: Lead publishes and notifies
- **WHEN** the creating lead calls `task_amend` with a new direction, a rationale, and `notify` true
- **THEN** the next revision is published with that rationale and the assignment's claimed developer receives one notice from the lead

#### Scenario: Non-creator still refused
- **WHEN** a developer that did not create the task calls `task_amend`
- **THEN** the tool returns an error, no revision is published, and no notice is sent

#### Scenario: Lead replaces the contract
- **WHEN** the creating lead calls `task_amend` with a contract that adds excluded clause X2 and `notify` true
- **THEN** the next revision carries that contract, and the notice names the new contract identity

#### Scenario: Malformed agent contract
- **WHEN** the creating lead calls `task_amend` with a contract whose Verification part is empty
- **THEN** the tool returns an error naming the Verification part, and no revision or notice is written
