## RENAMED Requirements

- FROM: `### Requirement: Plan usage reports are kept per profile`
- TO: `### Requirement: Plan usage reports are kept per provider`

## MODIFIED Requirements

### Requirement: Plan usage reports are kept per provider
The system SHALL capture each plan usage report the agent emits in a chat session and keep the most recent one per provider with the time it was received, shared by sessions on every profile of that provider. A report SHALL carry, when the agent provides them, the overall status (allowed, warning, or limited) and, for each known plan window, the percent used and the reset time. A report without window data SHALL NOT replace window data already held for that provider.

#### Scenario: Report with both plan windows
- **WHEN** a chat session using the default profile receives a report with 5-hour and 7-day window data
- **THEN** the latest report for the default profile's provider holds both windows, the status, and the time it was received

#### Scenario: Report with a per-model weekly window
- **WHEN** a report names a weekly window scoped to a model
- **THEN** that window is kept alongside the 5-hour and 7-day windows as its own entry

#### Scenario: Report without window data
- **WHEN** a report contains only a status and the provider already has window data
- **THEN** the status and received time are updated and the existing window data is kept

#### Scenario: Sessions share a profile
- **WHEN** two chat sessions use the same profile and one of them receives a report
- **THEN** both sessions show that report

#### Scenario: Profiles share a provider
- **WHEN** sessions on `glm` and `glm-flash` of provider `zai` are attached and the `glm` session receives a report
- **THEN** the `glm-flash` session shows that report too

### Requirement: The chat view shows a persistent usage bar
The chat view SHALL show a usage bar directly under the header whenever the session's provider has plan window data. The bar SHALL render one utilization meter per known plan window, each labelled with the percent used and the local reset time. A warning or limited status SHALL be visibly distinct from the normal state. The bar SHALL NOT render when the provider has no window data.

#### Scenario: Both plan windows known
- **WHEN** the session's provider has a report with 22% of the 5-hour window and 17% of the 7-day window used
- **THEN** the bar shows both meters with their percentages and local reset times

#### Scenario: Per-model weekly window known
- **WHEN** the report also carries a weekly window scoped to a model
- **THEN** the bar shows that meter as its own labelled entry

#### Scenario: Limit warning
- **WHEN** the latest report for the session's provider has a warning or limited status
- **THEN** the bar is shown in a warning or error style

#### Scenario: Provider reports no usage data
- **WHEN** the session's provider has never held window data, as with providers that send none
- **THEN** no usage bar is shown

#### Scenario: Reset time is far away
- **WHEN** a window's reset time is more than a day away
- **THEN** the reset time is still shown in the user's local time zone

### Requirement: Usage reports reach attached clients
The latest report for a session's provider SHALL be included in the chat snapshot and SHALL be pushed to every client attached to a session of that provider when a new report is captured. Reports SHALL be held in server memory only and MAY be absent after a server restart until the next update.

#### Scenario: Live update during a turn
- **WHEN** a report is captured while clients are attached to sessions on profiles of that provider
- **THEN** each of those clients updates its usage bar without reconnecting

#### Scenario: Reconnect
- **WHEN** a client attaches to a chat session whose provider has a report
- **THEN** the snapshot it receives contains that report

#### Scenario: After a server restart
- **WHEN** the server has restarted and no update has arrived since for a provider
- **THEN** sessions of that provider show no usage bar until the next report

### Requirement: Usage is refreshed when no report has arrived
When a provider holds no report and either its chat agent has started or it qualifies for background quota observation, the system SHALL fetch plan usage on demand, once per provider. A quota-serving provider's data SHALL be its own plan usage; otherwise it reflects the agent process's logged-in account, not the session's provider routing. Without plan limits or obtainable data, no window data SHALL be recorded and no usage bar shown. A refresh SHALL NOT replace fresher data with older data.

#### Scenario: Windows appear before the first message
- **WHEN** a client attaches to a chat session, starting its agent without sending a prompt, and the provider holds no report while plan usage data is obtainable
- **THEN** the usage bar shows the plan windows without waiting for the first turn

#### Scenario: Session whose agent has not started
- **WHEN** a chat session's provider holds no report, its agent has not started, and it does not qualify for background quota observation, as with a session no client has attached to, an archived chat, or a missing project directory
- **THEN** no usage bar is shown

#### Scenario: One pull per provider
- **WHEN** sessions on two profiles of a provider that does not serve the quota endpoint start their agents while the provider holds no report
- **THEN** plan usage is fetched once, and both sessions show the result

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
- **WHEN** a refresh returns data older than what the provider already holds
- **THEN** the held report is kept unchanged

#### Scenario: Eligible alternative without a live chat
- **WHEN** a configured team worker uses a provider with a standalone quota reader and no chat agent is running for it
- **THEN** background observation can fill its quota history without starting a chat or making a model request

### Requirement: Provider plan usage is pulled from the provider quota endpoint
When a session's provider has a base URL, the server SHALL fetch coding-plan usage from `/api/monitor/usage/quota/limit` at that URL's origin once for the provider, using the effective provider credentials for the qualifying session or team configuration. Model API paths, queries, and fragments SHALL NOT enter the quota URL. Only a matching quota response SHALL produce provider window data, marked with its own usage source; failures SHALL leave the session undisturbed.

#### Scenario: API-key gateway profile shows provider usage
- **WHEN** a session's provider routes through a base URL that serves the quota endpoint and authenticates with an API key with no host login
- **THEN** the usage bar shows the provider's plan windows once the session's agent has started

#### Scenario: Shared plan pulled once
- **WHEN** sessions on `glm` and `glm-flash` of provider `zai`, whose base URL serves the quota endpoint, start their agents
- **THEN** one quota request is made for `zai`, and both sessions' usage bars show its plan windows

#### Scenario: Non-matching response records no data
- **WHEN** the quota endpoint answers with an auth refusal, an error, or a body without the usage shape
- **THEN** no provider window data is recorded, the chat session is undisturbed, and any host-account windows follow the separate fallback rules

#### Scenario: Provider report is marked
- **WHEN** plan usage is obtained from the quota endpoint
- **THEN** the report carries a usage source distinct from pushed, reported, and SDK-pulled reports

#### Scenario: Default route is never probed
- **WHEN** a session's provider has no base URL
- **THEN** no quota request is ever made for that provider

#### Scenario: Model API path does not prefix the quota endpoint
- **WHEN** the effective provider base URL is `https://gateway.example/api/anthropic`
- **THEN** the quota request goes to `https://gateway.example/api/monitor/usage/quota/limit`, with the same effective credentials

#### Scenario: Scheme and port are preserved while unrelated URL parts are discarded
- **WHEN** the effective provider base URL is `http://gateway.example:8080/api/anthropic/?route=glm#model`
- **THEN** the quota request goes to `http://gateway.example:8080/api/monitor/usage/quota/limit`

#### Scenario: Background provider configuration
- **WHEN** a quota-serving provider qualifies through a configured team worker rather than a started session
- **THEN** the pull resolves that worker's effective provider configuration, records its observation identity, and never exposes credentials in the result

### Requirement: Provider usage stays fresh while sessions are live
While a quota-serving provider has a started non-archived chat session, or is an eligible worker of a configured team, the server SHALL re-pull its usage on a fixed cadence, once for all of its profiles. Removing both reasons SHALL stop polling. Background collection SHALL use a standalone quota reader and SHALL NOT start an agent or make a model request. A refresh SHALL NOT replace held usage with older data; failures SHALL leave held values at their original observation time.

#### Scenario: Reset appears without a turn
- **WHEN** a window's reset time passes while no turn runs
- **THEN** a later scheduled refresh shows the window at its new percentage

#### Scenario: Pulls stop without live sessions
- **WHEN** every session on the provider's profiles is archived or no longer has a started agent, and no configured team lists the provider as an eligible worker
- **THEN** no further quota requests are made for that provider

#### Scenario: A session on another profile keeps it fresh
- **WHEN** the last live `glm` session is archived while a `glm-flash` session of the same provider `zai` still has a started agent
- **THEN** scheduled quota requests for `zai` continue

#### Scenario: Restart starts empty
- **WHEN** the server restarts
- **THEN** the provider's sessions show no usage bar until the next pull arrives

#### Scenario: Older data never downgrades
- **WHEN** a refresh returns data older than what the provider already holds
- **THEN** the held report is kept unchanged

#### Scenario: Shutdown stops refreshes
- **WHEN** the server shuts down while a pull or refresh is in flight
- **THEN** nothing is published for it afterwards and no further quota requests are made

#### Scenario: Unused alternative stays observable
- **WHEN** no agent is running for a quota-serving provider that remains a configured team worker
- **THEN** scheduled quota observations continue for later incident analysis

#### Scenario: No standalone reader
- **WHEN** an eligible provider exposes usage only through a running agent and has none
- **THEN** capacity remains unknown or stale, no agent is launched for collection, and the missing reader is reported
