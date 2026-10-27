# Spec Delta

## ADDED Requirements

### Requirement: Landed-result share measures delivery of done tasks
Kawai SHALL report `landed_result_share`: of the tasks first done in the window that have a result, the share whose newest result's commit had landed on the default branch by the window's end. Results whose commit cannot be resolved, results whose landing is unknown at the window's end, and tasks without a result SHALL be excluded and counted in the metric's coverage note. While delivery facts are unavailable, the metric SHALL read as unavailable.

#### Scenario: Done but not merged
- **WHEN** 10 tasks are first done in the window with results and 4 of those commits have landed by the window's end
- **THEN** `landed_result_share` reads 0.4 with `n` 10

#### Scenario: Acceptance is independent
- **WHEN** no result was ever accepted but all 10 commits landed
- **THEN** `landed_result_share` reads 1.0 and `accepted_result_share` still reads 0

#### Scenario: Landing unknown at the end
- **WHEN** one of 10 commits first landed at a backdated first-parent commit whose order against the window's end is unknown
- **THEN** `landed_result_share` has `n` 9, and its coverage note counts one unknown landing

### Requirement: The agent tool offers drill-down for named metrics
A `team_metrics` call naming one or more metric ids SHALL return those metrics with their drill lists and breakdowns, plus slice rows when a slice is asked. Each drill list SHALL be capped at 50 entries and state its total. An unknown metric id SHALL be refused, naming the known ids.

#### Scenario: Drill one metric
- **WHEN** the lead calls `team_metrics` with window `7d` and metrics `["tasks_per_landed_change"]`
- **THEN** that metric carries at most 50 drill entries with their total, and the other metrics stay compact

#### Scenario: Unknown metric id
- **WHEN** an agent names metric `velocity`
- **THEN** the call is refused naming the known metric ids

### Requirement: Trends are series of 7d reads
Kawai SHALL compute trends for a team over a range of 4, 8, or 12 weeks: one point per week for every metric, ending at the read time and stepping back 7 days. Each point SHALL equal the 7d read ending at that point's end over the same records and delivery facts, with its value, `n`, baseline, flags, and markers, and SHALL carry the rules that fired at it. Points are recomputed from current records and facts, not what was known then. Trends SHALL NOT be stored.

#### Scenario: A point is a past read
- **WHEN** the 12-week trend's point ending 2026-10-27 is compared with a 7d read ending at the same moment over the same facts
- **THEN** every value, `n`, and baseline is identical

#### Scenario: Rule marks
- **WHEN** the delivery-drop rule fired for the 7d window ending 2026-10-27 and not one week earlier
- **THEN** only the 2026-10-27 point carries `delivery-drop`

#### Scenario: Unknown range
- **WHEN** a trends request names range `6w`
- **THEN** it is refused, naming 4w, 8w, and 12w

#### Scenario: Recomputed, not remembered
- **WHEN** a fetch brings a commit backdated into a past point's window
- **THEN** that point's values change on the next read, and the view states when and from which head it was recomputed

### Requirement: Trend points state incomplete inputs
A metric at a trend point SHALL be marked partial, never shown smaller, when the records it reads for either its window or its baseline predate their retention or recording start: limit events, with their lookback, for limit tax, and completed-turn usage for token metrics. A point before the team's first recorded data SHALL read as no data.

#### Scenario: Limit tax beyond retention
- **WHEN** the 8-week trend includes a point ending 40 days ago
- **THEN** that point's limit tax is marked partial

#### Scenario: Baseline beyond usage retention
- **WHEN** the 12-week trend's oldest point has a window starting 84 days ago and a baseline starting 91 days ago
- **THEN** that point's token metrics are marked partial

### Requirement: A metrics read can end at a chosen time
The Metrics tab SHALL accept a read ending at a chosen past time. Such a read SHALL equal that trend point, and every refresh or re-send of that view SHALL keep the chosen end until another is chosen. A read without one SHALL end now, as today.

#### Scenario: Refresh keeps the end
- **WHEN** the human opens the 7d window ending 2026-10-20 and presses Refresh
- **THEN** the refreshed read still ends 2026-10-20

### Requirement: The Metrics tab has a Trends view
The Metrics tab SHALL offer a Trends view with a range choice of 4, 8, or 12 weeks. It SHALL show one chart per metric, grouped by family, with marks on points where a rule fired. It SHALL show the delivery stale marker, and an accessible table alternative listing every point's value and `n`. Choosing a point SHALL open the 7d window that point represents. The location SHALL name the view and range, and controls SHALL disable while disconnected.

#### Scenario: Open a point
- **WHEN** the human chooses the point ending 2026-10-27 on the changes-landed chart
- **THEN** the Metrics tab shows the 7d window ending at that moment, with its drill-down

#### Scenario: Location restored
- **WHEN** the human reloads on `#/team/<key>/metrics/trends/12w`
- **THEN** the Trends view opens with the 12-week range

#### Scenario: Keyboard and screen reader
- **WHEN** a keyboard user reaches a chart
- **THEN** its table alternative lists each point's end date, value, `n`, and fired rules

## MODIFIED Requirements

### Requirement: Guard metrics are paired and shown together
Each efficiency metric SHALL be shown beside its fixed guard:
- task lead time with the share of done tasks whose result landed on the default branch;
- group mail share, fix iterations, and finding fail rate with reopen rate;
- tokens per task with first-pass review yield for the same slice;
- tokens per landed change with reopen rate.

No surface or tool SHALL change a metric's definition or its guard.

#### Scenario: Faster but unverified
- **WHEN** lead time drops while the landed-result share also drops
- **THEN** both appear side by side for the same window

#### Scenario: Acceptance share is coverage only
- **WHEN** the Metrics tab shows task lead time
- **THEN** its guard is the landed-result share, and the accepted-result share appears among the coverage metrics

### Requirement: Agents read metrics through a read-only tool
The `kawai-team` server SHALL offer `team_metrics`, taking a window, an optional slice, and optional metric ids, and returning the caller's team metrics with the values the Metrics tab computes. Each metric SHALL be compact by default: id, label, family, value, `n`, baseline, every flag, guard, and markers, without drill lists or breakdowns; slice rows appear only when a slice is asked. An unsliced compact read SHALL stay under 32 KB. It SHALL be allowed without approval cards and SHALL change nothing. No agent tool SHALL change a metric definition, guard pairing, or sample threshold.

#### Scenario: Lead reads its team
- **WHEN** the lead calls `team_metrics` with window `7d`
- **THEN** it receives its own team's metric set with `n`, baselines, flags, and guards, without drill lists, in under 32 KB

#### Scenario: Same values as the tab
- **WHEN** the Metrics tab and a compact `team_metrics` call read the 7d window at the same moment over the same delivery facts
- **THEN** every value, `n`, and baseline is identical

#### Scenario: Flags survive compaction
- **WHEN** a metric is partial, approximate, or unavailable
- **THEN** the compact read carries the same flag and reason

#### Scenario: Unknown window
- **WHEN** an agent calls `team_metrics` with window `30d`
- **THEN** the call is refused naming the allowed windows
