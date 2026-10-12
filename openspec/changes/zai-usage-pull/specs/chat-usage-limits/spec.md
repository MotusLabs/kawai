# Spec Delta

## ADDED Requirements

### Requirement: Provider plan usage is pulled from the provider quota endpoint
When a chat session's profile routes model traffic through a base URL that serves the provider's coding-plan quota endpoint, the server SHALL obtain the profile's plan usage directly from that endpoint, using the credentials sessions of that profile already use, without waiting for a turn. Only a response matching the endpoint's usage shape SHALL be accepted; anything else SHALL record no usage data. Usage obtained this way SHALL be marked with its own usage source.

#### Scenario: API-key gateway profile shows provider usage
- **WHEN** a session's profile routes through a base URL that serves the quota endpoint and authenticates with an API key with no host login
- **THEN** the usage bar shows the provider's plan windows once the session's agent has started

#### Scenario: Non-matching response records no data
- **WHEN** the quota endpoint answers with an auth refusal, an error, or a body without the usage shape
- **THEN** the profile records no window data, shows no usage bar, and the chat session is undisturbed

#### Scenario: Provider report is marked
- **WHEN** plan usage is obtained from the quota endpoint
- **THEN** the report carries a usage source distinct from pushed, reported, and SDK-pulled reports

#### Scenario: Default route is never probed
- **WHEN** a session's profile has no provider base URL
- **THEN** no quota request is ever made for that profile

### Requirement: Provider usage windows keep the provider's own identity
Each usable row of a provider quota response SHALL render as its own usage-bar meter, labelled by the row's own kind so provider windows remain distinguishable from Claude plan windows, with the row's reset time shown in the user's local time. A row whose percentage cannot be used SHALL be dropped rather than rendered wrong; the remaining rows SHALL still render.

#### Scenario: Two provider rows
- **WHEN** a quota response carries a prompt row at 2% and a token row at 30%, each with a reset time
- **THEN** the usage bar shows two metres labelled by their own kinds with their percentages and local reset times

#### Scenario: Unusable row is dropped
- **WHEN** a quota row's percentage is missing or not a usable number
- **THEN** that row produces no meter and the other rows still render

### Requirement: Provider usage stays fresh while sessions are live
While at least one non-archived chat session of a provider-routed profile has a started agent, the server SHALL re-pull that profile's usage on a fixed cadence, so a window reset appears without a turn. When no session of the profile qualifies, the server SHALL NOT contact the quota endpoint for it. A refresh SHALL NOT replace held usage with older data.

#### Scenario: Reset appears without a turn
- **WHEN** a window's reset time passes while no turn runs
- **THEN** a later scheduled refresh shows the window at its new percentage

#### Scenario: Pulls stop without live sessions
- **WHEN** every session of the profile is archived or no longer has a started agent
- **THEN** no further quota requests are made for that profile

#### Scenario: Restart starts empty
- **WHEN** the server restarts
- **THEN** the profile shows no usage bar until the next pull arrives

#### Scenario: Older data never downgrades
- **WHEN** a refresh returns data older than what the profile already holds
- **THEN** the held report is kept unchanged

## MODIFIED Requirements

### Requirement: Usage is refreshed when no report has arrived
When a chat session's profile holds no report and the session's agent has started, the system SHALL obtain plan usage data on demand rather than waiting for the agent to emit one. For a profile whose provider serves the provider quota endpoint, that on-demand data SHALL be the provider's own plan usage. Otherwise, on-demand data reflects the account the agent process is logged in with, not the session's provider routing. When plan limits do not apply, or no usage data can be obtained, the system SHALL record no window data and show no usage bar. A refresh SHALL NOT replace fresher window data with older data.

#### Scenario: Windows appear before the first message
- **WHEN** a client attaches to a chat session, starting its agent without sending a prompt, and the profile holds no report while plan usage data is obtainable
- **THEN** the usage bar shows the plan windows without waiting for the first turn

#### Scenario: Session whose agent has not started
- **WHEN** a chat session's profile holds no report and its agent has not started, as with a session no client has attached to, an archived chat, or a missing project directory
- **THEN** no usage bar is shown

#### Scenario: Gateway-routed profile with an account login
- **WHEN** the session's provider routes model traffic through a non-Anthropic endpoint that does not serve the provider quota endpoint while the agent process is logged in with a Claude account
- **THEN** the usage bar shows that account's plan windows

#### Scenario: Gateway-routed profile whose provider serves the quota endpoint
- **WHEN** the provider serves the quota endpoint while the agent process is logged in with a Claude account
- **THEN** the usage bar shows the provider's plan windows, not the logged-in account's

#### Scenario: Session without plan limits
- **WHEN** the session authenticates with an API key, has no account login, and its provider serves no quota endpoint, so plan limits do not apply
- **THEN** no usage bar is shown

#### Scenario: Stale data is not downgraded
- **WHEN** a refresh returns data older than what the profile already holds
- **THEN** the held report is kept unchanged
