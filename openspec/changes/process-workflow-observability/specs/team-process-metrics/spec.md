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

### Requirement: Report snapshots keep their definition version
Existing report snapshots SHALL retain the observation definition version and values with which they were created; recommendation evidence and reports SHALL use the same definitions as the Metrics view.

#### Scenario: Definition changes after a report
- **WHEN** a metric definition version changes after a report was submitted
- **THEN** the report still shows its original values with its original definition version
