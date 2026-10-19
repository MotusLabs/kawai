# Spec Delta

## ADDED Requirements

### Requirement: Flagged spawned members are released
When a spawned member is flagged context-exhausted, it SHALL be marked for release, durably and with reason `context-exhausted`, and released through the same readiness and archive path as any other release, with a journal entry on its task. Parked work it holds SHALL be released to its group first. Human-created sessions SHALL never be released this way.

#### Scenario: Idle exhausted dev
- **WHEN** a spawned dev is flagged and is otherwise ready
- **THEN** it is archived, its worktree writer slot frees, and its task's journal names it and the reason

#### Scenario: Background task still running
- **WHEN** a flagged spawned member still has a running background task
- **THEN** its release waits until it is ready, and survives a restart

#### Scenario: Human-created session
- **WHEN** a session the human created is flagged
- **THEN** it is not released
