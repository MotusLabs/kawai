# process-observations Specification

## Purpose
Preserve attributed observations of Kawai-managed development compactly, so intra-turn timing stays inspectable without the stored detail dominating the database or its backups.

## Requirements

### Requirement: Turn activity is recorded as per-turn phase totals
Kawai SHALL record a managed turn's model activity as the seconds spent in each activity phase, stored once on the turn's end observation, and SHALL NOT store a separate observation per phase segment. Totals SHALL include every completed, failed, interrupted, and process-ended turn; a turn closed by a restart SHALL carry the totals known at its last checkpoint and be marked partial.

#### Scenario: Turn with many phase changes
- **WHEN** a managed turn alternates between thinking, requesting, and running tools seventy times and completes
- **THEN** exactly one turn-end observation records the seconds per phase, and no per-segment activity observation exists for the turn

#### Scenario: Restart mid-turn
- **WHEN** the server stops during a turn and restarts
- **THEN** the turn ends as process-ended with the phase totals known at its last checkpoint, marked partial, and the unobserved gap is recorded

### Requirement: Tool calls and requests are stored once, at completion
Kawai SHALL store each tool call and each approval or question of a managed turn as one observation, written when it completes or when the turn closes with it still open, and SHALL NOT store a separate observation for its start. The observation SHALL carry its start time and duration.

#### Scenario: One call, one row
- **WHEN** a turn runs a shell call that fails after 41 seconds
- **THEN** exactly one tool observation exists for the call, with its start time, 41 seconds, and outcome failed

#### Scenario: Call open at turn end
- **WHEN** a turn is interrupted while a tool call is running
- **THEN** one partial tool observation records the call with outcome unavailable, and no start observation exists

#### Scenario: Answered question
- **WHEN** an agent's question waits 3 minutes and is answered
- **THEN** one request observation records kind question, its start time, 180 seconds, and outcome answered

### Requirement: Unmatched request resolutions are counted, not stored
A request resolution with no open approval or question in the live turn SHALL NOT be stored as an observation; the turn SHALL count such resolutions on its end observation.

#### Scenario: Auto-approved tool
- **WHEN** a tool is granted under the auto approval policy and its resolution arrives without an approval request
- **THEN** no request observation is stored and the turn's unmatched-resolution count increases by one

### Requirement: Observation keys and team scope are stored once
Each observation SHALL record its team once, on the observation itself. The retained key ledger SHALL hold only durable-source keys that must outlive detail retention; keys of live chat facts SHALL be deduplicated by the observation's own unique key and leave with it. Duplicate delivery SHALL still count each stored source at most once.

#### Scenario: Duplicate chat event
- **WHEN** the same turn-start event is delivered twice
- **THEN** one turn-start observation exists and no ledger row is written for it

#### Scenario: Durable source after pruning
- **WHEN** a usage row's observation was pruned and the reconciler scans usage again
- **THEN** the retained ledger key prevents recording that usage a second time

### Requirement: Existing detail is compacted once
The schema migration that introduces compact storage SHALL delete stored per-segment activity observations, tool and request start observations, and unmatched request observations, together with their ledger keys and team associations, and SHALL leave every other observation, export total, checkpoint, and durable key unchanged.

#### Scenario: Upgrade with ten days of detail
- **WHEN** a database holding activity segments, tool start and result rows, and orphan request rows is migrated
- **THEN** no activity segment, start row, or unmatched request observation remains, tool result rows remain readable, and the exported lifetime totals are identical before and after

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

### Requirement: Turn timing includes non-completing outcomes
Kawai SHALL record available turn start/end times and per-turn activity totals for completed, failed, interrupted and process-ended turns. Restart uncertainty SHALL be marked. Usage SHALL retain its provider-reported scope and completeness; missing usage on interrupted turns SHALL NOT be presented as zero measured consumption.

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

### Requirement: History has bounded retention and visible coverage
Fact observations (task, acceptance, usage, turn outcome) SHALL be retained 90 days by default and intra-turn interval detail (activity, tool, request, context, turn start, attribution) 14 days. Export totals and source identities SHALL survive pruning. Reads SHALL identify recording start, gaps, retained horizon and usage omissions. Stored observations SHALL exclude credentials, raw prompts and raw tool output.

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
