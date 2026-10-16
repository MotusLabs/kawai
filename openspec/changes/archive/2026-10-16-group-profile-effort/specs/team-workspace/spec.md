## MODIFIED Requirements

### Requirement: Members is a read-only inspection of group settings
The Members tab SHALL list each of the team's groups with its role description, live membership, task-creation right, effective profiles with caps and live counts, effective approval policy, member cap, routing strategy and limit policy, effort with any per-profile effort, and routing warnings. No control SHALL edit a group. A prompt change SHALL affect future agent starts only and SHALL NOT elevate runtime permissions.
#### Scenario: Caps show live counts
- **WHEN** a group allows two members on a profile and one is live
- **THEN** the row shows 1 of 2 for that profile with the live member named

#### Scenario: Members cannot be edited
- **WHEN** the human opens the Members tab
- **THEN** it presents no control that writes a group file or changes a running agent's permissions

#### Scenario: A warning names what fell back
- **WHEN** a group file lists a profile the catalog does not define
- **THEN** the group's row shows that warning alongside the settings that took effect

#### Scenario: Per-profile effort is shown beside the group effort
- **WHEN** a group sets `effort: low` and `profileEffort: { haiku: xhigh }`
- **THEN** the group's row shows effort `low` together with `xhigh` for the `haiku` profile
