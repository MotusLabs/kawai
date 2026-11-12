# Spec Delta

## ADDED Requirements

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
