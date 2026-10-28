## ADDED Requirements

### Requirement: Tool metrics
Kawai SHALL report per window: failure rate by tool/class; the closed-cohort first-attempt success rate of exact `kawai-team` tools, eligible only when the turn's same-snapshot `turn_ended` fact shows coverage version 1 without taint (excluded turns read partial/unrecorded, never successes or zeros); abandoned streaks; and mean failures before recovery. They carry turn attribution and slice by group/profile; every read and push SHALL carry current effective status, even with cached numbers.

#### Scenario: Misleading schema shows up
- **WHEN** in the window `task_submit_result` succeeded on 2 of 10 first attempts and every other `kawai-team` tool on all of them
- **THEN** the first-attempt breakdown reads 20% for `task_submit_result` with `n = 10`

#### Scenario: Weak model gives up more
- **WHEN** the window holds three abandoned streaks, all on one profile
- **THEN** slicing by profile shows all three under that profile

#### Scenario: Tainted turn excluded, not failed
- **WHEN** a turn's closure carries the history-unknown taint
- **THEN** its first attempts are excluded as partial and the metric's coverage states so, rather than counting them as failures or successes

#### Scenario: Status change reaches open views without a refresh
- **WHEN** two teams have the Metrics tab open with cached numbers and the export status alone changes to `budget-unavailable`
- **THEN** both views receive the new status without a report commit or manual refresh, their cached numbers unchanged

#### Scenario: Failed status write shows unknown everywhere
- **WHEN** views are open with cached numbers and a write of either status key fails while its stored value stays the same
- **THEN** direct reads and the scrape show that status `unknown` at once, both views receive `unknown` after one delay, and a repeated failure sends nothing new

#### Scenario: Recovered status is pushed
- **WHEN** a later write or verification of that key succeeds with the stored value unchanged
- **THEN** both views receive the restored status, while an unrelated rolled-back transaction sends nothing

#### Scenario: Status visible while export is disabled
- **WHEN** the export families are budget-unavailable
- **THEN** `team_metrics` reports the measurement status `budget-unavailable` in its compact projection instead of rendering empty tool families as data

### Requirement: Tool metric drill-down opens the first failed call
The Tools drill-down SHALL reach every abandoned streak of the window through any number of pages of at most 50 entries, behind a stable cursor bound to team, slice, window end, page size, and a high-water mark, each page carrying the total; the inline drill stays at most 50 plus the total, with the five longest recovered streaks. Opening one SHALL reveal its first failed call, or report `not-found`, `archived`, or `unreadable` instead of clearing silently.

#### Scenario: Open an abandoned streak
- **WHEN** the human opens an abandoned streak in the 3d window
- **THEN** its chat opens with the first failed tool call revealed

#### Scenario: More abandoned streaks than one page
- **WHEN** the window holds 2,501 abandoned streaks and the tab pages with page size 50
- **THEN** 51 pages of at most 50 entries reach every streak exactly once, and each page carries the total 2,501

#### Scenario: Cursor bound to its request
- **WHEN** a cursor from one slice or page size is sent with another, or the cursor is malformed
- **THEN** the page is refused with an error and no entries

#### Scenario: Later streaks do not shift pages
- **WHEN** new abandoned streaks are recorded while the human pages through the list
- **THEN** the remaining pages and the total stay those of the first page's high-water mark
