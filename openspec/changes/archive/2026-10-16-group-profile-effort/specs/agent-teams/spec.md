## MODIFIED Requirements

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

## ADDED Requirements

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
