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
When a chat session's profile holds no report and the session has begun a turn, the system SHALL obtain plan usage data on demand rather than waiting for the agent to emit one. On-demand data reflects the account the agent process is logged in with, not the session's provider routing. When plan limits do not apply, or no usage data can be obtained, the system SHALL record no window data and show no usage bar. A refresh SHALL NOT replace fresher window data with older data.

#### Scenario: Windows appear early in the first turn
- **WHEN** a chat session's first turn has started, its profile holds no report, and plan usage data is obtainable
- **THEN** the usage bar shows the plan windows without waiting for that turn to complete

#### Scenario: Session that has never run a turn
- **WHEN** a chat session has been opened but no turn has begun
- **THEN** no usage bar is shown

#### Scenario: Gateway-routed profile with an account login
- **WHEN** the session's provider routes model traffic through a non-Anthropic endpoint while the agent process is logged in with a Claude account
- **THEN** the usage bar shows that account's plan windows

#### Scenario: Session without plan limits
- **WHEN** the session authenticates with an API key and no account login, so plan limits do not apply
- **THEN** no usage bar is shown

#### Scenario: Stale data is not downgraded
- **WHEN** a refresh returns data older than what the profile already holds
- **THEN** the held report is kept unchanged
