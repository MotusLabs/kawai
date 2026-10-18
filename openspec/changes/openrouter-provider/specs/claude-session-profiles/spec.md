## MODIFIED Requirements

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
- **THEN** they contain only routing, model, attribution, compaction, and output-reservation configuration and, for trusted providers, the names of server environment variables holding credentials; credential values enter sessions only through the server environment layer

#### Scenario: Gateway token authentication
- **WHEN** the backend has an ANTHROPIC_AUTH_TOKEN and a user creates a named profile session
- **THEN** creation passes the configured-authentication check without requiring an additional API key

#### Scenario: Credentials remain server-side
- **WHEN** a client requests profiles or session metadata
- **THEN** it receives no authentication secret, environment map, or credential variable value

## ADDED Requirements

### Requirement: Trusted providers may name their credential variables
A provider defined in the shipped default or the user-level `providers.json` SHALL be able to name a server environment variable holding its auth token (`authTokenEnv`) and one holding a balance-reading key (`balanceKeyEnv`). A name SHALL be an environment-variable identifier. A project-level file, or any `profiles.json`, that sets either field SHALL be rejected with an actionable error naming the file, while the rest of the catalog still resolves.

#### Scenario: User-level provider names its token variable
- **WHEN** `~/.kawai/providers.json` defines provider `or2` with `"authTokenEnv": "OR2_KEY"` and the server environment holds `OR2_KEY`
- **THEN** sessions on `or2`'s models authenticate with that value

#### Scenario: Project file names a credential variable
- **WHEN** a project's `.kawai/providers.json` sets `authTokenEnv` on any provider
- **THEN** that file is rejected with an error naming it and the field, and providers from other files remain usable

#### Scenario: Malformed variable name
- **WHEN** a user-level provider sets `"authTokenEnv": "my key"`
- **THEN** the file is rejected with an error naming the provider and the field

### Requirement: A credentialed provider's route comes only from trusted catalogs
When a provider has a credential variable from a trusted catalog, a project-level file SHALL NOT set that provider's base URL. Such a file SHALL be rejected with an actionable error naming the provider, and the rest of the catalog SHALL still resolve. Model mappings and labels of the provider SHALL stay overlayable.

#### Scenario: Project overlay redirects the credentialed provider
- **WHEN** a project's `.kawai/providers.json` sets `ANTHROPIC_BASE_URL` for the shipped `openrouter` provider
- **THEN** that file is rejected naming `openrouter`, and `openrouter` sessions still use `https://openrouter.ai/api`

#### Scenario: Project overlay changes a model mapping
- **WHEN** a project's `.kawai/providers.json` sets `ANTHROPIC_DEFAULT_SONNET_MODEL` for `openrouter`
- **THEN** the overlay applies to that project's `openrouter` sessions

### Requirement: Named credential variables are withheld from every agent
Every chat agent launch, on every profile and including executable-backed and default launches, SHALL receive an environment without any variable that the resolved catalog names as a credential variable. A session of a provider with `authTokenEnv` SHALL instead receive that variable's value as `ANTHROPIC_AUTH_TOKEN`, with `ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN` set empty in the environment and in the flag settings layer. No agent SHALL receive a `balanceKeyEnv` value.

#### Scenario: Another profile's session
- **WHEN** the server environment holds `OPENROUTER_API_KEY` and a GLM session starts
- **THEN** neither the GLM agent nor its tool subprocesses can read `OPENROUTER_API_KEY`

#### Scenario: Default launch without overrides
- **WHEN** a Default session starts on a server whose environment holds `OPENROUTER_MANAGEMENT_KEY`
- **THEN** the agent's environment does not contain `OPENROUTER_MANAGEMENT_KEY`

#### Scenario: Credentialed provider session
- **WHEN** an `openrouter-sonnet` session starts with `OPENROUTER_API_KEY` set and a server `ANTHROPIC_API_KEY` present
- **THEN** the agent sends the OpenRouter key as its bearer token, its `ANTHROPIC_API_KEY` is empty, and neither the OpenRouter key variable nor the management key variable appears under its own name

#### Scenario: Project settings cannot restore an API key
- **WHEN** the project's Claude settings set `ANTHROPIC_API_KEY` and an `openrouter` session starts
- **THEN** the agent's effective `ANTHROPIC_API_KEY` is empty

### Requirement: A credentialed provider authenticates only with its own variable
For a session whose provider names `authTokenEnv`, creation and agent start SHALL require that variable to be non-empty in the effective server environment, and SHALL NOT accept host CLI login credentials or other configured credentials in its place. The refusal SHALL name the provider and the variable. Such sessions SHALL show no host-login expiry notice.

#### Scenario: Key variable missing
- **WHEN** a user creates an `openrouter-opus` session and `OPENROUTER_API_KEY` is unset, while a host claude.ai login exists
- **THEN** creation is refused with a message naming OpenRouter and `OPENROUTER_API_KEY`, and no agent starts

#### Scenario: No login-expiry notice
- **WHEN** an `openrouter` session is attached while the host claude.ai refresh token expires within 3 days
- **THEN** that session's notification strip shows no login-expiry notice

### Requirement: Catalogs may cap the output reservation
Catalog `env` SHALL accept `CLAUDE_CODE_MAX_OUTPUT_TOKENS` as a profile-controlled variable, set and neutralized like the other controlled variables, so a prepaid provider's sessions can request a smaller per-request output reservation.

#### Scenario: Provider caps output tokens
- **WHEN** a user-level provider sets `"CLAUDE_CODE_MAX_OUTPUT_TOKENS": "8000"` in its `env`
- **THEN** its sessions start with that value, and an inherited project setting for it does not override it

#### Scenario: Unset cap is neutralized
- **WHEN** a named profile's provider does not set `CLAUDE_CODE_MAX_OUTPUT_TOKENS` and the server environment does
- **THEN** that profile's sessions start without the inherited value

### Requirement: The shipped catalog includes OpenRouter
The shipped default SHALL define provider `openrouter`, labelled OpenRouter, with base URL `https://openrouter.ai/api`, `authTokenEnv` `OPENROUTER_API_KEY`, and `balanceKeyEnv` `OPENROUTER_MANAGEMENT_KEY`. It SHALL hold `openrouter-opus`, `openrouter-sonnet`, and `openrouter-haiku`, starting on Opus, Sonnet, and Haiku. Opus and Fable SHALL map to `~anthropic/claude-opus-latest[1m]`, Sonnet to `~anthropic/claude-sonnet-latest[1m]`, and Haiku to `~anthropic/claude-haiku-latest`.

#### Scenario: OpenRouter configuration
- **WHEN** an `openrouter-sonnet` session starts with its key set
- **THEN** it uses `https://openrouter.ai/api`, starts on Sonnet mapped to `~anthropic/claude-sonnet-latest[1m]`, and maps the other tiers as listed

#### Scenario: Listed in the picker
- **WHEN** a user opens New Session on a server with no user-level provider overrides
- **THEN** the three OpenRouter models are offered grouped under OpenRouter
