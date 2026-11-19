# team-process-metrics Specification

## Purpose
Computes a fixed set of development-process metrics for one team over 1-, 3-, and 7-day windows, each with its sample size, baseline, and paired guard, and shows the same numbers to the human in the Team page and to agents through a read-only tool.

## Requirements

### Requirement: Metrics are computed per team and window at read time
Kawai SHALL compute the metric set for one team over a window of 1, 3, or 7 days ending at the time of the read, from that team's durable records only. Metric values SHALL NOT be stored. The same team, window, slice, and end time SHALL yield the same values on every surface.

#### Scenario: Two surfaces, one number
- **WHEN** the human's Metrics tab and an agent's `team_metrics` call read the 7d window at the same moment
- **THEN** both report identical values

#### Scenario: Another team's records
- **WHEN** another repository's team delivers mail in the window
- **THEN** none of it counts toward this team's metrics

### Requirement: Window cohorts are read with their full history
A metric's cohort SHALL be chosen by an event inside the window (a first `done`, a delivery, a submission, a finding, a turn end). Each member's history SHALL then be read whole, whenever it happened: creation, every status transition, every result and finding, every recorded turn, and the agent start before each. An interval crossing the window's start SHALL count only its part inside.

#### Scenario: Task created long before the window
- **WHEN** a task created 20 days ago is first done inside the 7d window
- **THEN** it is in the lead-time cohort with its full 20-day lead time

#### Scenario: Reopened task closed again
- **WHEN** a task first done 10 days ago is reopened and done again inside the 7d window
- **THEN** it is not in the window's lead-time cohort, and its reopen counts toward reopen rate

#### Scenario: Tokens before the window
- **WHEN** a task first done in the window had turns 9 days earlier
- **THEN** those turns count toward its tokens per task

#### Scenario: History pruned
- **WHEN** a cohort task's earliest turns are older than usage retention
- **THEN** its tokens value is marked partial

### Requirement: Every value carries its sample, baseline, and sufficiency
Each metric value SHALL carry its sample size `n`, the same metric over the immediately preceding window of equal length as its baseline, and an insufficient-sample flag when `n` is below 10. A metric with `n` of 0 SHALL read as no data, never as zero. The threshold SHALL be shown wherever the flag is.

#### Scenario: Small sample
- **WHEN** the 1d first-pass review yield rests on 3 reviewed tasks
- **THEN** it shows `n = 3`, its baseline, and the insufficient-sample flag

#### Scenario: No data
- **WHEN** no task closed in the window
- **THEN** task lead time reads as no data, not 0

### Requirement: Flow metrics
Kawai SHALL report task lead time (creation to first transition to `done`, for tasks first done in the window, p50 and p90) and mail wait (delivery time minus the later of creation and scheduled time, for mail delivered in the window, p50 and p90, normal and urgent apart).

#### Scenario: Reopened and closed again
- **WHEN** a task is done, reopened, and done again in the window
- **THEN** its lead time ends at the first `done`

#### Scenario: Scheduled mail
- **WHEN** mail scheduled for 09:00 is delivered at 09:02
- **THEN** its wait counts as 2 minutes

### Requirement: Quality metrics
Kawai SHALL report first-pass review yield (of tasks whose first result received its first findings in the window, the share where no finding on that result fails), finding fail rate (of findings submitted in the window, the share failing), fix iterations (results per task first done in the window, minus one), and reopen rate (reopens per `done` transition, both in the window).

#### Scenario: First result fails, second passes
- **WHEN** a task's first result gets a failing finding and its second passes
- **THEN** the task counts as not passing first time and has one fix iteration

#### Scenario: Two reviewers disagree
- **WHEN** one reviewer passes a result and another fails it
- **THEN** the result does not count as passing first time

### Requirement: Overhead metrics
Kawai SHALL report each group's share of the team's mail sent in the window, task mail per task first done in the window by sender group, and friction: messages parked, forwarded, held uncertain, or dead-lettered in the window, in total and per task.

#### Scenario: Coordinator load
- **WHEN** the lead sends 40 of 80 messages in the window
- **THEN** the lead's mail share reads 50% with `n = 80`

### Requirement: Capacity metrics
Kawai SHALL report, per profile, limit tax (hours in the window routing treated the profile as cooling, plus hours messages spent parked) and tokens: the team's recorded turn usage in the window by group and profile, and tokens per task first done in the window from all recorded turns of those tasks.

#### Scenario: Coordinator tokens
- **WHEN** the lead's turns run without a task
- **THEN** their tokens count in the group totals but in no task's tokens per task

### Requirement: Cooling time follows the routing rule
Cooling time SHALL be reconstructed from the same rule routing applies at each instant: final limit events group by window, a later final event SHALL replace only an earlier event of its own window, and the profile cools until the latest end still ahead across windows — each event's reset, else one hour after it. A profile's events are its own final events plus its provider's provider-scoped final events, so a provider cooldown shows in the cooling time of every profile it covers.

#### Scenario: A shorter reset supersedes a longer one
- **WHEN** a final event resetting in five hours is followed a minute later by a final event resetting a minute after that
- **THEN** about two minutes of cooling are counted, not five hours

#### Scenario: A short later window does not shorten a weekly one
- **WHEN** a final event for window `seven_day` resets in three days and a later provider-scoped event for window `five_hour` resets two hours after it
- **THEN** cooling counts until the `seven_day` reset (clipped by routing's read window), not the `five_hour` one

#### Scenario: Event outside the read cutoff
- **WHEN** a final event's reset is 30 hours after it
- **THEN** cooling counts only until routing stops reading that event, 24 hours after it

#### Scenario: A sibling model's provider-scoped event counts
- **WHEN** `glm` of provider `zai` has a final provider-scoped event and `glm-flash` of the same provider has no event of its own
- **THEN** `glm-flash`'s cooling time includes that event's cooldown, while a model-scoped window event on `glm` would count in `glm`'s cooling time alone

### Requirement: Guard metrics are paired and shown together
Each efficiency metric SHALL be shown beside its fixed guard: task lead time with the share of done tasks that have an accepted result; group mail share, fix iterations, and finding fail rate with reopen rate; tokens per task with first-pass review yield for the same slice. No surface or tool SHALL change a metric's definition or its guard.

#### Scenario: Faster but unverified
- **WHEN** lead time drops while the accepted-result share also drops
- **THEN** both appear side by side for the same window

### Requirement: Coverage shows what the records miss
Kawai SHALL report, for tasks first done in the window, the share with at least one result, with findings on a result, and with an accepted result, and SHALL state beside quality metrics that work reviewed only by mail is not counted.

#### Scenario: Reviews by mail only
- **WHEN** most tasks close without submitted results or findings
- **THEN** coverage shows the low shares and the quality metrics show their small `n`

### Requirement: Each metric declares whose work it measures
Each metric SHALL declare one attribution side: author (the task's owner: first-pass yield, fix iterations, tokens per task), reviewer (each finding's author: finding fail rate), sender (mail metrics), turn (token totals), or team (lead time, mail wait, reopen rate, coverage, limit tax). A metric SHALL be sliceable only on its own side.

#### Scenario: Reviewer metric on the reviewer side
- **WHEN** finding fail rate is sliced by group
- **THEN** each finding counts under its reviewer's group, not the developer's

#### Scenario: Team metric is not sliced
- **WHEN** lead time is shown under a group slice
- **THEN** it is marked not sliceable rather than guessed

### Requirement: Each task has one author-side owner
A task's author-side owner SHALL be the start that produced its first result: the submitter's latest start at or before that result. Each task SHALL count once, wholly under its owner: its first-pass outcome, all its fix iterations, and all its recorded tokens, whoever spent them. A task without a result SHALL fall under `no result`. A slice SHALL also report how many of its tasks had later results from other versions.

#### Scenario: Two developers on one task
- **WHEN** dev A's first result fails review and dev B, under another prompt hash, submits the passing second result
- **THEN** the task counts once under A's start with one fix iteration and all its tokens, and A's slice reports one mixed task

#### Scenario: No double counting
- **WHEN** first-pass yield is sliced by group file hash
- **THEN** the slices' `n` sum to the unsliced `n`

### Requirement: Metrics can be sliced
Kawai SHALL slice a metric by the group, profile, group file hash, or a named memory file's hash of the agent start that did the work on that metric's side: the latest start of that session at or before the work. A slice SHALL keep its own `n`, baseline, and flag. Work with no recorded start SHALL fall into an `unrecorded` slice.

#### Scenario: Comparing reviewer prompt versions
- **WHEN** reviewers ran under two group file hashes in the 7d window
- **THEN** finding fail rate sliced by group file hash shows each reviewer hash's value and `n`

#### Scenario: Comparing developer prompt versions
- **WHEN** devs ran under two group file hashes
- **THEN** first-pass yield sliced by group file hash splits by the hash each task's owner ran under

#### Scenario: Two reviewers on one result
- **WHEN** two reviewers with different prompt hashes each file findings on one result
- **THEN** each finding counts once under its own reviewer's hash

#### Scenario: Work before recording began
- **WHEN** a result was submitted before agent starts were recorded
- **THEN** it counts under `unrecorded` when sliced by prompt version

### Requirement: The Team page has a Metrics tab
The Team page SHALL have a Metrics tab with a window choice (1d, 3d, 7d) and a slice choice, showing every metric with its value, `n`, baseline, flag, and guard, grouped by family, and SHALL let the human open the tasks and threads behind a metric. Controls SHALL disable while disconnected.

#### Scenario: Drill-down
- **WHEN** the human opens the friction metric for the 3d window
- **THEN** the affected messages are listed and each opens its thread

#### Scenario: Location restored
- **WHEN** the human reloads the page on the Metrics tab with the 7d window chosen
- **THEN** the Metrics tab opens with the 7d window

### Requirement: Agents read metrics through a read-only tool
The `kawai-team` server SHALL offer `team_metrics`, taking a window and an optional slice and returning the caller's team metrics exactly as the Metrics tab computes them. It SHALL be allowed without approval cards and SHALL change nothing. No agent tool SHALL change a metric definition, guard pairing, or sample threshold.

#### Scenario: Lead reads its team
- **WHEN** the lead calls `team_metrics` with window `7d`
- **THEN** it receives its own team's metric set with `n`, baselines, flags, and guards

#### Scenario: Unknown window
- **WHEN** an agent calls `team_metrics` with window `30d`
- **THEN** the call is refused naming the allowed windows

### Requirement: Metric inputs are retained for two windows
Every record a metric reads SHALL be retained for at least 14 days, so the longest window and its baseline are complete. Limit events SHALL be retained 15 days for metrics, while cooldown and routing decisions keep reading only their own window.

#### Scenario: 7d limit tax
- **WHEN** a final limit event happened 10 days ago
- **THEN** it still counts toward the 7d baseline's limit tax

#### Scenario: Routing unaffected
- **WHEN** a final limit event happened 3 days ago
- **THEN** it does not make the profile cool down now

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

#### Scenario: Healthy recovery ticks leave views unchanged
- **WHEN** healthy ticks have unchanged recovery status and counts
- **THEN** checkedAt, raw checkpoint bytes and all-field canonical status stay unchanged, with no cache invalidation or push; failed/unverified recovery still requires a successful process verification

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

### Requirement: Tool metric reads avoid multiplicative history scans
Tool metric reads SHALL NOT re-examine a team's entire observation history for each completed turn or live session. They SHALL preserve the requested team's cohort, ordering, and single-read snapshot, including closure facts outside the tool-completion window. This applies to the Metrics tab, agent reads, and report generation.

#### Scenario: Large single-team history
- **GIVEN** a team has thousands of completed turns and unrelated retained observations
- **WHEN** its tool metrics are computed for a window and baseline
- **THEN** closure matching uses the relevant session and turn identities without repeating a team-wide history scan per completed turn
- **AND** returned closures are exactly those with matching tool completions in the requested interval, ordered by their recorded sequence

#### Scenario: Live sessions with unrelated history
- **GIVEN** live sessions and retained tool observations belong to the requested team
- **WHEN** tool metrics determine which sessions are live
- **THEN** matching examines each live session's observations without repeating a team-wide scan per live session
- **AND** a valid live turn remains represented when its session has an in-window tool completion, including one from another turn of that session

#### Scenario: Closure outside the completion window
- **WHEN** a tool completion is inside the requested interval and its same-session, same-turn closure is retained outside that interval
- **THEN** the closure is included with its existing coverage and taint information
- **AND** a completion exactly at the interval start is included and one exactly at the interval end is excluded

#### Scenario: Other identities cannot satisfy a match
- **WHEN** retained tool completions belong only to another team, another session, or another turn
- **THEN** they do not qualify a closure of the requested team, session, and turn

#### Scenario: Concurrent closure commit
- **WHEN** another connection commits a turn closure and removes its live state after the metrics read has established its snapshot
- **THEN** that metrics read keeps the original closure and live-state view
- **AND** a subsequent fresh read sees the committed closure and updated live state
