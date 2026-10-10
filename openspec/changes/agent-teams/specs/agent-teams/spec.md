# Spec Delta

## Purpose

Lets chat agents in one repository work as a team of roles: groups are defined in `.kawai/groups/` files, each chat session may belong to one group, and members are told their role and the team's groups.

## ADDED Requirements

### Requirement: Groups are defined by files
The system SHALL read group definitions from `.kawai/groups/<id>.md` files in the team's repository and in the user's home `.kawai/groups/` directory. A group's id SHALL be its file name without extension, using lowercase letters, digits, and hyphens and starting with a letter or digit. A project file SHALL replace a user-level file with the same id.

#### Scenario: Project group is discovered
- **WHEN** the repository contains `.kawai/groups/architects.md`
- **THEN** a group with id `architects` is available to the repository's team

#### Scenario: User-level group is available to every team
- **WHEN** `~/.kawai/groups/qa.md` exists and a repository defines no `qa` group
- **THEN** the `qa` group is available to that repository's team

#### Scenario: Project file overrides user-level file
- **WHEN** both `~/.kawai/groups/devs.md` and the repository's `.kawai/groups/devs.md` exist
- **THEN** the team's `devs` group is defined by the repository's file

#### Scenario: Invalid id is ignored
- **WHEN** a file named `Team Lead.md` is present in `.kawai/groups/`
- **THEN** no group is created from it and the problem is reported

### Requirement: Group file format
A group file SHALL consist of optional YAML frontmatter and a markdown body. The frontmatter SHALL accept `label` (display name, defaulting to the id), `description` (one line shown to other agents), and `hopLimit` (positive integer). The body SHALL be the group's role prompt. A file whose frontmatter fails validation SHALL be skipped and reported, and other groups SHALL remain available.

#### Scenario: Label and description are read
- **WHEN** a group file sets `label: Architects` and `description: Owns system design`
- **THEN** the group is shown as `Architects` and its description is `Owns system design`

#### Scenario: Missing label defaults to id
- **WHEN** a group file has no `label`
- **THEN** the group is shown by its id

#### Scenario: Invalid frontmatter is skipped
- **WHEN** one group file has malformed frontmatter and another is valid
- **THEN** only the valid group is available and the malformed file is reported with its path

### Requirement: A team is a git repository
The system SHALL treat all chat sessions whose project directories belong to the same git repository — its main working tree or any linked worktree — as one team. Chat sessions in a directory outside any git repository SHALL form a team scoped to that directory. Group definitions SHALL be resolved from the repository's main working tree.

#### Scenario: Worktree sessions share a team
- **WHEN** one chat session runs in the repository's main checkout and another runs in a linked worktree of it
- **THEN** both sessions are members of the same team and share its mailboxes

#### Scenario: Different repositories are separate teams
- **WHEN** two chat sessions run in different repositories that both define a `devs` group
- **THEN** a message to `devs` from one session is never delivered to the other

#### Scenario: Non-repository directory
- **WHEN** a chat session runs in a directory that is not inside a git repository
- **THEN** its team contains only sessions in that same directory

### Requirement: Chat sessions may be assigned a group at creation
The new-session dialog SHALL let the user choose one of the team's groups, or none, when creating a chat session. The chosen group SHALL be stored with the session and SHALL persist across restart, archive, and restore. A session's group SHALL NOT change after creation.

#### Scenario: Group chosen at creation
- **WHEN** the user creates a chat session with group `devs`
- **THEN** the session is a member of `devs` and the navigator shows its group

#### Scenario: Group survives restore
- **WHEN** a `devs` chat session is archived and restored
- **THEN** it is still a member of `devs`

#### Scenario: No group
- **WHEN** the user creates a chat session without choosing a group
- **THEN** the session belongs to no group, can still send and receive direct messages, and never receives group mail

#### Scenario: Group missing after file removal
- **WHEN** a session's group file is removed
- **THEN** the session keeps its stored group id, the navigator marks the group as missing, and the session receives no new group mail until the group is defined again

### Requirement: Members receive their role and team context
When a group member's agent process starts, the system SHALL add to its system prompt the group's role prompt and a mailbox note naming the member's group, every group of the team with its description, and how messages arrive and are sent. A session without a group SHALL receive the mailbox note without a role prompt.

#### Scenario: Role prompt applied at spawn
- **WHEN** a `qa` member's agent starts
- **THEN** its system prompt includes the `qa` group's body and a list of the team's groups with descriptions

#### Scenario: Edited prompt affects only later spawns
- **WHEN** a group file's body is edited while a member's agent is running
- **THEN** the running agent's prompt is unchanged, and the next start of that member uses the edited body
