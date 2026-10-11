# Spec Delta

## ADDED Requirements

### Requirement: Chat session path follows the agent's working directory
After creation, a chat session's associated project path SHALL track the
agent's working directory: when that directory changes, the session's path
SHALL update to the new directory and every attached client SHALL see the
update. The creation path is only the starting directory; later
working-directory changes replace it for navigator grouping, the project
badge, project filters, workspace discovery, and any later (re)start of the
agent.

#### Scenario: Agent enters a worktree
- **WHEN** a live chat session's agent moves its working directory into a discovered Git worktree
- **THEN** the session's associated project path becomes that worktree directory and the left menu moves the session into the matching worktree or change section

#### Scenario: Agent leaves a worktree
- **WHEN** a live chat session's agent moves its working directory out of a worktree into another directory
- **THEN** the session's associated project path becomes that directory and the left menu moves the session to the section derived from it

#### Scenario: Chat started in a worktree
- **WHEN** a chat session is created with a worktree as its project path
- **THEN** its associated project path is that worktree and the left menu shows the session under that worktree's section

#### Scenario: Update survives restart
- **WHEN** the agent's working directory has changed and the server later restarts and resumes the session
- **THEN** the session's project path is the most recent working directory, not the original creation path

#### Scenario: Archived chat keeps its last path
- **WHEN** a chat session whose agent changed working directory is archived
- **THEN** the archived session keeps the most recent working directory as its project path and still appears in `Archive`
