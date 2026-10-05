# Spec Delta

## ADDED Requirements

### Requirement: Chat sessions run against a configurable provider
The system SHALL let an operator define a provider environment — a set of
environment-variable overrides such as an API base URL and model names — that
is applied to every Claude Agent SDK process spawned for chat sessions,
including the availability probe. The provider environment SHALL apply only to
chat sessions and SHALL NOT change the environment of terminal (tmux) sessions.
When no provider environment is configured, the SDK process SHALL inherit the
server environment unchanged. The chat authentication check SHALL evaluate
credentials against the same effective environment the SDK process receives.

#### Scenario: Provider overrides reach the SDK process
- **WHEN** the operator configures a provider environment containing a base URL and model overrides and a user sends a message in a chat session
- **THEN** the SDK process for that session runs with the server environment plus those overrides, with the overrides taking precedence

#### Scenario: Nothing configured
- **WHEN** no provider environment is configured
- **THEN** chat sessions spawn the SDK process with the server environment exactly as before

#### Scenario: Terminal sessions are unaffected
- **WHEN** a provider environment is configured and the user starts a terminal session
- **THEN** the terminal session's environment does not contain the provider overrides

#### Scenario: Availability is re-checked for a changed or failed provider
- **WHEN** the SDK availability check failed, or the provider environment changed since it last succeeded, and the user creates a chat session
- **THEN** the availability check runs again under the current provider environment instead of reusing the earlier result

#### Scenario: Credential supplied through the provider environment
- **WHEN** the server environment has no Claude credentials and the provider environment supplies an API key or auth token
- **THEN** chat session creation is allowed

### Requirement: Operators configure the chat provider from Settings
The system SHALL seed the provider environment from the `AGENTBOARD_CHAT_ENV`
server variable and SHALL let the user override it from the Settings modal.
A Settings override SHALL be persisted across server restarts and SHALL apply
to the next SDK process spawned, without a server restart. Clearing the
override SHALL restore the server-variable default. Invalid entries SHALL be
refused with an error rather than silently dropped. Values of credential-like
variables SHALL NOT be sent to the browser; saving without re-entering such a
value SHALL keep the stored value.

#### Scenario: Settings override applies to the next spawn
- **WHEN** the user saves provider overrides in Settings and then starts a new chat session
- **THEN** the new session's SDK process receives the saved overrides

#### Scenario: Clearing the override restores the default
- **WHEN** the user clears the provider overrides in Settings
- **THEN** the persisted override is removed and the provider environment falls back to `AGENTBOARD_CHAT_ENV`

#### Scenario: Invalid entry refused
- **WHEN** the user saves an entry whose name is not a valid environment variable name
- **THEN** nothing is saved and Settings shows why

#### Scenario: Credentials are not sent to the browser
- **WHEN** the provider environment contains a credential such as `ANTHROPIC_AUTH_TOKEN` and the user opens Settings
- **THEN** the variable is listed without its value, and saving other edits keeps the stored credential
