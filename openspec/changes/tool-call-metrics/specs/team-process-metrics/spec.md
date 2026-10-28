## ADDED Requirements

### Requirement: Tool metrics
Kawai SHALL report, for the window: tool failure rate by tool and failure class; the closed-cohort first-attempt success rate of exact `kawai-team` tools, eligible only when the turn's same-snapshot `turn_ended` fact shows coverage version 1 without taint (excluded turns read partial/unrecorded, never successes or zeros); abandoned streaks; and mean failures before recovery. They carry turn attribution, slice by group/profile, and the bounded status rides both `team_metrics` projections.

#### Scenario: Misleading schema shows up
- **WHEN** in the window `task_submit_result` succeeded on 2 of 10 first attempts and every other `kawai-team` tool on all of them
- **THEN** the first-attempt breakdown reads 20% for `task_submit_result` with `n = 10`

#### Scenario: Weak model gives up more
- **WHEN** the window holds three abandoned streaks, all on one profile
- **THEN** slicing by profile shows all three under that profile

#### Scenario: Tainted turn excluded, not failed
- **WHEN** a turn's closure carries the history-unknown taint
- **THEN** its first attempts are excluded as partial and the metric's coverage states so, rather than counting them as failures or successes

#### Scenario: Status visible while export is disabled
- **WHEN** the export families are budget-unavailable
- **THEN** `team_metrics` reports the measurement status `budget-unavailable` in its compact projection instead of rendering empty tool families as data

### Requirement: Tool metric drill-down opens the first failed call
The Tools family's drill-down SHALL list every abandoned streak of the window through at most 50 pages behind a stable cursor bound to team, slice, window end, and page size, carrying the total, plus the five longest recovered streaks sorted by length, close time, then stable fact id. Opening one SHALL open its chat at the streak's first failed call, and a reveal that cannot resolve SHALL report `not-found`, `archived`, or `unreadable` explicitly instead of clearing silently.

#### Scenario: Open an abandoned streak
- **WHEN** the human opens an abandoned streak in the 3d window
- **THEN** its chat opens with the first failed tool call revealed

#### Scenario: More abandoned streaks than one page
- **WHEN** the window holds 60 abandoned streaks
- **THEN** all are reachable through the paged cursor within the 50-page bound and the response carries the total 60
