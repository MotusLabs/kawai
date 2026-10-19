# Spec Delta

## Purpose

Preserve attributed observations of Kawai-managed development so task delays, quota choices and context-management outcomes can be investigated and compared without an external monitoring service.

## ADDED Requirements

### Requirement: Observations cover managed work only
Kawai SHALL collect process observations for its managed chats and team tasks, including managed chats without a task. Each observation SHALL retain its available team, task, assignment, result, session, turn and agent-start identities and observed time. External terminal sessions SHALL NOT enter these observations.

#### Scenario: Task-less coordination
- **WHEN** a managed lead chat completes a turn with no task
- **THEN** its observations belong to the team and chat, carry no task, and do not inflate a task's measured execution

#### Scenario: External terminal activity
- **WHEN** an external Codex terminal session writes a log
- **THEN** no process observation is collected from that log

### Requirement: Observation ingestion is idempotent and non-blocking
Each source observation SHALL have a stable identity and SHALL count at most once across duplicate delivery and replay. Observation failures SHALL leave chat, task and mailbox outcomes unchanged and SHALL expose a collection-health failure and an incomplete measurement interval.

#### Scenario: Duplicate completion
- **WHEN** the same turn completion reaches the recorder twice
- **THEN** its duration, usage reference and exported observation count are recorded once

#### Scenario: Recording fails
- **WHEN** an observation cannot be stored while a result is accepted
- **THEN** acceptance proceeds normally and coverage indicates the missing measurement rather than a successful zero-duration record

### Requirement: Primary completion is recorded result acceptance
The primary completion duration SHALL run from task creation to its first recorded result acceptance. It SHALL retain the accepted result, actor, mechanism and applicable task revision. Closure without acceptance SHALL be reported as missing acceptance. Reopening SHALL retain the first duration and add rework evidence without silently starting a new task.

#### Scenario: Integration acceptance
- **WHEN** Kawai accepts a result after landing on an integration branch
- **THEN** the timer ends at that acceptance, identifies integration landing, and does not claim promotion to the default branch

#### Scenario: Task reopened
- **WHEN** an accepted task reopens and later accepts another result
- **THEN** its first-acceptance duration is unchanged and subsequent work and acceptance remain visible as rework

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

### Requirement: Turn timing includes non-completing outcomes
Kawai SHALL record available turn start/end times and activity intervals for completed, failed, interrupted and process-ended turns. Restart uncertainty SHALL be marked. Usage SHALL retain its provider-reported scope and completeness; missing usage on interrupted turns SHALL NOT be presented as zero measured consumption.

#### Scenario: Interrupted turn
- **WHEN** a managed turn is interrupted after running tools
- **THEN** its known execution time is retained while missing final usage is labeled unavailable

### Requirement: Context and compaction are structured observations
Context observations SHALL retain model, effort, agent-start provenance, configured threshold, measured context tokens, threshold source and approximation. Compaction observations SHALL retain available trigger, before/after tokens, start/end times, outcome and related context failures. Missing measurements SHALL remain unknown and different provider token definitions SHALL remain distinguishable.

#### Scenario: Boundary without post size
- **WHEN** a driver reports compaction without a usable post-compaction token count
- **THEN** the compaction is recorded with unknown post size rather than zero or an invented reduction

#### Scenario: Approximate threshold
- **WHEN** only the model context window is known
- **THEN** comparisons identify that value as an approximate threshold and do not claim it was the configured auto-compaction trigger

### Requirement: Quota observations preserve identity and freshness
Quota history SHALL retain the effective provider/account identity, applicable model and window scope, reported usage/reset, source, per-window observation time, receipt time and collection outcome. A failed or status-only update SHALL NOT freshen older window values. Provider catalog changes SHALL NOT relabel past observations.

#### Scenario: Host-login fallback
- **WHEN** a routed model's report describes an unrelated host Claude login
- **THEN** the report retains that source and does not establish capacity for the routed provider

#### Scenario: Failed refresh
- **WHEN** a refresh fails after a successful quota observation
- **THEN** both the failure and the old observation remain visible with the old window timestamp

### Requirement: Incident alternatives use facts available at the time
At quota/context incidents Kawai SHALL freeze the eligible alternatives, routing constraints, effective cooldowns and latest known quota observations with their age. Historical analysis SHALL use observations available by the incident time and SHALL NOT substitute later quota reports or today's configuration.

#### Scenario: Capacity arrives later
- **WHEN** provider B first reports capacity after provider A's incident
- **THEN** the original incident shows B's capacity as unknown and later advice is a new assessment

### Requirement: History has bounded retention and visible coverage
Fact observations (task, acceptance, usage, turn outcome) SHALL be retained 90 days by default and intra-turn interval detail (activity, tool, request, context, turn start, attribution) 14 days, configurably. Recommendation evidence, decisions, interventions, digests and export totals SHALL survive pruning. Reads SHALL identify recording start, gaps, retained horizon and usage omissions. Stored observations SHALL exclude credentials, raw prompts and raw tool output.

#### Scenario: Detail pruned
- **WHEN** an observation referenced by an older recommendation is pruned
- **THEN** its frozen evidence summary remains readable and its detailed link states that the record expired

#### Scenario: Interval detail ages out first
- **WHEN** a tool interval and an acceptance were both recorded 15 days ago
- **THEN** the tool interval is pruned, the acceptance remains, and the stated detail horizon is no older than 14 days

#### Scenario: Existing history
- **WHEN** an old task has results but no recorded stage intervals
- **THEN** known facts remain usable and missing stage/usage coverage is stated rather than backfilled as measured activity

### Requirement: Source availability is explicit during staged delivery
Kawai SHALL expose which observation sources are installed, available, unsupported or awaiting integration, separately from measurement values and coverage. Missing provider, dispatch or context-recovery integrations SHALL NOT prevent recording supported managed-chat/task facts. Source absence SHALL NOT imply zero usage, shared-account identity or a verified routing alternative.

#### Scenario: Independent foundation
- **WHEN** managed turn/task observation sources are available but shared-provider or canonical incident adapters are not
- **THEN** supported facts are recorded with their actual identity and coverage, unavailable sources are identified, and no account-capacity or canonical-incident facts are invented
