## MODIFIED Requirements

### Requirement: Named profiles configure independent provider sessions
Each named profile SHALL apply its predefined environment configuration to its agent session without changing the backend environment or other sessions. The session's environment SHALL be the backend environment merged per variable with the effective global provider overrides (the store's launch-env entry, else the AGENTBOARD_CHAT_ENV seed value), with profile settings taking precedence over conflicting user, project, or local Claude settings for the profile-controlled variables.

#### Scenario: Effective global provider overrides
- **WHEN** the system assembles a session's environment
- **THEN** each variable takes the credential store's launch-env entry when one exists — imported once from the persisted Settings map at upgrade — otherwise its AGENTBOARD_CHAT_ENV value, merged per variable over the backend environment

#### Scenario: A seed-only sibling key survives
- **WHEN** AGENTBOARD_CHAT_ENV holds two variables and the store holds a launch-env entry for only one of them
- **THEN** the session carries the store's value for that variable and the seed's value for the other — composition is per variable, never wholesale

#### Scenario: Default and named profiles over the merged environment
- **WHEN** Default and a named profile session start from the merged environment
- **THEN** Default preserves that merged configuration, while the named profile retains credentials and unrelated variables and replaces inherited values for profile-controlled routing, model, attribution, and compaction variables

#### Scenario: GLM configuration
- **WHEN** a GLM chat session starts
- **THEN** it uses https://api.z.ai/api/anthropic, starts on Opus, maps Sonnet and Haiku to glm-5.3-flash[1m] and Opus and Fable to glm-5.3[1m], and requests a 1000000-token auto-compact window

#### Scenario: MiniMax and MiMo configuration
- **WHEN** MiniMax or MiMo sessions start
- **THEN** MiniMax uses https://api.minimax.io/anthropic starting on MiniMax-M3 with every Claude tier mapped to MiniMax-M3, and MiMo uses https://api.xiaomimimo.com/anthropic starting on mimo-v2.6-pro while mapping Sonnet to mimo-v2.6-flash and Opus, Haiku, and Fable to mimo-v2.6-pro

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
