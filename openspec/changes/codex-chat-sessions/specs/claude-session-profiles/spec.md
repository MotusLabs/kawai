# Spec Delta

## MODIFIED Requirements

### Requirement: Users select a predefined chat profile
The system SHALL offer the profiles resolved from the catalog files for the session's project path when creating a chat session, Claude and Codex profiles alike, each identified by its provider. The selection SHALL apply to the created session and remain visible in its chat view. Omitted selections SHALL use Default. Terminal session creation SHALL retain its existing behavior.

#### Scenario: Select a provider profile
- **WHEN** a user creates a chat session with MiMo selected from the resolved catalog
- **THEN** the session is created with MiMo as its profile and the chat view identifies it as MiMo

#### Scenario: Select a Codex profile
- **WHEN** a user creates a chat session with a Codex profile selected
- **THEN** the session is created as a Codex chat and the picker and chat view identify its profile as Codex

#### Scenario: Project-level catalog extends the picker
- **WHEN** a `.kawai/profiles.json` in the session's project path (or a directory above it) defines an additional profile
- **THEN** the picker for that project path offers it alongside the inherited catalog, and project paths without that file do not

#### Scenario: Older client omits the profile
- **WHEN** a chat creation request omits a profile
- **THEN** the session uses Default and retains the backend environment plus the effective global provider overrides from Settings or AGENTBOARD_CHAT_ENV

#### Scenario: Catalog loading fails
- **WHEN** the profile list cannot be loaded for the selected project path
- **THEN** the form reports the failure and does not silently replace a selected provider with Default

## ADDED Requirements

### Requirement: Catalog entries declare their provider
A catalog entry SHALL be able to declare `provider` as `claude` or `codex`, defaulting to `claude`. Each provider SHALL accept only its own fields: Claude entries keep today's fields, and Codex entries accept a label, model, Codex home, and network setting. A field from another provider, an unknown provider, or a provider that differs from the same profile's entry at another catalog level SHALL be rejected as a catalog file failure.

#### Scenario: Codex entry
- **WHEN** the user-level catalog defines `codex` with `provider: "codex"` and a model
- **THEN** the profile resolves as a Codex profile with that model

#### Scenario: Claude field on a Codex entry
- **WHEN** a Codex entry sets an `ANTHROPIC_BASE_URL` environment value
- **THEN** that catalog file is reported with the reason and profiles from other files remain usable

#### Scenario: Conflicting provider across levels
- **WHEN** a project file defines `codex` as a Claude entry while the user-level catalog defines it as a Codex entry
- **THEN** the project file is reported and the user-level Codex entry remains usable

### Requirement: Codex homes are named only at the user level
A Codex entry SHALL use `~/.codex` (or the server's `CODEX_HOME`) as its Codex home unless a user-level catalog entry names another directory. A catalog file below the user level that names a Codex home SHALL be rejected with an actionable error identifying the file. The Codex home SHALL NOT be sent to browsers.

#### Scenario: Default home
- **WHEN** a Codex entry names no Codex home
- **THEN** its sessions use `~/.codex`, or the server's `CODEX_HOME` when set

#### Scenario: Project file names a home
- **WHEN** a `.kawai/profiles.json` in the project path names a Codex home
- **THEN** that file is reported and profiles from the remaining files stay available

### Requirement: A chat's provider is fixed at creation
The system SHALL store each chat session's provider, and for a Codex chat its resolved Codex home, when the session is created, and SHALL use them for every later start, resume, and restore. Chats created before providers existed SHALL restore as Claude. If the stored profile now resolves to a different provider or Codex home, the chat's agent SHALL NOT start, and the chat SHALL state the mismatch without naming the home.

#### Scenario: Profile edited to another provider
- **WHEN** a Claude chat's profile is redefined as a Codex profile and the user reopens the chat
- **THEN** the agent does not start and the chat states that its profile changed provider

#### Scenario: Profile edited to another Codex home
- **WHEN** a Codex chat's profile is changed at the user level to name another Codex home and the user reopens the chat
- **THEN** the agent does not start, and the chat states that its profile's Codex home changed

#### Scenario: Legacy chat
- **WHEN** a chat created before providers existed resumes
- **THEN** it runs as a Claude chat
