## ADDED Requirements

### Requirement: Groups may set a reasoning effort
Group frontmatter SHALL accept an optional `effort` of `low`, `medium`, `high`, `xhigh`, or `max`. When a member's agent process starts, the system SHALL launch it with its group's effort as read from the group file at that start. A member of a group without `effort`, or a session without a group, SHALL launch with no effort from kawai, leaving Claude Code's own settings in force.

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
