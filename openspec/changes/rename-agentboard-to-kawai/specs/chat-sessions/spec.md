## MODIFIED Requirements

### Requirement: Operators configure the chat provider from Settings
The system SHALL seed the provider environment from the `KAWAI_CHAT_ENV`
server variable and SHALL let the user override it from the Settings modal.
A Settings override SHALL persist across server restarts and SHALL apply to
the next SDK process spawned, without a server restart. Clearing the override
SHALL restore the server-variable default.

#### Scenario: Settings override applies to the next spawn
- **WHEN** the user saves provider overrides in Settings and then starts a new chat session
- **THEN** the new session's SDK process receives the saved overrides

#### Scenario: Clearing the override restores the default
- **WHEN** the user clears the provider overrides in Settings
- **THEN** the persisted override is removed and the provider environment falls back to `KAWAI_CHAT_ENV`
