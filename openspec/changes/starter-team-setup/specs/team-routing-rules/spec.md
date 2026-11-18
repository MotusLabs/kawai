## MODIFIED Requirements

### Requirement: Review mail names its authors' profiles
Review handoffs Kawai dispatches SHALL carry one tag `author-profile:<id>` for each profile that authored a result of the change in the execution, so a routing rule can send the review to another model family. The route contract SHALL be unchanged.

#### Scenario: A rule routes the review away from the author
- **WHEN** a reviewers rule reads the tag `author-profile:opus` and picks a `mimo` candidate
- **THEN** the review goes to the `mimo` member

#### Scenario: Without a rule the tags are metadata
- **WHEN** the review group has no routing rule and does not set `crossModelReview: true`
- **THEN** the built-in strategy routes the review as usual, and the tags show on its mailbox row

## ADDED Requirements

### Requirement: Groups may require cross-model review
A group file SHALL accept `crossModelReview: true`. The value SHALL be a strict boolean: any other value SHALL reject the file with an actionable error, as other strict boolean keys do. The flag SHALL affect only review handoffs to the group; other group mail SHALL route as before. Absent, the flag is false.

#### Scenario: The flag is read
- **WHEN** `reviewers.md` sets `crossModelReview: true`
- **THEN** the loaded group has cross-model review on

#### Scenario: A non-boolean rejects the file
- **WHEN** `reviewers.md` sets `crossModelReview: yes`
- **THEN** the group catalog reports an error naming the file and the key, and the group is not loaded

#### Scenario: Plain group mail is not filtered
- **WHEN** a lead sends an ordinary message, not a review handoff, to a cross-model group whose only idle member shares the family of the task's result author
- **THEN** the message routes to that member as before

### Requirement: Cross-model review excludes the authors' model families
For a review handoff to a cross-model group, the authors SHALL be the profiles of every agent that submitted a result on the task, and route candidates SHALL exclude every member and spawn slot whose profile's model family is an author's family. The filter SHALL run in the shared eligibility check before any routing rule, for agent, human, and plan-execution handoffs alike, and SHALL also exclude the task owner when ineligible.

#### Scenario: An Opus result goes to the Sol reviewer
- **WHEN** an `opus` developer submitted the task's only result and a review handoff reaches `reviewers` with idle `opus` and `codex-sol` members
- **THEN** only the `codex-sol` member is a candidate, and the `opus` member is excluded by `cross-model`

#### Scenario: Every round's author counts
- **WHEN** an `opus` developer submitted round 1, a `codex-sol` developer submitted round 2, and the group's workers are `opus` and `codex-sol`
- **THEN** no candidate is eligible and the review waits

#### Scenario: Families, not profile ids, are compared
- **WHEN** an `opus` developer authored the result and the group's only idle member runs `openrouter-opus`, both of family `claude`
- **THEN** that member is excluded by `cross-model`

#### Scenario: A rule cannot pick an excluded candidate
- **WHEN** a routing rule names the `opus` member for a review of an `opus`-authored result
- **THEN** the pick is treated as unknown and the built-in strategy picks among the remaining candidates

#### Scenario: The task owner yields to the filter
- **WHEN** the group routes by task owner, the owner reviewer runs the author's family, and another reviewer of a different family is idle
- **THEN** the review goes to the other reviewer

#### Scenario: Human-submitted results add no family
- **WHEN** the task's only result was submitted by the human
- **THEN** the filter excludes no candidate

### Requirement: An unknown author's family holds the review
When an agent author's profile cannot be determined, a review handoff to a cross-model group SHALL route to no candidate and SHALL wait with the `cross-model` reason naming the unknown author, until the human hands it elsewhere or cancels it.

#### Scenario: A result with no recoverable profile
- **WHEN** a result has no recorded profile and its author's session record is gone
- **THEN** the review waits, and its reason names that session as an unknown author

### Requirement: A worker choice inside the authors' families is refused
A review handoff to a cross-model group whose worker choice names only workers of the authors' families SHALL be refused at the handoff, writing nothing, with an error naming the shared family. A choice that keeps at least one other-family worker SHALL be accepted.

#### Scenario: Choosing the author's model is refused
- **WHEN** a lead hands an `opus`-authored result to `reviewers` with `worker: opus`
- **THEN** the handoff is refused naming family `claude`, and no assignment or mail is written

#### Scenario: A provider choice with another family is accepted
- **WHEN** the choice names provider `openrouter`, whose models include family `claude` and family `deepseek`, for an `opus`-authored result
- **THEN** the handoff is accepted, and only `deepseek` candidates may take it
