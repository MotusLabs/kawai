# agent-capacity-view Specification

## Purpose
Lets agents that dispatch work, typically the lead, read their team's provider usage, cooldowns, caps and live counts, so they can choose where work runs before it hits a limit.

## Requirements

### Requirement: Agents can read their team's capacity
The `kawai-team` server SHALL offer a read-only `team_capacity` tool, allowed without approval cards under either policy and bound to the caller's team. It SHALL return, for each group of the team (or only the group named by an optional `group` argument), the group's workers in preference order, each with its provider, its cap if any, and its live member count including pending spawns.

#### Scenario: Lead reads the team's capacity
- **WHEN** an agent calls `team_capacity` with no arguments
- **THEN** the result lists every group of the caller's team with its workers, each worker's provider, cap, and live count

#### Scenario: One group
- **WHEN** an agent calls `team_capacity` with `group: "middle-devs"`
- **THEN** the result lists only that group

#### Scenario: Unknown group
- **WHEN** an agent names a group its team does not define
- **THEN** the call is refused naming the group, and nothing else is returned

### Requirement: Capacity reports provider usage and cooldown
For each provider that appears among the returned workers, `team_capacity` SHALL report the latest usage kawai holds (each window's percent used and reset time, the overall status, when it was received, and its source), and the provider's cooldown end, or none when not cooling. Usage kawai does not hold SHALL read as unknown, never as zero.

#### Scenario: Provider with a usage report
- **WHEN** kawai holds a usage report for a provider
- **THEN** the result shows each window's percent used and reset time, the report's status, received time, and source

#### Scenario: No usage after a restart
- **WHEN** kawai has received no usage for a provider since the server started
- **THEN** that provider's usage reads as unknown, and its cooldown is still reported

#### Scenario: Cooling provider
- **WHEN** a provider is cooling after a final limit event
- **THEN** the result names its cooldown end

### Requirement: Capacity flags providers that share a login
`team_capacity` SHALL mark each listed provider with the other listed providers that share its login. Two Claude profiles share a login when both use the CLI's stored login (no API key or token, no non-Anthropic base URL) and resolve the same Claude config directory. Sharing SHALL never be inferred otherwise, and unmarked SHALL read as not detected.

#### Scenario: Two Claude profiles on one claude.ai account
- **WHEN** providers `claude-default` and `claude-opus` both use the stored login in the same config directory
- **THEN** each is marked as sharing its login with the other

#### Scenario: Different config directories
- **WHEN** two stored-login Claude profiles resolve different config directories
- **THEN** neither is marked as sharing a login

#### Scenario: Unknown credentials are never assumed shared
- **WHEN** a provider's profiles authenticate with an API key or through a proxy base URL
- **THEN** that provider is not marked as sharing a login with any other

### Requirement: Capacity reads the routing state
`team_capacity` SHALL report the same usage, cooldown, cap, and live-count facts that group routing and routing rules use at the moment of the call. It SHALL fetch nothing new, and it SHALL store nothing.

#### Scenario: Matches what routing sees
- **WHEN** routing would count two live members on a worker with a cap of two
- **THEN** `team_capacity` reports that worker as 2 of 2
