## ADDED Requirements

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
Each `profiles.json` entry SHALL read as a provider with the entry's id holding one model of the same key, its label naming both. A catalog without `providers.json` SHALL resolve as before. An entry whose id is a model of another operator provider SHALL be ignored with an error naming both files. An entry naming a provider only the shipped files define SHALL become its own one-model provider under a reserved `profile:<id>` id, leaving the shipped provider unchanged.

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

### Requirement: The implicit default is a model of its own provider
When no catalog file defines the `default` model, the implicit `default` SHALL be a model of provider `default`, holding no other model unless a file adds one there. A `providers.json` SHALL be able to define `default` under any provider, such as one holding the host login's other models.

#### Scenario: Implicit default stands alone
- **WHEN** no catalog file defines `default`
- **THEN** `default` is the only model of provider `default` and launches with the global provider environment alone

#### Scenario: Default joins the host-login provider
- **WHEN** a `providers.json` defines provider `claude` with no base URL holding `default`, `opus`, and `sonnet`
- **THEN** sessions created without a selection run on `default` of `claude`

## MODIFIED Requirements

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
