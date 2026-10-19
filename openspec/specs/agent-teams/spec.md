# agent-teams Specification

## Purpose

Lets chat agents in one repository work as a team of roles: groups are defined in `.kawai/groups/` files, each chat session may belong to one group, and members are told their role and the team's groups.

## Requirements

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

#### Scenario: Clear a conversation with a missing group
- **WHEN** the user invokes `/clear`, `/reset`, or `/new` in a chat whose stored group definition has been removed
- **THEN** a fresh chat is created with the source chat's stored group, the navigator marks it missing, and the prior chat is archived only after successful creation
- **AND** ordinary new-session creation still refuses unknown group choices

### Requirement: Members receive their role and team context
When a group member's agent process starts, the system SHALL add to its system prompt the group's role prompt and a mailbox note naming the member's group, every group of the team with its description, and how messages arrive and are sent. A session without a group SHALL receive the mailbox note without a role prompt.

#### Scenario: Role prompt applied at spawn
- **WHEN** a `qa` member's agent starts
- **THEN** its system prompt includes the `qa` group's body and a list of the team's groups with descriptions

#### Scenario: Edited prompt affects only later spawns
- **WHEN** a group file's body is edited while a member's agent is running
- **THEN** the running agent's prompt is unchanged, and the next start of that member uses the edited body

### Requirement: Groups may set a reasoning effort
Group frontmatter SHALL accept an optional `effort` of `low`, `medium`, `high`, `xhigh`, or `max`. When a member's agent process starts, the system SHALL launch it with the group's per-profile effort for the member's profile when one is set, else with the group's `effort`, as read from the group file at that start. A member whose group sets neither, or a session without a group, SHALL launch with no effort from kawai, leaving Claude Code's own settings in force.

#### Scenario: Members of different groups get different effort
- **WHEN** the `lead` group sets `effort: max`, the `devs` group sets `effort: medium`, and an agent of each starts
- **THEN** the lead's agent is launched with effort `max` and the developer's agent with effort `medium`

#### Scenario: Spawned and human-created members are treated alike
- **WHEN** the `devs` group sets `effort: medium` and both a worktree-staffing spawn and a member the human created start their agents
- **THEN** both agents are launched with effort `medium`

#### Scenario: No effort leaves Claude Code settings in force
- **WHEN** a group sets no `effort` and one of its members starts
- **THEN** the agent is launched with no effort option, and the effort comes from Claude Code's settings as for a session without a group

#### Scenario: Restart and resume use the current file
- **WHEN** a member's agent is restarted or resumed after its group's `effort` changed from `medium` to `high`
- **THEN** the new agent process is launched with effort `high`

### Requirement: Effort edits apply to later starts only
Changing or removing a group's `effort` SHALL NOT alter an agent process that is already running; the next start of each member SHALL use the file's current value. An effort the user sets inside a running chat SHALL remain in effect for that process until it ends.

#### Scenario: Edited effort reaches only the next start
- **WHEN** a group's `effort` is edited while a member's agent is running
- **THEN** that agent keeps its launch effort, and its next start uses the edited value

### Requirement: An invalid effort is a warning
An `effort` value other than the five levels SHALL NOT reject the group file. The system SHALL report it as a group warning wherever group warnings are shown, and the group SHALL behave as if `effort` were unset while its other settings still apply.

#### Scenario: Unknown level is warned and ignored
- **WHEN** a group file sets `effort: extreme`
- **THEN** the group stays available with its other settings, a warning names the invalid value, and its members launch with no effort from kawai

### Requirement: Groups may set a reasoning effort per profile
Group frontmatter SHALL accept an optional `profileEffort`: a single-line flow map from profile id to one of the five effort levels. A member whose session profile has an entry SHALL launch with that level instead of the group's `effort`, whether it was spawned or created by the human. Members on other profiles SHALL keep the group's `effort`. Like `effort`, the map SHALL be read from the group file at each agent start.

#### Scenario: A profile entry overrides the group effort
- **WHEN** the `juniors` group sets `effort: low` and `profileEffort: { haiku: xhigh }`, and a member on `haiku` and a member on `glm-flash` start their agents
- **THEN** the `haiku` member's agent is launched with effort `xhigh` and the `glm-flash` member's with effort `low`

#### Scenario: A profile entry applies without a group effort
- **WHEN** a group sets `profileEffort: { haiku: xhigh }` and no `effort`, and members on `haiku` and on `sonnet` start their agents
- **THEN** the `haiku` member's agent is launched with effort `xhigh`, and the `sonnet` member's with no effort from kawai

#### Scenario: Human-created members follow their profile
- **WHEN** the human creates a member of the `juniors` group on the `haiku` profile and its agent starts
- **THEN** the agent is launched with effort `xhigh`, as a spawned `haiku` member would be

#### Scenario: An edited entry reaches only the next start
- **WHEN** the `haiku` entry changes from `xhigh` to `high` while a `haiku` member's agent is running
- **THEN** the running agent keeps effort `xhigh`, and that member's next start uses `high`

### Requirement: Invalid per-profile effort entries are warnings
A malformed `profileEffort` SHALL NOT reject the group file; each problem SHALL be a group warning naming it. A value that is not a flow map SHALL be ignored whole. An entry whose key is not a valid profile id or whose level is not one of the five SHALL be ignored alone, as SHALL a repeat of a profile already listed. An entry for a profile the group does not list SHALL be warned about and still apply to members on that profile.

#### Scenario: An unknown level is ignored alone
- **WHEN** a group sets `effort: low` and `profileEffort: { haiku: extreme, sonnet: high }`
- **THEN** a warning names `haiku` and `extreme`, `haiku` members launch with effort `low`, and `sonnet` members launch with effort `high`

#### Scenario: A list value is ignored whole
- **WHEN** a group sets `effort: low` and `profileEffort: [haiku]`
- **THEN** the group stays available, a warning names `profileEffort`, and every member launches with effort `low`

#### Scenario: An unlisted profile warns but applies
- **WHEN** a group lists `profiles: { glm-flash: 3 }` and sets `profileEffort: { haiku: xhigh }`
- **THEN** a warning says `haiku` is not one of the group's profiles, and a member the human creates on `haiku` launches with effort `xhigh`

### Requirement: Groups may name per-model effort as modelEffort
Group frontmatter SHALL accept `modelEffort` as the name of `profileEffort`, with the same values, the same resolution at each agent start, and the same warnings. When a file sets both, `modelEffort` SHALL apply and a group warning SHALL name the ignored `profileEffort`. A `modelEffort` key written `<provider>/<model>` SHALL be read as that model's profile id when the provider holds that model, and otherwise ignored with a warning naming it.

#### Scenario: The new name has the same effect
- **WHEN** the `juniors` group sets `effort: low` and `modelEffort: { haiku: xhigh }`, and members on `haiku` and on `glm-flash` start their agents
- **THEN** the `haiku` member launches with effort `xhigh` and the `glm-flash` member with `low`

#### Scenario: Both spellings are set
- **WHEN** a group sets `modelEffort: { haiku: xhigh }` and `profileEffort: { haiku: high }`
- **THEN** `haiku` members launch with effort `xhigh`, and a group warning names the ignored `profileEffort`

#### Scenario: A qualified key
- **WHEN** a group sets `modelEffort: { claude/haiku: xhigh }` and provider `claude` holds `haiku`
- **THEN** `haiku` members launch with effort `xhigh`

#### Scenario: A qualifier naming the wrong provider
- **WHEN** a group sets `modelEffort: { zai/haiku: xhigh }` and provider `zai` holds no `haiku`
- **THEN** the entry is ignored, a group warning names `zai/haiku`, and `haiku` members launch with the group's `effort`
