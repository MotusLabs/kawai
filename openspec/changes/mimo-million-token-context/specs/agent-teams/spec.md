# Spec Delta

## ADDED Requirements

### Requirement: Roles can choose an auto-compaction window
Group frontmatter SHALL accept optional integer `autoCompactWindow` from 100000 through 1000000 tokens and a single-line `modelAutoCompactWindow` flow map with the same values. For supported Claude launches, a matching model entry SHALL override the role default, which SHALL override the catalog default. A selected value SHALL enable automatic compaction; its composition stays subject to the registered-name refusal. With no selected value, existing runtime behavior SHALL apply.

#### Scenario: Global MiMo preference is inherited
- **WHEN** a developer on MiMo starts with a catalog window of 300000 and no role compaction setting
- **THEN** its agent enables auto-compaction with a 300000-token window

#### Scenario: Role default overrides the catalog
- **WHEN** a developer role specifies autoCompactWindow of 250000 and MiMo's catalog specifies 300000
- **THEN** that developer's agent requests 250000 while a MiMo chat without that role requests 300000

#### Scenario: Model-specific role preference wins
- **WHEN** a developer role specifies autoCompactWindow of 250000 and modelAutoCompactWindow of `{ mimo: 300000 }`
- **THEN** its MiMo members request 300000 and its other supported Claude members request 250000

#### Scenario: Qualified model key
- **WHEN** the role specifies `{ mimo/mimo: 300000 }` and provider mimo holds model profile mimo
- **THEN** it applies to members whose profile id is mimo

#### Scenario: Human-created and spawned members
- **WHEN** both a human-created member and a staffed member start on the same role and model profile
- **THEN** both receive the same resolved compaction preference

#### Scenario: Other runtimes and executable-backed agents
- **WHEN** a role with a compaction preference has a Codex member or an executable-backed Claude member
- **THEN** that member keeps its existing runtime or executable configuration without Claude compaction settings injected by the role

#### Scenario: Preference colliding with a registered name
- **WHEN** a role preference's launch composition would carry a variable name registered for withholding
- **THEN** the launch refuses before spawn with a names-only error and no child starts

### Requirement: Invalid role compaction preferences are warned and ignored
Invalid compaction settings SHALL produce group warnings without rejecting the role. An invalid default or non-map override value SHALL be ignored whole; an invalid entry SHALL be ignored alone. A repeated written key keeps its first occurrence even when invalid; among keys resolving to one model the first valid resolved entry wins. Unknown models or incorrect qualifiers SHALL be ignored. Known models outside the role's worker list SHALL warn and still apply to human-created members.

#### Scenario: Invalid size retains valid siblings
- **WHEN** a role specifies `{ mimo: 99999, sonnet: 400000 }` with a default of 250000
- **THEN** a warning names the invalid MiMo value, MiMo uses 250000, and Sonnet uses 400000

#### Scenario: Malformed override map
- **WHEN** modelAutoCompactWindow is a list rather than a flow map
- **THEN** a warning is reported and the role's valid default still applies

#### Scenario: Duplicate keys
- **WHEN** two entries resolve to the same known model profile
- **THEN** the first entry determines its preference and the later entry produces a warning

#### Scenario: Invalid written key before a valid alias
- **WHEN** a written key's first occurrence holds an invalid value and a later distinct key resolves to the same model profile with a valid value
- **THEN** the first written occurrence is consumed despite being invalid and the first valid resolved alias supplies the preference

#### Scenario: Unknown and unlisted models
- **WHEN** an override map names an unknown model and a known model absent from the role's workers
- **THEN** the unknown entry is warned and ignored, and the known unlisted entry is warned and retained

### Requirement: Role compaction preferences apply at agent start
Role compaction preferences SHALL be read at every agent start or resume. Edits SHALL take effect at the next process start without altering a running agent. Removing an override SHALL restore the next applicable default. Read-only group metadata SHALL expose the configured role default and resolved per-model preferences alongside group warnings.

#### Scenario: Edit and removal
- **WHEN** an override changes from 300000 to 400000 while an agent runs, then is removed before a later restart
- **THEN** the running agent retains its launch value, the next start after the edit uses 400000, and a start after removal uses the role default or catalog fallback

#### Scenario: Read-only role inspection
- **WHEN** the owner inspects group metadata for a role with a default and per-model preferences
- **THEN** it includes those configured values and any validation warnings
