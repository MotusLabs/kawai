# Spec Delta

## ADDED Requirements

### Requirement: Usage windows carry their known period length
Each usage window SHALL carry its period length when the window's kind has a known fixed length: 5 hours for the 5-hour (session) window and 7 days for the 7-day and per-model weekly windows. A window whose length is not known, such as overage or a provider quota row, SHALL carry no period length rather than a guessed one. The field SHALL be optional so clients that ignore it render as before.

#### Scenario: Pushed 5-hour and 7-day windows
- **WHEN** a pushed report carries the 5-hour and 7-day windows
- **THEN** the 5-hour window carries a 5-hour period and the 7-day window a 7-day period

#### Scenario: Per-model weekly window
- **WHEN** a usage report or SDK pull carries a weekly window scoped to a model
- **THEN** that window carries a 7-day period

#### Scenario: Usage-report kinds map to the same periods
- **WHEN** a usage report names the session and all-models weekly meters
- **THEN** they carry the same 5-hour and 7-day periods as the pushed windows they correspond to

#### Scenario: Unknown length
- **WHEN** a window is an overage meter, a provider quota row, or a kind the server does not know
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
- **WHEN** a window carries a reset time but no period length, as with a provider quota row
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
