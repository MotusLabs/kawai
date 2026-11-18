# openspec-visibility Specification

## Purpose

Make active OpenSpec planning work visible in each Git worktree and keep its progress current as change artifacts evolve.

## Requirements

### Requirement: Maintain the per-repository change registry
The system SHALL list each discovered repository's unarchived OpenSpec changes from its main worktree's OpenSpec root to seed change sections, and SHALL resolve each change's canonical source to the `.worktrees/<change-name>` copy once that worktree exists, using the registry entry only for changes without a worktree.

#### Scenario: Change exists only in the main worktree
- **WHEN** a repository's main worktree lists an unarchived change and no matching worktree exists
- **THEN** the change section displays the registry's status and progress

#### Scenario: Change has a worktree
- **WHEN** `.worktrees/<change-name>` exists and contains the change
- **THEN** the change section displays status and progress read from that worktree, even if the main worktree's copy is stale

#### Scenario: Worktree lacks the change
- **WHEN** `.worktrees/<change-name>` exists but does not contain the change
- **THEN** the change section still appears from the registry data with a missing-in-worktree indication

#### Scenario: Change is archived in the canonical copy
- **WHEN** the change is archived in its canonical worktree copy or removed from the registry
- **THEN** the change section is removed on the next refresh

### Requirement: Discover OpenSpec changes per worktree
The system SHALL discover active OpenSpec changes independently in each local worktree that contains an OpenSpec root and SHALL associate results only with the filesystem snapshot from which they were read.

#### Scenario: Worktrees contain different changes
- **WHEN** two worktrees of one repository expose different active OpenSpec changes or progress
- **THEN** each worktree group displays only the OpenSpec data discovered in that worktree

#### Scenario: Worktree has no OpenSpec root
- **WHEN** a worktree does not contain or resolve to an OpenSpec root
- **THEN** its worktree group remains usable and does not display fabricated OpenSpec changes

#### Scenario: Archived change exists
- **WHEN** an OpenSpec change is archived and is no longer returned as active
- **THEN** it is removed from the worktree's active-change visualization

### Requirement: Display OpenSpec progress
For each active OpenSpec change, the system SHALL display its name, workflow status, completed task count, total task count, and last-modified information when those values are available.

#### Scenario: Change has incomplete tasks
- **WHEN** OpenSpec reports a change with completed and total task counts
- **THEN** the navigator displays the progress in a compact, accessible form such as `9/11`

#### Scenario: Progress fields are unavailable
- **WHEN** the installed OpenSpec version or selected workflow does not provide task counts
- **THEN** the navigator still displays the change name and available status without inventing progress

#### Scenario: Worktree group is collapsed
- **WHEN** a collapsed worktree contains active OpenSpec changes
- **THEN** its header indicates the number of active changes even though individual change rows are hidden

### Requirement: Automatically synchronize OpenSpec metadata
The system SHALL automatically refresh a worktree's OpenSpec snapshot after relevant configuration, change, spec, design, or task files change and SHALL periodically reconcile snapshots to recover from missed events.

#### Scenario: Task completion changes externally
- **WHEN** an OpenSpec task is marked complete outside Agentboard
- **THEN** the updated task progress appears without a page reload or manual refresh

#### Scenario: Change is created externally
- **WHEN** an active OpenSpec change is created in a discovered worktree outside Agentboard
- **THEN** the change appears automatically in that worktree group

#### Scenario: Rapid artifact writes occur
- **WHEN** multiple related OpenSpec files change in a short interval
- **THEN** the system coalesces discovery work and publishes a consistent resulting snapshot

### Requirement: Isolate OpenSpec discovery failures
The system SHALL isolate discovery errors to the affected worktree and MUST NOT remove valid session or Git workspace information because OpenSpec metadata is unavailable.

#### Scenario: OpenSpec command fails
- **WHEN** OpenSpec discovery returns an error for one worktree
- **THEN** that worktree displays an OpenSpec-specific unavailable or stale indication while other worktrees continue updating

#### Scenario: Last valid data exists
- **WHEN** a refresh fails after a valid OpenSpec snapshot was published
- **THEN** the last valid change data remains visible with a stale indication until discovery succeeds

### Requirement: Reuse unchanged OpenSpec discovery results
Before running OpenSpec for a worktree, the system SHALL fingerprint the inputs `openspec list` reads: the nearest `openspec/` root, its entries, and every file under its active change directories. When the fingerprint matches the worktree's last successful discovery, and that discovery is under 10 minutes old, the system SHALL reuse its result and start no process. A failed or stale result SHALL NOT be reused.

#### Scenario: Nothing changed
- **WHEN** a reconciliation pass reaches a worktree whose OpenSpec inputs have not changed since its successful discovery 2 minutes earlier
- **THEN** the worktree keeps that result and no `openspec` process starts for it

#### Scenario: A task is checked off
- **WHEN** a task in an active change's `tasks.md` is marked complete
- **THEN** the next pass runs OpenSpec for that worktree and publishes the new progress

#### Scenario: A change is created or archived
- **WHEN** a change directory is added under `openspec/changes/`, or moved into `archive/`
- **THEN** the next pass runs OpenSpec for that worktree

#### Scenario: The root moves
- **WHEN** a worktree gains its own `openspec/` directory where it had resolved an ancestor's root, or loses it
- **THEN** the next pass runs OpenSpec for that worktree

#### Scenario: The result is old
- **WHEN** a worktree's last successful discovery is 10 minutes old or more
- **THEN** the next pass runs OpenSpec for it even when the fingerprint matches

#### Scenario: The last run failed
- **WHEN** a worktree's last discovery timed out or failed
- **THEN** the next pass runs OpenSpec for it, whatever the fingerprint

### Requirement: Bound concurrent OpenSpec discovery
The system SHALL run at most 3 `openspec list` processes at once across all repositories and passes. A run's timeout SHALL start when its process starts.

#### Scenario: A full reconciliation
- **WHEN** a reconciliation pass needs OpenSpec runs for 148 worktrees
- **THEN** no more than 3 `openspec` processes run at any moment, and every worktree gets its own result

#### Scenario: A queued run
- **WHEN** a run waits 20 seconds in the queue and its process then answers within 15 seconds
- **THEN** it does not time out
