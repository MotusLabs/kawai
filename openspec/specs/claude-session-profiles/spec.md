# claude-session-profiles Specification

## Purpose

Let users start and resume Claude SDK chat sessions with predefined provider and model configurations, independently of other sessions on the same backend.

## Requirements

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
- **THEN** the session uses Default and retains the backend environment plus the effective global provider overrides from Settings or AGENTBOARD_CHAT_ENV

#### Scenario: Catalog loading fails
- **WHEN** the profile list cannot be loaded for the selected project path
- **THEN** the form reports the failure and does not silently replace a selected provider with Default

### Requirement: Profile identifiers are validated by the server
The system SHALL accept only profile identifiers present in the catalog resolved for the session's project path. Unknown identifiers SHALL be rejected before creating a session or starting an agent. Clients SHALL select by identifier and SHALL NOT supply arbitrary environment variables, wrapper commands, or executable paths through the profile interface.

#### Scenario: Invalid profile is refused
- **WHEN** a client requests a chat session with an identifier absent from the resolved catalog
- **THEN** an actionable error is returned and no session is created

#### Scenario: Client-supplied executable is refused
- **WHEN** a chat creation request carries an executable path or environment map in addition to a profile identifier
- **THEN** the request is rejected and no session is created

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
The SDK availability probe SHALL use the same resolved environment, startup model, profile executable, and inline controlled settings as the selected session profile. Successful and in-flight probes SHALL be shared only for equal resolved probe configurations. Failed probes SHALL be cleared so later creation attempts can retry. The probe SHALL remain a bounded SDK control-handshake check without sending a model turn.

#### Scenario: Different profiles use separate probes
- **WHEN** a successful Default probe exists and a user creates a GLM session with different resolved launch settings
- **THEN** a new probe runs with GLM's resolved settings rather than reusing the Default result

#### Scenario: Executable differences use separate probes
- **WHEN** two profiles resolve to identical environment and model configuration but name different executables
- **THEN** their probes are not shared

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
Selecting a profile SHALL preserve the chat approval flow for server-configured profiles. Profile discovery and session metadata SHALL expose identifiers and labels without credentials. An executable named by a user-level catalog entry is trusted operator configuration; its flags are the operator's responsibility and SHALL remain unreachable from the client API. Authentication checks SHALL use the effective server-side environment, accepting configured API-key or auth-token credentials or existing CLI login credentials, and SHALL refuse creation without configured authentication.

#### Scenario: Wrapper permission flag is not imported
- **WHEN** a user-level catalog entry names an executable that launches Claude with a permission-skipping flag
- **THEN** the entry applies as trusted operator configuration for that profile, while clients still cannot supply executables, flags, or environment maps through the profile interface

#### Scenario: Catalog files carry no credentials
- **WHEN** catalog files are read, committed, or mounted
- **THEN** they contain only routing, model, attribution, and compaction configuration; credentials enter sessions only through the server environment layer

#### Scenario: Gateway token authentication
- **WHEN** the backend has an ANTHROPIC_AUTH_TOKEN and a user creates a named profile session
- **THEN** creation passes the configured-authentication check without requiring an additional API key

#### Scenario: Credentials remain server-side
- **WHEN** a client requests profiles or session metadata
- **THEN** it receives no authentication secret or environment map

### Requirement: Profile catalog files are discovered and merged
The system SHALL assemble the chat profile catalog from `profiles.json` files in `.kawai` directories discovered by walking from the session's project path up to the filesystem root, layered above a user-level catalog file that replaces any image-provided default when present. For a profile identifier appearing at multiple levels, entries SHALL merge per environment key with the nearest file winning, and an empty value SHALL neutralize an inherited value for that key.

#### Scenario: Nearest file wins
- **WHEN** a project-level `.kawai/profiles.json` and the user-level catalog both define the `glm` profile with different base URLs
- **THEN** sessions created for that project path use the project-level base URL

#### Scenario: Per-key extension
- **WHEN** a project-level file defines `glm` with only a model override
- **THEN** the profile inherits the user-level routing configuration and applies the project-level model

#### Scenario: Neutralizing an inherited value
- **WHEN** a project-level file sets an inherited profile's environment key to an empty string
- **THEN** sessions for that project path launch without that variable's inherited value

#### Scenario: Mounted catalog replaces the image default
- **WHEN** the server starts where a user-level catalog file exists
- **THEN** it is used instead of any catalog built into the image

### Requirement: Catalog file failures are isolated
A malformed or unreadable catalog file SHALL produce an actionable error identifying the file, and the rest of the resolved catalog SHALL remain usable.

#### Scenario: Malformed catalog file
- **WHEN** a discovered `profiles.json` fails validation
- **THEN** profile discovery reports the file and reason, and profiles from other discovered files remain usable

### Requirement: The default profile is definable in catalog files
Catalog files SHALL be able to define the `default` profile. Its configuration SHALL layer onto the effective global provider environment the same way named profiles do, and named profile definitions SHALL be unaffected by it. The resolved catalog SHALL always include `default`: when no catalog file defines it, an implicit empty entry applies the global provider environment alone.

#### Scenario: File-defined default
- **WHEN** the user-level catalog defines `default` with a base URL and a chat session is created without a profile selection
- **THEN** the session uses the file-defined default routing while retaining credentials and unrelated variables from the global provider environment

#### Scenario: Named profiles are unaffected
- **WHEN** `default` is redefined in a catalog file and a GLM session starts
- **THEN** GLM applies its own catalog configuration

#### Scenario: Replacement catalog without a default entry
- **WHEN** a user-level catalog replaces the image default and defines only named profiles
- **THEN** an omitted profile selection still resolves to `default` using the global provider environment alone

### Requirement: Executable definitions are restricted to the user-level catalog
An executable SHALL be nameable only by a user-level catalog entry. A catalog file discovered below the user level that names an executable SHALL be rejected with an actionable error identifying the file, and profiles from other discovered files SHALL remain usable.

#### Scenario: Project-discovered executable is refused
- **WHEN** a `.kawai/profiles.json` in the session's project path names an executable
- **THEN** profile resolution reports that file and the reason, and profiles from the remaining discovered files stay available

### Requirement: Profiles may name an operator-trusted executable
A user-level catalog entry SHALL be able to name an executable launched in place of the standard Claude Code binary for that profile. The executable SHALL receive the merged base environment including credentials and any entry environment values, and the session SHALL launch without server-injected inline controlled settings so the executable's own configuration wins.

#### Scenario: Launch through an executable
- **WHEN** a session starts with a profile whose user-level entry names an executable
- **THEN** the agent process runs that executable with the profile's merged base environment and no server-injected inline controlled settings

#### Scenario: Executable configuration wins
- **WHEN** a profile entry defines environment values and its executable exports conflicting values
- **THEN** the executable's values take effect in the launched process

#### Scenario: Missing executable
- **WHEN** a profile entry names a path that does not exist or is not executable
- **THEN** session creation reports an actionable error and no agent starts
