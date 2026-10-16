## MODIFIED Requirements

### Requirement: Users select a predefined chat profile
The system SHALL offer the profiles resolved from the catalog files for the session's project path when creating a Claude chat session. The selection SHALL apply to the created session and remain visible in its chat view. Omitted selections SHALL use Default. Terminal session creation SHALL retain its existing behavior.

#### Scenario: Select a provider profile
- **WHEN** a user creates a chat session with MiMo selected from the resolved catalog
- **THEN** the session is created with MiMo as its profile and the chat view identifies it as MiMo

#### Scenario: Project-level catalog extends the picker
- **WHEN** a `.kawai/profiles.json` in the session's project path (or a directory above it) defines an additional profile
- **THEN** the picker for that project path offers it alongside the inherited catalog, and project paths without that file do not

#### Scenario: Older client omits the profile
- **WHEN** a chat creation request omits a profile
- **THEN** the session uses Default and retains the backend environment plus the effective global provider overrides from Settings or KAWAI_CHAT_ENV

#### Scenario: Catalog loading fails
- **WHEN** the profile list cannot be loaded for the selected project path
- **THEN** the form reports the failure and does not silently replace a selected provider with Default

### Requirement: Named profiles configure independent provider sessions
Each named profile SHALL apply its predefined environment configuration to its agent session without changing the backend environment or other sessions. The session's environment SHALL be the backend environment merged with the effective global provider overrides, with profile settings taking precedence over conflicting user, project, or local Claude settings for the profile-controlled variables.

#### Scenario: Effective global provider overrides
- **WHEN** the system assembles a session's environment
- **THEN** the effective global provider overrides are the persisted Settings override when present, otherwise KAWAI_CHAT_ENV, merged over the backend environment

#### Scenario: Default and named profiles over the merged environment
- **WHEN** Default and a named profile session start from the merged environment
- **THEN** Default preserves that merged configuration, while the named profile retains credentials and unrelated variables and replaces inherited values for profile-controlled routing, model, attribution, and compaction variables

#### Scenario: GLM configuration
- **WHEN** a GLM chat session starts
- **THEN** it uses https://api.z.ai/api/anthropic, maps Sonnet to glm-5.3-flash[1m] and Opus to glm-5.3[1m], starts on Sonnet, and requests a 1000000-token auto-compact window

#### Scenario: MiniMax and MiMo configuration
- **WHEN** MiniMax or MiMo sessions start
- **THEN** MiniMax uses https://api.minimax.io/anthropic with MiniMax-M3, and MiMo uses https://api.xiaomimimo.com/anthropic with mimo-v2.6-pro while mapping Sonnet to mimo-v2.6-flash and Opus to mimo-v2.6-pro

#### Scenario: Kimi configuration
- **WHEN** a Kimi chat session starts
- **THEN** it uses https://api.moonshot.ai/anthropic and imposes no model override absent from its predefined configuration

#### Scenario: Profiles do not leak between sessions
- **WHEN** GLM and MiniMax sessions run concurrently on a backend with MiMo model and compaction variables
- **THEN** each receives its own routing and model configuration, GLM's compaction override does not enter MiniMax, and the backend environment is unchanged

#### Scenario: Conflicting Claude settings
- **WHEN** user or project settings specify a different base URL or model for a named profile session
- **THEN** the selected profile's routing and prescribed startup model apply while unrelated project settings remain available

#### Scenario: Global provider settings coexist with profiles
- **WHEN** global provider settings contain a gateway token, a base URL, and model overrides, and Default and GLM sessions start
- **THEN** Default uses the global configuration, GLM uses its catalog routing and controlled model configuration, and both retain the global token without exposing it to clients
