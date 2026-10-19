## MODIFIED Requirements

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

