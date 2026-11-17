# Spec Delta

## ADDED Requirements

### Requirement: Recommendations optimize acceptance time with guardrails
Each recommendation SHALL identify its proposed action, expected effect on time to an accepted result, token impact, review-quality guardrails and eligible scope. Unknown effects SHALL be stated. Faster turns or lower token counts alone SHALL NOT establish that task completion improved.

#### Scenario: Fast model causes rework
- **WHEN** an alternative model has shorter turns but more fix iterations and slower acceptance
- **THEN** the assessment does not describe it as an improvement based on turn speed alone

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

### Requirement: Workflow records outlive observation detail
Human decisions, interventions, experiment definitions and digests SHALL survive observation pruning, and their detailed links SHALL state expired evidence rather than disappear.

#### Scenario: Digest after pruning
- **WHEN** the observations behind an older digest are pruned
- **THEN** the digest remains readable and its detailed links state that the records expired

## MODIFIED Requirements

### Requirement: Recommendations share the existing Metrics and report surfaces
The team Metrics view SHALL show current advice, assessment history, evidence links, decisions, intervention outcomes, experiments and digest freshness. Existing incident views SHALL link to relevant advice. Team-bound read-only tools SHALL expose the same records without granting agent decision or execution rights. Human commands SHALL refuse cross-team references and conflicting replays.

#### Scenario: Agent reads advice
- **WHEN** a lead reads its team's recommendations
- **THEN** it receives the same assessment and evidence the human sees and gains no tool to approve or apply it
