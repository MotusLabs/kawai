## MODIFIED Requirements

### Requirement: Automatically synchronize workspace metadata
The system SHALL automatically publish updated repository, branch, and worktree metadata after relevant Git or filesystem changes and SHALL periodically reconcile state to recover from missed watch events.

#### Scenario: External worktree is added
- **WHEN** a worktree is created outside Kawai for a discovered repository
- **THEN** it appears without requiring a page reload or manual refresh

#### Scenario: External branch or checkout changes
- **WHEN** branch refs or a worktree's checked-out revision changes outside Kawai
- **THEN** the affected repository snapshot is updated automatically

#### Scenario: Discovery temporarily fails
- **WHEN** Git discovery fails transiently for a previously discovered repository
- **THEN** the last successful snapshot remains visible with a stale or error indication and later reconciliation retries discovery
