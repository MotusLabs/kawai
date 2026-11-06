## ADDED Requirements

### Requirement: A member is spawned into an unstaffed worktree
When a worktree task message has no idle member in its worktree and spawning is allowed, the system SHALL create a new chat session of that group in the worktree and deliver the message as its first turn. The new session SHALL use the group's `profile` (else the default profile), SHALL be associated with the task, and SHALL start on the approval policy its group and team resolve to.

#### Scenario: Spawn for an unstaffed worktree
- **WHEN** a team lead sends a task message to `devs` for worktree `feat-x` and no `devs` member runs there
- **THEN** a new `devs` chat session is created in `feat-x` and receives the message as its first turn

#### Scenario: The group's profile is applied
- **WHEN** the `devs` group sets `profile: glm`
- **THEN** the spawned session uses the `glm` profile

### Requirement: A group's approval key can only tighten its spawned members' policy
A spawned member's approval policy SHALL be manual when its group sets `approval: manual`, else the team default, else manual. A group's `approval: auto` SHALL NOT grant auto: it parses, has no effect, and is reported as a group warning. The policy SHALL be resolved on the server at spawn time without any browser connection.

#### Scenario: Team default applies to a group without the key
- **WHEN** the team default is auto and the `devs` group has no `approval:` key
- **THEN** the spawned `devs` session starts on auto

#### Scenario: A manual key beats an auto default
- **WHEN** the team default is auto and the `devs` group sets `approval: manual`
- **THEN** the spawned `devs` session starts on manual

#### Scenario: Group auto does not beat a manual default
- **WHEN** the team default is manual and the `devs` group sets `approval: auto`
- **THEN** the spawned `devs` session starts on manual

#### Scenario: Group auto with no team default keeps manual
- **WHEN** the team has no default and the `devs` group sets `approval: auto`
- **THEN** the spawned `devs` session starts on manual and the `devs` group reports that `approval: auto` has no effect

#### Scenario: Group auto with an auto default spawns auto
- **WHEN** the team default is auto and the `devs` group sets `approval: auto`
- **THEN** the spawned `devs` session starts on auto, from the team default

#### Scenario: No key and no default keeps manual
- **WHEN** the team has no default and the `devs` group has no `approval:` key
- **THEN** the spawned `devs` session starts on manual

#### Scenario: Auto from the team default needs no browser
- **WHEN** the team default is auto, no browser is connected to Kawai, and a message spawns a `devs` member whose group has no `approval:` key
- **THEN** the member starts on auto and its tool approvals are granted without cards while no browser is connected

## MODIFIED Requirements

### Requirement: A team has a default approval policy for spawned members
Each team SHALL have an optional default approval policy, manual or auto, stored on the server and unset until the human sets it. It is the only source of auto for spawned members and seeds chats the human creates in the team. Only the human's Team page action SHALL set it; no agent tool, group file, or browser-stored value SHALL set or migrate it. Setting it SHALL change only later chats. One team's default SHALL NOT affect another team.

#### Scenario: A new install has no team default
- **WHEN** a team's default has never been set
- **THEN** the team has no default, whatever any browser stored for an earlier Settings approval policy

#### Scenario: The default does not change existing chats
- **WHEN** a team has a spawned member on manual and the human sets the team default to auto
- **THEN** that member stays manual, and the next member spawned for a group without `approval: manual` starts on auto

#### Scenario: Defaults are per team
- **WHEN** team A's default is auto and team B has none
- **THEN** a member spawned for team B starts on manual, whatever its group's `approval:` key says

#### Scenario: Agents cannot set the default
- **WHEN** an agent lists its `kawai-team` tools
- **THEN** no tool sets or clears a team's default approval policy

#### Scenario: A group file cannot raise the default
- **WHEN** an agent commits `approval: auto` to a group file and the team has no default
- **THEN** the team still has no default, and the group's next spawned member starts on manual

## REMOVED Requirements

### Requirement: A member is spawned when none is available
**Reason**: It let a group's `approval: auto` outrank the human-only team default ("Explicit auto beats a manual default"), so a repository file agents can edit granted more than the human chose.
**Migration**: Spawning is now "A member is spawned into an unstaffed worktree", and policy resolution is "A group's approval key can only tighten its spawned members' policy". To keep auto for groups that set `approval: auto`, set the team default to auto on the Team page.
