# Spec Delta

## ADDED Requirements

### Requirement: Group chat sessions by current working directory
The system SHALL place each live chat session in the change, worktree, or
`Workspace` section derived from that session's current working directory,
using the same deepest-path association as terminal sessions. A chat created
in a worktree SHALL appear under that worktree's section. When a chat's working
directory moves to another worktree, the next session update SHALL move the
session to the section for the new directory without a page reload.

#### Scenario: Chat started in a worktree
- **WHEN** a chat session is created with a discovered worktree as its project path
- **THEN** the navigator lists that session in the matching change or worktree section, not in `Workspace`

#### Scenario: Chat agent enters a worktree
- **WHEN** a live chat session's working directory changes from one discovered worktree to another
- **THEN** the navigator moves the session to the section derived from the new worktree

#### Scenario: Chat agent is inside a worktree subdirectory
- **WHEN** a live chat session's working directory is a directory beneath a discovered worktree root
- **THEN** the navigator associates the session with that worktree using the deepest matching path

#### Scenario: Chat leaves Git entirely
- **WHEN** a live chat session's working directory changes to a path that matches no discovered worktree
- **THEN** the navigator moves the session to the `Workspace` section
