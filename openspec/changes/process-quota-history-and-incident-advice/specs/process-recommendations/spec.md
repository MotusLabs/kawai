# Spec Delta

## Purpose

Turn process observations into versioned, human-decided advice about quota, context, and workflow choices, without automatic routing or configuration changes.

## ADDED Requirements

### Requirement: Incident advice is available before statistical baselines
Kawai SHALL evaluate recorded quota and context incidents after they are committed, without waiting for a daily report or a minimum historical sample. Advice with insufficient outcome evidence SHALL be labeled provisional and separate observed facts, assumptions and unknowns. An incident with no viable known alternative SHALL say so.

#### Scenario: First quota incident
- **WHEN** a provider hits its limit and an eligible independent provider has fresh capacity observations but no completion baseline
- **THEN** Kawai presents provisional switch-versus-wait advice with unknown execution and handoff costs

#### Scenario: No usable alternative
- **WHEN** all eligible alternatives are limited or have unknown capacity
- **THEN** the incident explains those constraints without claiming a switch is available

### Requirement: Switch comparisons respect all eligibility and quota constraints
Switch-versus-wait assessments SHALL use provider/account sharing, model-scoped windows, worker selection, group/plan restrictions, cross-model review rules, caps, worktree occupancy and holds. Wait estimates SHALL include applicable reset and remaining execution; switch estimates SHALL include handoff, context rebuilding, execution and rework. Unsupported estimates SHALL remain unknown.

#### Scenario: Another model on the same account
- **WHEN** two models share an exhausted account-wide allowance
- **THEN** switching between them is not presented as restored capacity

#### Scenario: Empty writer slot required
- **WHEN** provider B has capacity but the worktree has an occupied writer slot
- **THEN** the assessment names release or handoff readiness as a prerequisite and does not promise immediate execution

### Requirement: Assessments are immutable and versioned
A recommendation SHALL have a stable identity and immutable numbered assessments containing evidence as of a recorded cutoff, rule version, sample sizes, coverage, uncertainty and rationale. Reassessment SHALL preserve earlier assessments and mark the current advice as new, strengthened, revised, withdrawn or resolved. Unchanged assessments SHALL NOT create duplicate advice.

#### Scenario: New evidence reverses advice
- **WHEN** later outcomes show the proposed model increases acceptance time
- **THEN** a new assessment explains the revision and the earlier recommendation and its evidence remain readable

### Requirement: Incident advice reuses existing episodes
Recommendations for an existing context-exhaustion or plan-stall episode SHALL attach to that episode and its attention item. They SHALL NOT independently redefine stall thresholds, classify named waits as no-progress stalls, or send a duplicate recovery request. Standalone managed-task incidents SHALL have equivalent durable episode deduplication.

#### Scenario: Restart during a plan stall
- **WHEN** the server restarts while a previously alerted plan stall continues
- **THEN** its recommendation remains attached to the same episode without a second stall alert

### Requirement: Recommendations share the existing Metrics and report surfaces
The team Metrics view SHALL show current incident advice, assessment history and evidence links. Existing incident views SHALL link to relevant advice. Team-bound read-only tools SHALL expose the same records without granting agent decision or execution rights. Commands SHALL refuse cross-team references.

#### Scenario: Agent reads advice
- **WHEN** a lead reads its team's recommendations
- **THEN** it receives the same assessment and evidence the human sees and gains no tool to approve or apply it
