# Spec Delta

## MODIFIED Requirements

### Requirement: Named profiles configure independent provider sessions
Each named profile SHALL apply its predefined environment configuration to its agent session without changing the backend environment or other sessions. The session's environment SHALL be the backend environment merged with the effective global provider overrides, with profile settings taking precedence over conflicting user, project, or local Claude settings for the profile-controlled variables.

#### Scenario: Effective global provider overrides
- **WHEN** the system assembles a session's environment
- **THEN** the effective global provider overrides are the persisted Settings override when present, otherwise AGENTBOARD_CHAT_ENV, merged over the backend environment

#### Scenario: Default and named profiles over the merged environment
- **WHEN** Default and a named profile session start from the merged environment
- **THEN** Default preserves that merged configuration, while the named profile retains credentials and unrelated variables and replaces inherited values for profile-controlled routing, model, attribution, and compaction variables

#### Scenario: GLM configuration
- **WHEN** a GLM chat session starts
- **THEN** it uses https://api.z.ai/api/anthropic, starts on Opus, maps Sonnet and Haiku to glm-5.3-flash[1m] and Opus and Fable to glm-5.3[1m], and requests a 1000000-token auto-compact window

#### Scenario: MiniMax and MiMo configuration
- **WHEN** MiniMax or MiMo sessions start
- **THEN** MiniMax uses https://api.minimax.io/anthropic starting on MiniMax-M3 with every Claude tier mapped to MiniMax-M3, and MiMo uses https://api.xiaomimimo.com/anthropic starting on mimo-v2.6-pro[1m] while mapping Sonnet to mimo-v2.6-flash[1m] and Opus, Haiku, and Fable to mimo-v2.6-pro[1m], declaring 1M capacity and enabling auto-compaction with a 300000-token window unless a role overrides that preference

#### Scenario: Kimi configuration
- **WHEN** a Kimi chat session starts
- **THEN** it uses https://api.moonshot.ai/anthropic starting on kimi-k3[1m] with every Claude tier mapped to kimi-k3[1m] and a 1000000-token auto-compact window

#### Scenario: Profiles do not leak between sessions
- **WHEN** GLM and MiniMax sessions run concurrently on a backend with MiMo model and compaction variables
- **THEN** each receives its own routing and model configuration, GLM's compaction override does not enter MiniMax, and the backend environment is unchanged

#### Scenario: Conflicting Claude settings
- **WHEN** user or project settings specify a different base URL or model for a named profile session
- **THEN** the selected profile's routing and prescribed startup model apply while unrelated project settings remain available

#### Scenario: Global provider settings coexist with profiles
- **WHEN** global provider settings contain a gateway token, a base URL, and model overrides, and Default and GLM sessions start
- **THEN** Default uses the global configuration, GLM uses its catalog routing and controlled model configuration, and both retain the global token without exposing it to clients

## ADDED Requirements

### Requirement: Claude catalog entries can specify an auto-compaction window
Claude profiles, providers, and provider models SHALL accept optional integer `autoCompactWindow` values from 100000 through 1000000 tokens. A configured value SHALL enable automatic compaction and set its window independently of model capacity. A model value SHALL override its provider value, and nearer catalog values SHALL override farther values at the same scope. Existing role overrides SHALL take precedence at agent start.

#### Scenario: MiMo global default
- **WHEN** a MiMo chat starts with the shipped catalog and no role override
- **THEN** automatic compaction is enabled with a 300000-token window while the model capacity is declared as 1M

#### Scenario: A model overrides the provider default
- **WHEN** a provider specifies 400000 and one of its models specifies 300000
- **THEN** that model requests a 300000-token window and models with no own value inherit 400000

#### Scenario: Invalid catalog size
- **WHEN** a catalog entry supplies a string, fractional number, boolean, or number outside the supported range for autoCompactWindow
- **THEN** its file is rejected with an actionable error and other catalog files remain usable

#### Scenario: Configuration absent
- **WHEN** neither the resolved catalog nor the role specifies autoCompactWindow
- **THEN** existing legacy environment and runtime compaction behavior apply

#### Scenario: Runtime and executable boundaries
- **WHEN** a Codex catalog entry or an executable-backed Claude entry specifies autoCompactWindow
- **THEN** its file is rejected with an actionable incompatibility error

#### Scenario: Replacement catalog
- **WHEN** a user-level catalog defines MiMo without autoCompactWindow and replaces the shipped catalog
- **THEN** the shipped 300000-token preference is not injected into that operator definition
