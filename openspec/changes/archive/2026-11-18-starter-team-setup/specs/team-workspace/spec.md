## MODIFIED Requirements

### Requirement: Members is a read-only inspection of group settings
The Members tab SHALL list each of the team's groups with its role description, live membership, task-creation right, effective workers grouped by provider with caps and live counts, effective approval policy with its source (group file, team default, or built-in), member cap, routing strategy and limit policy, effort with any per-model effort, and routing warnings. No control SHALL edit a group. A prompt change SHALL affect future agent starts only and SHALL NOT elevate runtime permissions.

#### Scenario: Caps show live counts
- **WHEN** a group allows two members on a model and one is live
- **THEN** the row shows 1 of 2 for that model with the live member named

#### Scenario: Workers are grouped by provider
- **WHEN** the `juniors` group sets `workers: { glm-flash: 3, haiku: 2 }`, with `glm-flash` a model of provider Z.AI and `haiku` a model of provider Claude
- **THEN** the group's row shows `glm-flash` under Z.AI and `haiku` under Claude, each with its cap and live count

#### Scenario: Members cannot be edited
- **WHEN** the human opens the Members tab of a team that has project group files
- **THEN** it presents no control that writes a group file or changes a running agent's permissions

#### Scenario: A warning names what fell back
- **WHEN** a group file lists a model the catalog does not define
- **THEN** the group's row shows that warning alongside the settings that took effect

#### Scenario: Per-profile effort is shown beside the group effort
- **WHEN** a group sets `effort: low` and `modelEffort: { haiku: xhigh }`
- **THEN** the group's row shows effort `low` together with `xhigh` for the `haiku` model

#### Scenario: Approval source is shown
- **WHEN** the team has no default and a group has no `approval:` key
- **THEN** the group's row shows manual as the built-in policy

#### Scenario: An ignored auto key is a warning
- **WHEN** the team has no default and a group sets `approval: auto`
- **THEN** the group's row shows manual as the built-in policy and a warning that `approval: auto` has no effect and auto comes only from the team default

#### Scenario: A manual key is shown as the group's own policy
- **WHEN** the team default is auto and a group sets `approval: manual`
- **THEN** the group's row shows manual from the group file

#### Scenario: The only write is the setup action
- **WHEN** the human opens the Members tab of a team whose main checkout has no group files
- **THEN** its only control that writes a group file is Set up team, and no control changes a running agent's permissions

## ADDED Requirements

### Requirement: Members offers Set up team as its only group-file write
The Members tab SHALL present Set up team, as the `team-setup` capability defines it, as its only control that writes group files. It SHALL show the action above the group rows, or in place of an empty list, and SHALL disable it while disconnected. It SHALL never edit, rename, or delete an existing group file.

#### Scenario: The empty state offers setup
- **WHEN** the human opens the Members tab of a team with no group files anywhere
- **THEN** the tab shows Set up team where the group rows would be

#### Scenario: User-level groups show beneath the action
- **WHEN** the team has no project group files and `~/.kawai/groups/` defines `reviewers-sol`
- **THEN** the tab shows Set up team above the `reviewers-sol` row

#### Scenario: Setup is disabled while disconnected
- **WHEN** the Team page loses its server connection while Set up team is shown
- **THEN** the action is disabled
