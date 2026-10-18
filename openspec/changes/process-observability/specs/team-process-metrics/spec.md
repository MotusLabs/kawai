# Spec Delta

## ADDED Requirements

### Requirement: Acceptance time is the primary optimization metric
Kawai SHALL add p50/p90 task creation-to-first-result-acceptance durations, using tasks whose first acceptance falls in the selected window. It SHALL pair them with tokens per accepted task, first-pass review yield, fix iterations and reopen evidence, showing coverage and sample counts. Existing first-done lead time SHALL keep its current definition and name.

#### Scenario: Done without acceptance
- **WHEN** a task is marked done without an accepted result
- **THEN** it can count toward existing first-done lead time but not toward acceptance-time completion

#### Scenario: Reaccepted task
- **WHEN** a task first accepted before the window is reopened and accepted again inside it
- **THEN** it contributes rework evidence without re-entering the first-acceptance cohort

### Requirement: Stage measurements distinguish turnaround and execution
Metrics SHALL show elapsed stage and wait durations separately from accumulated agent execution, with count, coverage and drill-down. Review turnaround SHALL NOT be labeled active review time. Concurrent stage/wait causes SHALL follow the declared non-overlapping task-time attribution while preserving other causes in detail.

#### Scenario: Review handoff still queued
- **WHEN** a task is in review but its handoff has not been delivered
- **THEN** its elapsed review time is classified as queueing rather than reviewer execution

### Requirement: Unfinished work is visible beside completion metrics
Each metric window SHALL also show currently unaccepted open-task count, age distribution and current stage/waits. Closed tasks without acceptance SHALL be shown as a coverage gap. Incomplete usage and unknown intervals SHALL be identified rather than presented as fully measured zeros.

#### Scenario: Completion bias
- **WHEN** short tasks finish while several long tasks remain blocked
- **THEN** completion metrics are accompanied by those unfinished tasks and their ages

### Requirement: Early advice does not waive evidence sufficiency
Existing sample thresholds SHALL remain on statistical metrics and proposal outcomes. Provisional incident advice SHALL be available below those thresholds, but SHALL retain the small sample flag and SHALL NOT present an undetermined outcome as demonstrated improvement.

#### Scenario: One handoff
- **WHEN** a successful handoff supplies the only comparison sample
- **THEN** its observed outcome can inform provisional advice while the comparative metric remains insufficient

### Requirement: Observation definitions are shared across surfaces
The Metrics view, team tools, reports, recommendation evidence and Prometheus export SHALL share observation definitions, units and scope. Histogram approximations SHALL be distinguished from exact read-time percentiles. Existing report snapshots SHALL retain the definition version and values with which they were created.

#### Scenario: Different percentile methods
- **WHEN** Prometheus estimates a percentile from histogram buckets
- **THEN** it is documented as an approximation and is not claimed to equal the Metrics view's exact percentile
