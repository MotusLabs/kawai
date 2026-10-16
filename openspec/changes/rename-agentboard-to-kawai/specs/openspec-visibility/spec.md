## MODIFIED Requirements

### Requirement: Automatically synchronize OpenSpec metadata
The system SHALL automatically refresh a worktree's OpenSpec snapshot after relevant configuration, change, spec, design, or task files change and SHALL periodically reconcile snapshots to recover from missed events.

#### Scenario: Task completion changes externally
- **WHEN** an OpenSpec task is marked complete outside Kawai
- **THEN** the updated task progress appears without a page reload or manual refresh

#### Scenario: Change is created externally
- **WHEN** an active OpenSpec change is created in a discovered worktree outside Kawai
- **THEN** the change appears automatically in that worktree group

#### Scenario: Rapid artifact writes occur
- **WHEN** multiple related OpenSpec files change in a short interval
- **THEN** the system coalesces discovery work and publishes a consistent resulting snapshot
