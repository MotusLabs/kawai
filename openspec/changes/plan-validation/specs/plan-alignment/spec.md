# Spec Delta

## Purpose

Records how a plan revision relates to the approved product strategy it pins: one of five assessments with its outcomes, conditions, or conflicts, written by agents or the owner. A conflict blocks readiness until the owner's scoped exception. With no approved strategy, alignment is unassessed. Alignment never authorizes anything.

## ADDED Requirements

### Requirement: Alignment is assessed against the pinned strategy
An agent or the owner SHALL be able to record an alignment assessment for an `in_review` or `approved` revision whose strategy pin is not empty. An assessment SHALL be one of `aligned`, `aligned-with-conditions`, `exploratory`, `conflicting`, or `insufficient-information`, with a rationale, its author, and the outcomes it advances as references the pinned revision defines. Undefined references SHALL be refused.

#### Scenario: Invented reference
- **WHEN** an agent's assessment cites a use-case reference the pinned strategy revision does not define
- **THEN** the assessment is refused naming the reference and nothing is written

#### Scenario: Author recorded
- **WHEN** the Lead records an `aligned` assessment
- **THEN** the revision's validation shows the assessment with the Lead's session as its author

### Requirement: Each assessment carries what its value needs
An `aligned-with-conditions` assessment SHALL carry at least one condition, each gated at `ready`, `start`, or `acceptance`. An `exploratory` assessment SHALL carry experiment criteria and scope. A `conflicting` assessment SHALL carry at least one conflict. An assessment missing what its value needs SHALL be refused.

#### Scenario: Conditions missing
- **WHEN** an assessment says `aligned-with-conditions` with no condition
- **THEN** it is refused and nothing is written

#### Scenario: Conflict not named
- **WHEN** an assessment says `conflicting` with no conflict
- **THEN** it is refused and nothing is written

### Requirement: No approved strategy means alignment is unassessed
A revision with an empty strategy pin SHALL show Alignment unassessed. Unassessed SHALL pass readiness and SHALL never be recorded as one of the five assessments. An alignment assessment for such a revision SHALL be refused, and no strategy binding SHALL be created for it.

#### Scenario: Standalone plan without a strategy
- **WHEN** a team with no approved strategy validates a plan revision whose other checks pass
- **THEN** the report is ready and labeled Alignment unassessed, and the revision keeps its empty pin

#### Scenario: Assessment refused without a pin
- **WHEN** an agent records an alignment assessment for a revision with an empty pin
- **THEN** it is refused as "no approved strategy: alignment is unassessed"

### Requirement: The newest assessment decides, with its conditions
The newest alignment assessment of a revision SHALL be effective. `aligned` SHALL pass. `aligned-with-conditions` SHALL pass once the owner resolves each `ready` condition, and its `start` and `acceptance` conditions SHALL be carried in the report. `exploratory` and `insufficient-information` SHALL pass only with the owner's exploration authorization naming its bounds. No assessment SHALL block.

#### Scenario: Ready condition open
- **WHEN** the effective assessment has an unresolved `ready` condition
- **THEN** the report is not ready and names the condition

#### Scenario: Start condition carried
- **WHEN** the effective assessment's only condition is gated at `start`
- **THEN** the report can be ready and lists the condition as carried and unresolved

#### Scenario: Insufficient information
- **WHEN** the effective assessment is `insufficient-information`
- **THEN** the report is not ready until the owner authorizes bounded exploration or a later assessment passes

### Requirement: A conflict blocks until the owner's exception
Any `conflicting` assessment of a revision SHALL block readiness until the owner records an alignment exception for it with a scope and a rationale, whatever later assessments say and whoever wrote them. No agent SHALL be able to record an exception, change the strategy, or clear a conflict.

#### Scenario: Plan violates an approved non-goal
- **WHEN** an agent assesses a revision as `conflicting` with an approved non-goal
- **THEN** its reports are not ready, absent the owner's exception

#### Scenario: A later assessment does not clear it
- **WHEN** another agent later records `aligned` for the same revision
- **THEN** the conflict still blocks readiness

#### Scenario: Owner's scoped exception
- **WHEN** the owner records an exception for that conflict with a scope and a rationale
- **THEN** the next validation's alignment passes and the exception is retained with its scope, rationale, and deciding actor

### Requirement: Alignment never authorizes anything
An alignment assessment or owner alignment decision SHALL authorize no tool, grant no permission, approve no plan, and change no strategy revision. It SHALL be an input to validation readiness only.

#### Scenario: Exception does not approve
- **WHEN** the owner records an alignment exception
- **THEN** the revision stays `in_review` until the human approves it under every precondition

#### Scenario: Exploration grants nothing
- **WHEN** the owner authorizes bounded exploration for a revision
- **THEN** no tool permission, task, or message is created
