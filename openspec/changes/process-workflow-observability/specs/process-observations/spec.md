# Spec Delta

## ADDED Requirements

### Requirement: Stage and execution state are independent
Kawai SHALL retain workflow-stage intervals for implementation, review, fixes, QA and acceptance and independently retain execution and waiting intervals. Queueing, model activity, tools, human requests, quota, context, CI, dependencies, staffing, landing slots, holds and pauses SHALL be distinguishable when known. Unsupported or unobserved intervals SHALL be unknown.

#### Scenario: Review queue
- **WHEN** a review handoff waits 90 minutes before a reviewer starts a 20-minute turn
- **THEN** the review stage shows its queue delay separately from observed reviewer execution

#### Scenario: Intentional hold
- **WHEN** a plan change is held by its owner
- **THEN** the hold contributes to elapsed completion time, is identified as intentional waiting, and is not classified as slow model execution

### Requirement: Parallel execution does not inflate task elapsed time
Task elapsed breakdowns SHALL use non-overlapping intervals with a declared attribution rule and show concurrent causes in drill-down. Accumulated agent durations SHALL be reported separately and SHALL be allowed to exceed task elapsed time. Open tasks SHALL show age and current stage/waits alongside completion cohorts.

#### Scenario: Concurrent reviewers
- **WHEN** two reviewers work simultaneously for 20 minutes
- **THEN** accumulated reviewer execution is 40 minutes while the task's elapsed review interval is 20 minutes

#### Scenario: Long-running incomplete task
- **WHEN** a task has no accepted result after two days
- **THEN** it remains visible with its age and waits and is not treated as a zero-duration completion
