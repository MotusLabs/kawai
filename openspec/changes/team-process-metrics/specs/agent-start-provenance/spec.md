# Spec Delta

## Purpose

Records what each chat agent process started with (group file, system-prompt addition, shared memory, project instructions, profile, model, and effort) so outcomes can be attributed to the prompt and memory versions that produced them.

## ADDED Requirements

### Requirement: Kawai records each agent start
Each time a chat session's agent process starts, including a respawn or resume, Kawai SHALL record one agent start naming the session, team, group, profile, model, effort, working directory, and time, plus content hashes of the inputs that shape its behavior. Recording SHALL NOT delay or prevent the start; a failure SHALL be logged.

#### Scenario: A spawned dev starts
- **WHEN** a dev of group `middle-devs` is spawned for a task
- **THEN** an agent start names the session, `middle-devs`, its profile, model, effort, and directory

#### Scenario: Respawn after a crash
- **WHEN** a session's agent process dies and is respawned
- **THEN** a second agent start is recorded for the same session

#### Scenario: Hashing fails
- **WHEN** a hashed input cannot be read
- **THEN** the agent starts normally and that hash is recorded as unavailable

### Requirement: Group prompt inputs are hashed
An agent start SHALL record a hash of the group file in effect for the session's group (its full content, frontmatter included) and a hash of the system-prompt addition the agent actually received. A session without a group SHALL record no group file hash. Equal content SHALL produce equal hashes.

#### Scenario: Prompt edited between starts
- **WHEN** `reviewers.md` changes between two reviewer starts
- **THEN** the two starts record different group file hashes

#### Scenario: Unchanged file
- **WHEN** two members of a group start with the file unchanged
- **THEN** both record the same group file hash

### Requirement: Shared memory and project instructions are hashed
An agent start SHALL record the Claude auto-memory directory the agent loads for the team's repository as a hash of each file it holds, keyed by file name, plus a hash of the whole directory (absent when none exists), and a hash of the project instruction file in the agent's working directory (absent when none exists).

#### Scenario: Memory edited between starts
- **WHEN** a memory file is added between two starts in the same repository
- **THEN** the two starts record different directory hashes, and only the second lists the new file

#### Scenario: One file changes
- **WHEN** only `feedback-reviews.md` changes between two starts
- **THEN** that file's hash differs between the starts and every other file's hash is equal

#### Scenario: A worktree member
- **WHEN** a member starts in a linked worktree of the repository
- **THEN** its memory hash is computed over the same memory directory as a main-checkout member's

### Requirement: Agent starts are retained and readable
Agent starts SHALL survive restart and SHALL be retained for at least 60 days. Each recorded turn SHALL name the agent start that ran it.

#### Scenario: Attributing a turn
- **WHEN** a reviewer's turn usage is read after a prompt change and a restart
- **THEN** the turn names the agent start, and through it the group file hash it ran with
