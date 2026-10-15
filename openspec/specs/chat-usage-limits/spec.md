# chat-usage-limits Specification

## Purpose

Show chat users how much of their Claude plan allowance remains, using plan usage data the agent already reports and the SDK can return on demand, so limits are visible before a turn fails on them.

## Requirements

### Requirement: Plan usage reports are kept per profile
The system SHALL capture each plan usage report the agent emits in a chat session and keep the most recent one per Claude profile with the time it was received. A report SHALL carry, when the agent provides them, the overall status (allowed, warning, or limited) and, for each known plan window, the percent used and the reset time. A report without window data SHALL NOT replace window data already held for that profile.

#### Scenario: Report with both plan windows
- **WHEN** a chat session using the default profile receives a report with 5-hour and 7-day window data
- **THEN** the latest report for the default profile holds both windows, the status, and the time it was received

#### Scenario: Report with a per-model weekly window
- **WHEN** a report names a weekly window scoped to a model
- **THEN** that window is kept alongside the 5-hour and 7-day windows as its own entry

#### Scenario: Report without window data
- **WHEN** a report contains only a status and the profile already has window data
- **THEN** the status and received time are updated and the existing window data is kept

#### Scenario: Sessions share a profile
- **WHEN** two chat sessions use the same profile and one of them receives a report
- **THEN** both sessions show that report

### Requirement: The chat view shows a persistent usage bar
The chat view SHALL show a usage bar directly under the header whenever the session's profile has plan window data. The bar SHALL render one utilization meter per known plan window, each labelled with the percent used and the local reset time. A warning or limited status SHALL be visibly distinct from the normal state. The bar SHALL NOT render when the profile has no window data.

#### Scenario: Both plan windows known
- **WHEN** the session's profile has a report with 22% of the 5-hour window and 17% of the 7-day window used
- **THEN** the bar shows both meters with their percentages and local reset times

#### Scenario: Per-model weekly window known
- **WHEN** the report also carries a weekly window scoped to a model
- **THEN** the bar shows that meter as its own labelled entry

#### Scenario: Limit warning
- **WHEN** the latest report for the session's profile has a warning or limited status
- **THEN** the bar is shown in a warning or error style

#### Scenario: Provider reports no usage data
- **WHEN** the session's profile has never held window data, as with providers that send none
- **THEN** no usage bar is shown

#### Scenario: Reset time is far away
- **WHEN** a window's reset time is more than a day away
- **THEN** the reset time is still shown in the user's local time zone

### Requirement: Usage reports reach attached clients
The latest report for a session's profile SHALL be included in the chat snapshot and SHALL be pushed to every client attached to a session of that profile when a new report is captured. Reports SHALL be held in server memory only and MAY be absent after a server restart until the next update.

#### Scenario: Live update during a turn
- **WHEN** a report is captured while clients are attached to sessions of that profile
- **THEN** each of those clients updates its usage bar without reconnecting

#### Scenario: Reconnect
- **WHEN** a client attaches to a chat session whose profile has a report
- **THEN** the snapshot it receives contains that report

#### Scenario: After a server restart
- **WHEN** the server has restarted and no update has arrived since for a profile
- **THEN** sessions of that profile show no usage bar until the next report

### Requirement: Usage is refreshed when no report has arrived
When a chat session's profile holds no report and its agent has started, the system SHALL fetch plan usage on demand instead of waiting for one. If the profile's provider serves the quota endpoint, that data SHALL be the provider's own plan usage; otherwise it reflects the agent process's logged-in account, not the session's provider routing. Without plan limits or obtainable data, no window data SHALL be recorded and no usage bar shown. A refresh SHALL NOT replace fresher data with older data.

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

#### Scenario: Shutdown stops refreshes
- **WHEN** the server shuts down while a pull or refresh is in flight
- **THEN** nothing is published for it afterwards and no further quota requests are made
