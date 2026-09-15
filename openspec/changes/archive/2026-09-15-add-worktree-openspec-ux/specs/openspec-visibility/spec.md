## Purpose

Make active OpenSpec planning work visible in each Git worktree and keep its progress current as change artifacts evolve.

## ADDED Requirements

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

