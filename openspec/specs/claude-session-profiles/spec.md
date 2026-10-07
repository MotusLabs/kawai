# claude-session-profiles Specification

## Purpose

Let users start and resume Claude SDK chat sessions with predefined provider and model configurations, independently of other sessions on the same backend.

## Requirements

### Requirement: Users select a predefined chat profile
The system SHALL offer Default, GLM, MiniMax, MiMo, Kimi, and LAN profiles when creating a Claude chat session. The selection SHALL apply to the created session and remain visible in its chat view. Omitted selections SHALL use Default. Terminal session creation SHALL retain its existing behavior.

#### Scenario: Select a provider profile
- **WHEN** a user creates a chat session with MiMo selected
- **THEN** the session is created with MiMo as its profile and the chat view identifies it as MiMo

#### Scenario: Older client omits the profile
- **WHEN** a chat creation request omits a profile
- **THEN** the session uses Default and retains the backend environment plus the effective global provider overrides from Settings or AGENTBOARD_CHAT_ENV

#### Scenario: Catalog loading fails
- **WHEN** the profile list cannot be loaded
- **THEN** the form reports the failure and does not silently replace a selected provider with Default

### Requirement: Profile identifiers are validated by the server
The system SHALL accept only known predefined profile identifiers for chat creation. Unknown identifiers SHALL be rejected before creating a session or starting an agent. Clients SHALL select by identifier and SHALL NOT supply arbitrary environment variables or wrapper commands through the profile interface.

#### Scenario: Invalid profile is refused
- **WHEN** a client requests a chat session with an unknown profile identifier
- **THEN** an actionable error is returned and no session is created

### Requirement: Named profiles configure independent provider sessions
Each named profile SHALL apply its predefined environment configuration to its agent session without changing the backend environment or other sessions. The system SHALL first merge the backend environment with the effective global provider overrides (the persisted Settings override when present, otherwise AGENTBOARD_CHAT_ENV). Default SHALL preserve that existing configuration. Named profiles SHALL retain credentials and unrelated variables from the merged environment and SHALL replace inherited values for profile-controlled routing, model, attribution, and compaction variables. Profile settings SHALL take precedence over conflicting user, project, or local Claude settings for those variables.

#### Scenario: GLM configuration
- **WHEN** a GLM chat session starts
- **THEN** it uses https://zai.ruslan.casa/api/anthropic, maps Sonnet to glm-5.3-flash[1m] and Opus to glm-5.3[1m], starts on Sonnet, and requests a 1000000-token auto-compact window

#### Scenario: MiniMax and MiMo configuration
- **WHEN** MiniMax or MiMo sessions start
- **THEN** MiniMax uses https://api.minimax.io/anthropic with MiniMax-M3, and MiMo uses https://xiaomi.ruslan.casa/anthropic with mimo-v2.6-pro while mapping Sonnet to mimo-v2.6-flash and Opus to mimo-v2.6-pro

#### Scenario: Kimi and LAN configuration
- **WHEN** Kimi or LAN sessions start
- **THEN** Kimi uses https://kimi.ruslan.casa/ and LAN uses http://ai.lan:9292 with CLAUDE_CODE_ATTRIBUTION_HEADER=0; neither imposes a model override absent from its predefined configuration

#### Scenario: Profiles do not leak between sessions
- **WHEN** GLM and MiniMax sessions run concurrently on a backend with MiMo model and compaction variables
- **THEN** each receives its own routing and model configuration, GLM's compaction override does not enter MiniMax, and the backend environment is unchanged

#### Scenario: Conflicting Claude settings
- **WHEN** user or project settings specify a different base URL or model for a named profile session
- **THEN** the selected profile's routing and prescribed startup model apply while unrelated project settings remain available

#### Scenario: Global provider settings coexist with profiles
- **WHEN** global provider settings contain a gateway token, a base URL, and model overrides, and Default and GLM sessions start
- **THEN** Default uses the global configuration, GLM uses its catalog routing and controlled model configuration, and both retain the global token without exposing it to clients

### Requirement: Availability checks follow the selected profile
The SDK availability probe SHALL use the same resolved environment, startup model, and inline controlled settings as the selected session profile. Successful and in-flight probes SHALL be shared only for equal resolved probe configurations. Failed probes SHALL be cleared so later creation attempts can retry. The probe SHALL remain a bounded SDK control-handshake check without sending a model turn.

#### Scenario: Different profiles use separate probes
- **WHEN** a successful Default probe exists and a user creates a GLM session with different resolved launch settings
- **THEN** a new probe runs with GLM's resolved settings rather than reusing the Default result

#### Scenario: Changed settings or failed probe can recover
- **WHEN** global provider settings affecting a profile change, or its previous availability probe failed, and a user retries creation
- **THEN** the probe runs again using the current resolved configuration

### Requirement: Profile selection persists through resume
The system SHALL persist each chat session's profile identifier and reuse it after agent respawn or backend restart. Legacy sessions SHALL restore as Default. If a stored profile is no longer available, the system SHALL retain the session and report an actionable error rather than silently using another profile.

#### Scenario: Restart retains selected provider
- **WHEN** a GLM session resumes after a backend restart
- **THEN** it retains its GLM profile and resumes its stored agent conversation using GLM configuration

#### Scenario: Missing profile blocks agent launch
- **WHEN** a restored session refers to a profile absent from the catalog
- **THEN** the session remains listed with its stored profile identity and sending a message reports that the profile must be restored before resuming

### Requirement: Profiles preserve chat permissions and credential privacy
Selecting a profile SHALL preserve the chat approval flow: a profile SHALL NOT change a session's approval policy, and only the user's explicit per-session policy choice SHALL let tool uses run without approval cards. Profile discovery and session metadata SHALL expose identifiers and labels without credentials. Authentication checks SHALL use the effective server-side environment, accepting configured API-key or auth-token credentials or existing CLI login credentials, and SHALL refuse creation without configured authentication.

#### Scenario: Wrapper permission flag is not imported
- **WHEN** a named profile's source wrapper launches Claude with dangerously-skip-permissions
- **THEN** a new session with that profile starts with the manual approval policy and chat tool uses still follow the existing approval flow

#### Scenario: User-chosen auto policy applies to any profile
- **WHEN** the user switches a named profile session to the auto approval policy
- **THEN** its tool approvals are granted without cards exactly as for a Default profile session

#### Scenario: Gateway token authentication
- **WHEN** the backend has an ANTHROPIC_AUTH_TOKEN and a user creates a named profile session
- **THEN** creation passes the configured-authentication check without requiring an additional API key

#### Scenario: Credentials remain server-side
- **WHEN** a client requests profiles or session metadata
- **THEN** it receives no authentication secret or environment map
