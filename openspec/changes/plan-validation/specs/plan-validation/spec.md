# Spec Delta

## Purpose

Makes validating a plan revision produce an immutable report over pinned inputs: technical checks, typed relations from spec deltas, questions, warnings, and readiness. Plan approval requires a current, ready report. Only the owner answers, accepts, or decides, and validation writes nothing beyond its own records.

## ADDED Requirements

### Requirement: Validating a plan revision produces an immutable report
The human and any team agent SHALL be able to validate an `in_review` or `approved` revision of an open plan of their team. Validation SHALL store an immutable report with its inputs, input hash, findings, relations, alignment state, the assessments and decisions it read, and its readiness. Validating unchanged inputs again SHALL return the newest report and write nothing. Concurrent requests for one revision SHALL share one run.

#### Scenario: Unchanged inputs write nothing
- **WHEN** a revision is validated twice and nothing it reads changed in between
- **THEN** the second request returns the first report and no report row is added

#### Scenario: Superseded revision refused
- **WHEN** validation is requested for a revision that is `superseded` or `withdrawn`
- **THEN** it is refused naming the revision's status and nothing is written

#### Scenario: Concurrent requests share one run
- **WHEN** the human and an agent request validation of the same revision at the same time
- **THEN** one run executes and both receive its report

### Requirement: The input hash covers exactly what the checks read
A report's input hash SHALL cover the revision and its content hash, the strategy impact state, each change's resolution status and artifact digests, the base specs its deltas touch, the named groups' definitions, the known profile ids, other open plans' claims on its changes and branch, the OpenSpec adapter version and capabilities, the checks version, and the revision's assessment and decision ids. Baseline commits and change locations SHALL be evidence only.

#### Scenario: An artifact edit changes the hash
- **WHEN** a change's `design.md` is edited after a report
- **THEN** the inputs recomputed now differ from that report's in that change's artifacts

#### Scenario: An unrelated merge leaves the report current
- **WHEN** a merge to the main checkout touches no artifact or base spec the report read
- **THEN** the report's input hash still equals the current inputs

#### Scenario: A moved proposal with unchanged content stays current
- **WHEN** a change's canonical copy moves from its convention worktree to the main checkout with identical content
- **THEN** the report stays current and the new location appears only as evidence in the next report

### Requirement: Missing adapter operations block their checks
Validation SHALL check that the OpenSpec CLI is available at a supported version with the operations validation uses. When it is not, every check that needs the CLI SHALL report an error and SHALL never report success. A CLI call that fails, times out, or returns an unknown shape SHALL be an error for that change.

#### Scenario: CLI missing
- **WHEN** the OpenSpec CLI cannot be found
- **THEN** `adapter-available`, `openspec-valid`, and `relations` each report an error and the report is not ready

#### Scenario: CLI call times out
- **WHEN** strict validation of one change exceeds its timeout
- **THEN** that change has an `openspec-valid` error and the other changes are still checked

### Requirement: Every named change is registered and strictly valid
Each change of the plan SHALL be registered in the main worktree's OpenSpec root and unarchived. A missing change, an archived one, or one present only in another worktree SHALL be an error naming where it was found. Each registered change SHALL pass `openspec validate --strict` in its canonical root, and the CLI's issues SHALL be attached to the error.

#### Scenario: Proposal only in a worktree
- **WHEN** a plan names a change that exists only in a proposal worktree
- **THEN** `change-registered` reports an error naming that worktree

#### Scenario: Strict validation fails
- **WHEN** a registered change fails `openspec validate --strict`
- **THEN** `openspec-valid` reports an error carrying the CLI's issues for that change

#### Scenario: Archived change
- **WHEN** a plan names a change that was archived
- **THEN** `change-registered` reports an error naming the archive directory

### Requirement: Conflicting changes prevent Ready unless ordered
Validation SHALL derive typed relations from the changes' spec deltas. Two changes touching the same requirement of a capability SHALL be a conflict error unless `dependsOn` orders one before the other, transitively. Two changes touching the same capability without a shared requirement SHALL be an overlap warning unless ordered. Ordered pairs SHALL be recorded as serialized. This SHALL hold without any dependency cycle.

#### Scenario: Acyclic plan with conflicting schema changes
- **WHEN** two changes with no `dependsOn` path between them both modify the same requirement
- **THEN** the report has a conflict error naming both changes and the requirement, and it is not ready

#### Scenario: Agreed serialization resolves the conflict
- **WHEN** a resubmitted revision adds a `dependsOn` edge between those two changes and is validated
- **THEN** the pair is recorded as serialized with its order and no conflict error remains

#### Scenario: Same capability, different requirements
- **WHEN** two unordered changes touch different requirements of one capability
- **THEN** the report has an overlap warning that must be accepted before the report is ready

### Requirement: Environment checks cover groups, profiles, branches, and claims
Validation SHALL report an error for a role, change, or review group missing from the team's catalog; a role profile that is not a known profile; and an integration branch that another open plan's `in_review` or `approved` revision lands on. It SHALL warn when a role profile is outside its group's declared profiles and when another open plan names the same change. Capacity SHALL be evidence only and never block.

#### Scenario: Unknown group
- **WHEN** a plan's role names a group the team does not define
- **THEN** `groups-known` reports an error naming the group

#### Scenario: Branch claimed by another plan
- **WHEN** another open plan's approved revision lands on the same integration branch
- **THEN** `branch-free` reports an error naming that plan

#### Scenario: Busy team is not a blocker
- **WHEN** every member of a role group is busy and its profile is cooling
- **THEN** the report records caps, live members, and the cooldown end as evidence and stays ready if nothing else blocks

### Requirement: The strategy impact gate is a validation check
Validation SHALL include the revision's strategy impact gate as a check. A revision whose gate does not pass SHALL have an error naming the gate state, and the strategy impact state SHALL be part of the input identity.

#### Scenario: Decision required
- **WHEN** a revision is pinned to a superseded strategy revision and no disposition is recorded
- **THEN** `strategy-impact` reports an error naming `decision-required`

#### Scenario: Owner continues the plan
- **WHEN** the owner then records `continue` for the plan in the current impact review
- **THEN** the earlier report is out of date and a new validation passes `strategy-impact`

### Requirement: Agents raise questions and findings; only the owner answers or accepts
Any team agent SHALL be able to add mandatory or optional questions and warning findings to an `in_review` or `approved` revision. Only the human SHALL answer questions and accept warnings, each acceptance with a rationale. No agent tool SHALL answer, accept, resolve, authorize, or approve. Records and decisions SHALL be append-only; a later decision on the same target SHALL supersede the earlier, and both SHALL stay readable.

#### Scenario: Mandatory question blocks Ready
- **WHEN** an agent adds a mandatory question about an ambiguous migration strategy across ten changes
- **THEN** reports of that revision are not ready until the owner answers it, and the answer is retained with the revision

#### Scenario: Agents cannot decide
- **WHEN** an agent lists its `kawai-team` tools
- **THEN** none answers a question, accepts a warning, resolves a condition, records an exception, or authorizes exploration

#### Scenario: Acceptance needs a rationale
- **WHEN** the owner accepts a warning with an empty rationale
- **THEN** the decision is refused and nothing is written

### Requirement: Owner decisions are idempotent and targeted
Each owner decision SHALL carry a command id. A resend with the same id and payload SHALL return the recorded decision, and the same id with a different payload SHALL be refused naming the first differing field. A decision SHALL target a question, a warning the newest report raised, a condition, or an assessment of the matching kind, of the same revision. Text over its limit SHALL be refused, never cut.

#### Scenario: Resend replays
- **WHEN** the owner's accept-warning command is resent with the same command id and payload
- **THEN** the recorded decision is returned and no second decision is written

#### Scenario: Same id, different payload
- **WHEN** the same command id arrives with a different rationale
- **THEN** it is refused naming `text`

#### Scenario: Unknown warning
- **WHEN** the owner accepts a warning key that the revision's newest report does not raise
- **THEN** the decision is refused and nothing is written

### Requirement: Readiness is derived from the report
A report SHALL be ready exactly when it has no errors, every mandatory question is answered, every warning is accepted, and its alignment passes or is unassessed. Readiness SHALL be a pure function of what the report holds. An assessment or decision recorded after a report SHALL make that report out of date and never change it.

#### Scenario: Everything resolved
- **WHEN** a report has no errors, its mandatory questions are answered, its warnings are accepted, and its alignment passes
- **THEN** the report is ready

#### Scenario: Decision after the report
- **WHEN** the owner accepts the last open warning after a report was stored
- **THEN** that report stays unchanged and out of date, and the next validation produces a ready report

### Requirement: Approval requires a current, ready validation report
Plan approval SHALL add the precondition `validation-current`: the revision's newest report exists, is ready, and its input hash equals the inputs recomputed at approval. File-held inputs SHALL be read before the approval transaction and record-held inputs inside it. A refusal SHALL name what is missing, what still blocks, or which inputs changed. Approval SHALL write nothing for validation.

#### Scenario: Not validated
- **WHEN** the human approves a revision that has no report
- **THEN** approval is refused as `validation-current` with "not validated"

#### Scenario: Stale input hash after a ready report
- **WHEN** a change's artifacts are edited after a ready report and the human then approves
- **THEN** approval is refused as `validation-current`, naming that change's artifacts, until a new validation is ready

#### Scenario: Current and ready
- **WHEN** the newest report is ready and its inputs are unchanged
- **THEN** `validation-current` passes and approval proceeds under the other preconditions

### Requirement: Dry runs validate a draft without storing anything
An agent SHALL be able to validate a draft of its team's plan as a dry run. A dry run SHALL compute the checks as if the draft were submitted, SHALL be returned only, and SHALL never be stored or satisfy any gate.

#### Scenario: Draft dry run
- **WHEN** an agent validates its draft
- **THEN** it receives the findings and relations, marked as a dry run, and no report is stored

#### Scenario: Dry run does not satisfy approval
- **WHEN** a draft's dry run is clean and the human approves the revision submitted from it without validating it
- **THEN** approval is refused as `validation-current`

### Requirement: Agent validation tools
The `kawai-team` server SHALL add `plan_validate`, `plan_validation_get`, and `plan_assess`, allowed without approval cards and bound to the calling session's identity. Another team's plans SHALL read as not found. The system prompt's plan note SHALL state that validation never approves and that only the owner decides.

#### Scenario: Another team's plan
- **WHEN** an agent validates a plan id of another team
- **THEN** it is refused as not found and nothing is written

#### Scenario: Validation is not approval
- **WHEN** an agent's validation returns a ready report
- **THEN** the revision stays `in_review` until the human approves it

### Requirement: Validation writes only its own records
Validating, assessing, and deciding SHALL write only validation reports, assessments, and decisions. They SHALL send no mail, create no task, change no plan, revision, or strategy status, and interrupt no agent.

#### Scenario: Validating sends nothing
- **WHEN** a validation stores a blocked report
- **THEN** no team message, task, or plan event is written

#### Scenario: Deciding changes no plan state
- **WHEN** the owner records an exception
- **THEN** the plan's lifecycle and revision statuses are unchanged

### Requirement: The Plans view shows validation standing and controls
For each `in_review` or `approved` revision, the Plans view SHALL show its validation standing (Not validated, Blocked with counts, Ready, or Out of date naming the changed inputs), a Validate control, the report grouped as Product alignment, Intent and implementation strategy, Scope and relations, and Readiness, and the owner's decision and assessment controls. Every control SHALL disable while disconnected.

#### Scenario: Out of date names the change
- **WHEN** a change's tasks file is edited after the newest report
- **THEN** the revision shows Out of date naming that change's artifacts beside Validate

#### Scenario: Approve dialog shows the standing
- **WHEN** the human opens Approve for a revision whose report is blocked
- **THEN** the dialog shows the blocking counts and Validate, and a refusal renders inline
