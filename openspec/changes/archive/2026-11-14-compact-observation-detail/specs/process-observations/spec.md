# Spec Delta

## Purpose
Preserve attributed observations of Kawai-managed development compactly, so intra-turn timing stays inspectable without the stored detail dominating the database or its backups.

## ADDED Requirements

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
