# Spec Delta

## ADDED Requirements

### Requirement: A Team entry opens the team workspace at repository level
The navigator SHALL show one **Team** entry at repository level for each discovered repository. Opening it SHALL select the team workspace for that repository's team. The entry SHALL NOT be a session row, SHALL NOT be affected by session filters, and SHALL NOT change which chat is selected.

#### Scenario: One entry per repository
- **WHEN** a repository has sessions across several worktrees
- **THEN** the navigator shows one **Team** entry for that repository, not one per worktree

#### Scenario: The entry opens the workspace
- **WHEN** the human opens the **Team** entry
- **THEN** the team workspace for that repository's team opens and the selected chat is unchanged

#### Scenario: Session filters do not hide the entry
- **WHEN** a project or host filter leaves no visible session rows
- **THEN** the **Team** entry for a repository that still has a team remains available
