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
- **WHEN** the human opens the Members tab
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

### Requirement: The Members tab sets the team's default approval policy
The Members tab SHALL show the team's default approval policy (not set, manual, or auto) and let the human set it to manual or auto. It SHALL say the default covers spawned members of groups without `approval: manual` and seeds chats the human creates, changing only later chats, and SHALL name groups whose `approval: auto` has no effect. A refused save SHALL show inline; the control SHALL be disabled while disconnected. Every open view of the team SHALL follow a save.

#### Scenario: Setting the default updates the group rows
- **WHEN** the human sets the team default to auto on the Members tab
- **THEN** every group without `approval: manual` shows auto from the team default, and groups with `approval: manual` keep manual from the group file

#### Scenario: Another open view follows the change
- **WHEN** two browser tabs show the same team's Members tab and one sets the default to auto
- **THEN** the other tab shows auto without reloading

#### Scenario: The control is disabled while disconnected
- **WHEN** the Team page loses its server connection
- **THEN** the default approval control is disabled and the last known value stays shown

#### Scenario: Groups asking for auto are named next to the control
- **WHEN** the team default is not auto and the `devs` and `reviewers` groups set `approval: auto`
- **THEN** the control names `devs` and `reviewers` as asking for auto, and says setting the team default to auto grants it

#### Scenario: The notice clears once the default is auto
- **WHEN** the human sets the team default to auto while groups set `approval: auto`
- **THEN** the control no longer names any group as asking for auto
