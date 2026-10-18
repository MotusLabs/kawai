# Spec Delta

## Purpose

Provide timely, revisable advice for shortening time to accepted results, with inspectable evidence, human-controlled interventions and token and review-quality guardrails.

## ADDED Requirements

### Requirement: Recommendations optimize acceptance time with guardrails
Each recommendation SHALL identify its proposed action, expected effect on time to an accepted result, token impact, review-quality guardrails and eligible scope. Unknown effects SHALL be stated. Faster turns or lower token counts alone SHALL NOT establish that task completion improved.

#### Scenario: Fast model causes rework
- **WHEN** an alternative model has shorter turns but more fix iterations and slower acceptance
- **THEN** the assessment does not describe it as an improvement based on turn speed alone

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

### Requirement: Human decisions and interventions are separate records
Only the human SHALL accept, reject or defer a recommendation assessment. Decisions SHALL bind to that assessment and replay idempotently. Applying an action SHALL remain on existing authorized paths. Actual interventions SHALL be explicitly linked to assignments, agent starts, settings versions or experiments; accepting advice alone SHALL NOT mark it implemented.

#### Scenario: Recommendation accepted
- **WHEN** the human accepts switching advice
- **THEN** the decision is recorded but no chat is restarted, model switched or task dispatched by that acceptance

#### Scenario: Revised action
- **WHEN** a reassessment changes the recommended model or threshold
- **THEN** an older approval does not approve the changed action

### Requirement: Outcomes distinguish observations from causal claims
Intervention outcomes SHALL report acceptance time, tokens and review-quality measures with sample sizes, unfinished work, coverage and comparable cohort definitions. Observational before/after comparisons SHALL be labeled observational. Insufficient evidence SHALL produce an undetermined outcome, not a claimed improvement. Later reopens SHALL update the quality assessment.

#### Scenario: Small compaction sample
- **WHEN** three accepted tasks used a new threshold
- **THEN** their results are visible but the recommendation does not claim an established optimum

### Requirement: Experiments require an explicit human scope
Kawai SHALL let the human record a model or compaction experiment with hypothesis, baseline/treatment, scope, settings, acceptance-time objective, token/quality guardrails and stopping criteria. Actual assignments and starts SHALL be linked explicitly. Recording an experiment SHALL NOT execute it, alter routing or compact a chat. Confounded or mixed cohorts SHALL be identified.

#### Scenario: Compaction experiment proposed
- **WHEN** advice suggests a lower threshold after exhaustion
- **THEN** the human can record a bounded comparison and Kawai waits for independently authorized configuration and work

### Requirement: Each team receives one daily reassessment digest
Kawai SHALL durably schedule one daily digest per team at a configurable local time and time zone, defaulting to 09:00 UTC. It SHALL reassess open advice and intervention outcomes, summarize changed/resolved items and bottlenecks, and retain unchanged items by reference. Delivery SHALL be inside Kawai and SHALL NOT require a running agent or Prometheus.

#### Scenario: Restart after scheduled time
- **WHEN** Kawai restarts after a digest was due
- **THEN** it creates one catch-up digest for the latest due date, records the missed interval, and creates no duplicate digest for that date

#### Scenario: No new evidence
- **WHEN** the daily reassessment finds no material evidence change
- **THEN** the digest states that fact and does not mint fresh copies of unchanged recommendations

### Requirement: Recommendations share the existing Metrics and report surfaces
The team Metrics view SHALL show current advice, assessment history, evidence links, decisions, intervention outcomes, experiments and digest freshness. Existing incident views SHALL link to relevant advice. Team-bound read-only tools SHALL expose the same records without granting agent decision or execution rights. Human commands SHALL refuse cross-team references and conflicting replays.

#### Scenario: Agent reads advice
- **WHEN** a lead reads its team's recommendations
- **THEN** it receives the same assessment and evidence the human sees and gains no tool to approve or apply it
