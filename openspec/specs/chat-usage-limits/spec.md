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
When a session's profile has a provider base URL, the server SHALL fetch coding-plan usage from `/api/monitor/usage/quota/limit` at that URL's origin, using the session's effective credentials, without waiting for a turn. Model API paths, queries, and fragments SHALL NOT enter the quota URL. Only a matching quota response SHALL produce provider window data, marked with its own usage source; failures SHALL leave the session undisturbed.

#### Scenario: API-key gateway profile shows provider usage
- **WHEN** a session's profile routes through a base URL that serves the quota endpoint and authenticates with an API key with no host login
- **THEN** the usage bar shows the provider's plan windows once the session's agent has started

#### Scenario: Non-matching response records no data
- **WHEN** the quota endpoint answers with an auth refusal, an error, or a body without the usage shape
- **THEN** no provider window data is recorded, the chat session is undisturbed, and any host-account windows follow the separate fallback rules

#### Scenario: Provider report is marked
- **WHEN** plan usage is obtained from the quota endpoint
- **THEN** the report carries a usage source distinct from pushed, reported, and SDK-pulled reports

#### Scenario: Default route is never probed
- **WHEN** a session's profile has no provider base URL
- **THEN** no quota request is ever made for that profile

#### Scenario: Model API path does not prefix the quota endpoint
- **WHEN** the effective provider base URL is `https://gateway.example/api/anthropic`
- **THEN** the quota request goes to `https://gateway.example/api/monitor/usage/quota/limit`, with the same effective credentials

#### Scenario: Scheme and port are preserved while unrelated URL parts are discarded
- **WHEN** the effective provider base URL is `http://gateway.example:8080/api/anthropic/?route=glm#model`
- **THEN** the quota request goes to `http://gateway.example:8080/api/monitor/usage/quota/limit`

### Requirement: Provider usage windows keep the provider's own identity
Each usable row of a provider quota response SHALL render as its own usage-bar meter, labelled by what the row counts and, when the row states its window length, that length, so provider windows remain distinguishable from Claude plan windows, with the row's reset time shown in the user's local time. A row whose percentage cannot be used SHALL be dropped rather than rendered wrong; the remaining rows SHALL still render.

#### Scenario: Two provider rows
- **WHEN** a quota response carries a 5-hour token row at 30% and a monthly tool-call row at 2%, each with a reset time
- **THEN** the usage bar shows two meters labelled "5-hour tokens" and "Monthly tool calls" with their percentages and local reset times

#### Scenario: Row without a usable length keeps a kind label
- **WHEN** a token row carries no window length, or one in a unit the server does not know
- **THEN** its meter is labelled "Tokens" and still shows its percentage and reset time

#### Scenario: Unknown row kind
- **WHEN** a quota row has a kind the server does not know
- **THEN** its meter is labelled by the row's raw kind

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

### Requirement: Usage windows carry their known period length
Each usage window SHALL carry its period length when it is known: for Claude windows from the kind's fixed length (5 hours for the 5-hour window, 7 days for the 7-day and per-model weekly windows); for a provider quota row from the row's own stated length, when its unit is one the server knows. A window whose length is not known, such as overage, a provider row without a usable length, or an unknown kind, SHALL carry none rather than a guess. The field SHALL stay optional.

#### Scenario: Pushed 5-hour and 7-day windows
- **WHEN** a pushed report carries the 5-hour and 7-day windows
- **THEN** the 5-hour window carries a 5-hour period and the 7-day window a 7-day period

#### Scenario: Per-model weekly window
- **WHEN** a usage report or SDK pull carries a weekly window scoped to a model
- **THEN** that window carries a 7-day period

#### Scenario: Usage-report kinds map to the same periods
- **WHEN** a usage report names the session and all-models weekly meters
- **THEN** they carry the same 5-hour and 7-day periods as the pushed windows they correspond to

#### Scenario: Provider row stating an hour-based length
- **WHEN** a provider quota row states a window of 5 hours
- **THEN** the window carries a 5-hour period and its meter shows the elapsed-time marker

#### Scenario: Provider row stating a monthly length
- **WHEN** a provider quota row states a window of 1 month and resets on 3 November at 10:23 UTC
- **THEN** the window's period runs from 3 October at 10:23 UTC to the reset

#### Scenario: Monthly reset past the previous month's last day
- **WHEN** a monthly provider row resets on 31 March
- **THEN** its period starts on the last day of February at the same time of day

#### Scenario: Unknown length
- **WHEN** a window is an overage meter, a provider row with no length, an unknown unit, or a non-positive count, or a kind the server does not know
- **THEN** the window carries no period length

### Requirement: Each usage meter shows elapsed window time
Each meter SHALL mark on its existing track the share of its window already elapsed: one minus the time left until reset divided by the period length, clamped to 0-100%. The marker SHALL be visibly distinct from the usage fill and SHALL NOT add height, rows, or text to the bar. No marker SHALL be drawn when the window has no reset time, no period length, or a reset time already passed.

#### Scenario: Halfway through a 5-hour window
- **WHEN** a 5-hour window resets in 2 hours 30 minutes
- **THEN** its meter shows the time marker at 50% of the track

#### Scenario: Usage ahead of pace
- **WHEN** a window is 70% used and 40% of its period has elapsed
- **THEN** the usage fill extends past the time marker

#### Scenario: Usage behind pace
- **WHEN** a window is 20% used and 60% of its period has elapsed
- **THEN** the usage fill ends short of the time marker

#### Scenario: No period length
- **WHEN** a window carries a reset time but no period length, as with a provider quota row that states no usable length
- **THEN** its meter shows the usage fill, percent, and reset time with no time marker

#### Scenario: Reset already passed
- **WHEN** the held window's reset time is in the past
- **THEN** its meter shows no time marker until a newer report arrives

#### Scenario: Bar size unchanged
- **WHEN** a meter gains a time marker
- **THEN** the bar keeps the same rows and text as without one, and its height does not change

### Requirement: The time marker follows the clock
The time marker SHALL advance as time passes without waiting for a new usage report, updating at least once a minute while the bar is shown.

#### Scenario: Marker moves between reports
- **WHEN** no usage report arrives for several minutes while a chat with a usage bar is open
- **THEN** each marked meter's time marker advances to match the time left

#### Scenario: Reset passes while shown
- **WHEN** a window's reset time passes while the bar is shown
- **THEN** that meter's time marker disappears within a minute

### Requirement: Meters state usage against elapsed time in words
A meter with a time marker SHALL expose, as its hover text and accessible description, the percent used, the percent of the window elapsed, and the time left until reset. A meter without a marker SHALL expose the percent used and its reset time.

#### Scenario: Hover text with a marker
- **WHEN** the user hovers a 5-hour meter 22% used with 2 hours 30 minutes left
- **THEN** the hover text reads that 22% is used, 50% of the window has elapsed, and it resets in 2h 30m

#### Scenario: Screen reader
- **WHEN** an assistive technology reads a marked meter
- **THEN** it announces the same used, elapsed, and time-left values

### Requirement: Quota failures distinguish missing routes from authentication refusals
Quota authentication refusals SHALL suppress the host-login SDK usage fallback. Missing routes, non-provider responses, and service or transport failures SHALL preserve that fallback. A JSON `success: false` alone SHALL NOT establish an authentication refusal. HTTP 200 with `{ "success": false, "code": 500, "msg": "404 NOT_FOUND" }` SHALL be treated as a missing route. Failed quota pulls SHALL NOT create provider windows or erase a held report.

#### Scenario: Wrapped missing route permits fallback
- **WHEN** the quota endpoint returns HTTP 200 with `{ "success": false, "code": 500, "msg": "404 NOT_FOUND" }`
- **THEN** the host-login SDK usage fallback is allowed, no provider windows are invented, and the failure is not treated as bad credentials

#### Scenario: Ordinary missing route permits fallback
- **WHEN** the quota endpoint returns HTTP 404 or 405
- **THEN** the host-login SDK usage fallback is allowed

#### Scenario: Explicit authentication refusal suppresses fallback
- **WHEN** the quota endpoint returns HTTP 401 or 403, or an HTTP 200 failure envelope with authentication code 401, 403, or 1001
- **THEN** no host-login SDK usage fallback runs, and an initially empty profile shows no usage bar

#### Scenario: Unknown or service failure is not an authentication refusal
- **WHEN** the quota endpoint returns HTTP 200 with `success: false` and an unknown or service-error code, without a recognized missing-route signal
- **THEN** the host-login SDK usage fallback is allowed and no provider windows are recorded

#### Scenario: Failed refresh keeps a held provider report
- **WHEN** a previously successful provider profile's scheduled refresh fails
- **THEN** its held report remains unchanged and no host-login report is substituted by that refresh
