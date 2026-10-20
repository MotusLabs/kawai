# claude-session-profiles Specification

## Purpose

Let users start and resume Claude SDK chat sessions with predefined provider and model configurations, independently of other sessions on the same backend.

## Requirements

### Requirement: Users select a predefined chat profile
The system SHALL offer the models resolved from the catalog files for the session's project path, grouped under their providers, when creating a Claude chat session. The selection SHALL apply to the created session, and its chat view SHALL identify the session's provider and model. Omitted selections SHALL use Default. Terminal session creation SHALL retain its existing behavior.

#### Scenario: Select a provider profile
- **WHEN** a user creates a chat session with MiMo selected from the resolved catalog
- **THEN** the session is created with MiMo as its profile and the chat view identifies it as MiMo

#### Scenario: Models are grouped by provider
- **WHEN** the resolved catalog's provider Z.AI holds models GLM and GLM Flash
- **THEN** the picker lists both under Z.AI, and a session created on GLM Flash is identified by Z.AI and GLM Flash

#### Scenario: Project-level catalog extends the picker
- **WHEN** a `.kawai/profiles.json` or `.kawai/providers.json` in the session's project path (or a directory above it) defines an additional model
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

### Requirement: Profiles contribute no approval behavior at creation
Creating a chat session with a named profile SHALL apply the user's
creation-time approval policy unchanged. A profile SHALL NOT add to, override,
or neutralize that policy, and a profile that names a permission-skipping
executable SHALL NOT cause a session to start with the auto policy.

#### Scenario: Named profile keeps the creation policy
- **WHEN** a user creates a chat session with a named profile and a creation-time approval policy
- **THEN** the session starts with exactly that policy and the profile contributes no approval behavior

#### Scenario: Default profile and named profiles behave the same
- **WHEN** a user creates one chat session with the Default profile and another with a named profile, both with the auto policy
- **THEN** both sessions start with the auto policy and grant tool uses without cards

### Requirement: Profiles preserve chat permissions and credential privacy
Selecting a profile SHALL preserve the chat approval flow for server-configured profiles: a profile SHALL NOT change a session's approval policy, and only a user-chosen approval policy SHALL let tool uses run without approval cards. Profile discovery and session metadata SHALL expose identifiers and labels without credentials. An executable named by a user-level catalog entry is trusted operator configuration whose flags SHALL remain unreachable from the client API.

#### Scenario: User-chosen policy sources
- **WHEN** a user-chosen approval policy applies to a session
- **THEN** the policy is a settings default, a creation-time value, or a later per-session switch

#### Scenario: Authentication without configured credentials
- **WHEN** authentication is checked against the effective server-side environment
- **THEN** configured API-key or auth-token credentials or existing CLI login credentials are accepted, and creation is refused without configured authentication

#### Scenario: Wrapper permission flag is not imported
- **WHEN** a user-level catalog entry names an executable that launches Claude with a permission-skipping flag
- **THEN** the entry does not set the session's approval policy, the entry applies as trusted operator configuration for that profile, and clients still cannot supply executables, flags, or environment maps through the profile interface

#### Scenario: User-chosen auto policy applies to any profile
- **WHEN** the user switches a named profile session to the auto approval policy
- **THEN** its tool approvals are granted without cards exactly as for a Default profile session

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
The system SHALL assemble the chat catalog from `providers.json` and `profiles.json` files in `.kawai` directories found by walking from the session's project path up to the filesystem root, layered above the user-level catalog files, which replace any image-provided default when either exists. For a provider id or model key appearing at multiple levels, entries SHALL merge per environment key with the nearest file winning, and an empty value SHALL neutralize an inherited value for that key.

#### Scenario: Nearest file wins
- **WHEN** a project-level `.kawai/profiles.json` and the user-level catalog both define the `glm` profile with different base URLs
- **THEN** sessions created for that project path use the project-level base URL

#### Scenario: Per-key extension
- **WHEN** a project-level file defines `glm` with only a model override
- **THEN** the profile inherits the user-level routing configuration and applies the project-level model

#### Scenario: Neutralizing an inherited value
- **WHEN** a project-level file sets an inherited profile's environment key to an empty string
- **THEN** sessions for that project path launch without that variable's inherited value

#### Scenario: Provider overlay
- **WHEN** the user-level `providers.json` defines provider `zai` and a project-level `providers.json` sets only a different base URL for `zai`
- **THEN** that project path's sessions on every model of `zai` use the project-level base URL

#### Scenario: Overlay of a shipped provider's base URL
- **WHEN** no user-level catalog file exists and a project-level `providers.json` sets a different base URL for the shipped provider `zai`
- **THEN** that project path's sessions on every model of `zai` use the project-level base URL, and `zai` keeps the tier its shipped file gave it

#### Scenario: Mounted catalog replaces the image default
- **WHEN** the server starts where a user-level `providers.json` or `profiles.json` exists
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

### Requirement: Providers group the models of one account
The catalog SHALL accept `providers.json` files at every level that accepts `profiles.json`. Each entry SHALL be a provider with an id, a label, routing environment, a reset time zone, an operator-trusted executable where executables are allowed, and a map of models, each with a key, a label, an optional startup model, and optional environment. A model SHALL launch with its provider's environment merged with its own, its own values winning per key.

#### Scenario: Two models share a provider
- **WHEN** `providers.json` defines provider `zai` with base URL `https://zai.example.internal/api/anthropic`, Opus and Sonnet slot models, and models `glm` starting on `opus` and `glm-flash` starting on `sonnet`
- **THEN** sessions on `glm` and on `glm-flash` both use that base URL and the provider's slot models, and each starts on its own model

#### Scenario: A model setting overrides its provider's
- **WHEN** provider `zai` sets a 200000-token auto-compact window and its model `glm` sets 1000000
- **THEN** `glm` sessions request 1000000 and `glm-flash` sessions request 200000

#### Scenario: Labels default to ids
- **WHEN** a provider or model entry has no label
- **THEN** the picker and chat view show its id

### Requirement: The base URL belongs to the provider
A model entry SHALL NOT set the routing base URL, so that every model of a provider reaches the same endpoint. A `providers.json` whose model sets it SHALL fail validation with an error naming the file, provider, and model, and the rest of the catalog SHALL stay usable.

#### Scenario: Model-level base URL is refused
- **WHEN** a `providers.json` gives model `glm` of provider `zai` its own `ANTHROPIC_BASE_URL`
- **THEN** catalog resolution reports the file, `zai`, and `glm`, and providers from the other discovered files stay available

### Requirement: Model keys are unique and serve as profile ids
Every model key SHALL be unique across the providers of a resolved catalog and SHALL be the profile id that sessions, group files, plans, and routing name, so stored profile ids keep resolving to the model of the same key. A key defined under two providers SHALL be a catalog error naming both providers and their files: within one file the file fails validation, and across operator levels the nearer definition is ignored.

#### Scenario: A stored session keeps its model
- **WHEN** a session created on profile `glm` resumes after `glm` became a model of provider `zai`
- **THEN** it resumes on model `glm` of `zai` with its stored profile id unchanged

#### Scenario: Nearer duplicate is ignored
- **WHEN** the user-level `providers.json` defines `glm` under `zai` and a project-level `providers.json` defines `glm` under `zai2`
- **THEN** the error names both providers and files, and sessions for that project path use `glm` of `zai`

#### Scenario: Duplicate within one file
- **WHEN** one `providers.json` defines model `glm` under two providers
- **THEN** that file fails validation naming `glm` and both providers, and the other discovered files stay usable

### Requirement: Profile entries read as one-model providers
Each `profiles.json` entry SHALL read as a provider with the entry's id holding one model of the same key, its label naming both. A catalog without `providers.json` SHALL resolve as before. An entry whose id is a model of another operator provider SHALL be ignored with an error naming both files. An entry naming a provider a shipped file introduced, overlaid or not, SHALL become its own one-model provider under a reserved `profile:<id>` id, leaving the shipped provider unchanged.

#### Scenario: Profiles-only catalog is unchanged
- **WHEN** only `profiles.json` files exist
- **THEN** the picker offers the same profiles, each session launches with the same settings as before, and each profile is a provider of its own

#### Scenario: Entry names a model of another provider
- **WHEN** the user-level `providers.json` defines `glm` under `zai` and a project's `.kawai/profiles.json` defines `glm`
- **THEN** the project entry is ignored, the error names both files, and `glm` keeps the configuration of `zai`

#### Scenario: Entry names a shipped provider
- **WHEN** no user-level file exists and a project's `.kawai/profiles.json` defines `claude`
- **THEN** `claude` resolves to the project entry as its own provider, and the shipped `claude` provider keeps its models and settings unchanged

### Requirement: A nearer definition re-homes a shipped model key
When a project-level catalog file defines a model key that the shipped default holds, that key SHALL leave its shipped provider and resolve as the nearer definition's own entry, starting from the shipped model's resolved settings with the nearer definition overlaid, so an existing override keeps its launch settings. A shipped key no nearer file defines SHALL keep its shipped provider. Duplicates between operator levels SHALL keep the farther definition.

#### Scenario: A project override keeps its settings
- **WHEN** the shipped default holds `glm` under `zai` and a project's `.kawai/profiles.json` defines `glm` with its own base URL
- **THEN** `glm` resolves to the project definition overlaid on the shipped settings as its own provider, and `zai`'s other models keep the shipped base URL

#### Scenario: A shipped key with no override stays
- **WHEN** the shipped default holds `glm` and `glm-flash` under `zai` and no project file defines either
- **THEN** both resolve under `zai` with the shipped settings

### Requirement: Provider tiers and merge order
The catalog file that introduces a provider SHALL fix its tier — shipped or operator — for its life. Each `providers.json` SHALL apply in two passes: first every provider's facts, then every model key, so the file's key order never changes the outcome. An overlay SHALL reach every key of either tier the provider holds, and a key re-homed in the second pass SHALL keep its label.

#### Scenario: Key order never changes the outcome
- **WHEN** one `providers.json` overlays `zai`'s base URL and moves `glm` to a new provider `zai2`, written in either JSON key order
- **THEN** both resolve identically, with `glm` under `zai2` carrying the overlay base URL

#### Scenario: A legacy entry naming an overlaid shipped provider
- **WHEN** a project's `providers.json` overlays the shipped provider `zai`'s base URL and its `profiles.json` names `zai`
- **THEN** the entry becomes `profile:zai` holding only the entry's settings, and `zai`'s models keep the overlaid base URL

### Requirement: The implicit default is a model of its own provider
When no catalog file defines the `default` model, the implicit `default` SHALL be a model of provider `default`, holding no other model unless a file adds one there. A `providers.json` SHALL be able to define `default` under any provider, such as one holding the host login's other models.

#### Scenario: Implicit default stands alone
- **WHEN** no catalog file defines `default`
- **THEN** `default` is the only model of provider `default` and launches with the global provider environment alone

#### Scenario: Default joins the host-login provider
- **WHEN** a `providers.json` defines provider `claude` with no base URL holding `default`, `opus`, and `sonnet`
- **THEN** sessions created without a selection run on `default` of `claude`
