# Spec Delta

## MODIFIED Requirements

### Requirement: Agents read metrics through a read-only tool
The `kawai-team` server SHALL offer `team_metrics` (a window, an optional slice, an optional `detail` of `compact` (default) or `full`), returning the caller's team metrics with the Metrics tab's values. A compact read SHALL stay under 32 KB, keep every value, `n`, baseline, and flag, and mark each shortened list with its total; a full read SHALL return every drill row. Neither SHALL change anything, need approval cards, or change a metric definition, guard pairing, or sample threshold.

#### Scenario: Lead reads its team
- **WHEN** the lead calls `team_metrics` with window `7d`
- **THEN** it receives its own team's metric set with `n`, baselines, flags, and guards, in under 32 KB

#### Scenario: Unknown window
- **WHEN** an agent calls `team_metrics` with window `30d`
- **THEN** the call is refused naming the allowed windows

#### Scenario: Same values as the tab
- **WHEN** the Metrics tab and a compact `team_metrics` call read the 7d window in the same cache period
- **THEN** every value, `n`, baseline, flag, and the measurement status are identical

#### Scenario: Compact marks shortened lists
- **WHEN** a compact read shortens a metric's message drill list of 2,595 refs
- **THEN** the metric carries at most 50 of them, `messagesTotal` 2,595, and the read is marked `projectionTruncated`

#### Scenario: Full detail is lossless
- **WHEN** an agent calls `team_metrics` with window `7d` and detail `full`
- **THEN** every drill row, breakdown row, and slice row equals the tab's read

#### Scenario: Measurement status in both details
- **WHEN** the export families are budget-unavailable
- **THEN** compact and full reads both carry the measurement status `budget-unavailable`

## ADDED Requirements

### Requirement: Agents page metric drill lists
`team_metrics_drill` SHALL page one drill list (`tasks`, `messages`, or `toolStreaks`) of one metric from a live window or a report of the caller's team, each page with the list's total and a cursor bound to team, source, window end, metric, list, page size, and, for tool streaks, the high-water mark. Following cursors SHALL reach every entry of unchanged records exactly once. Bad arguments and mismatched or foreign cursors SHALL be refused with no entries.

#### Scenario: Paging a message list to the end
- **WHEN** an agent pages `mail_share` messages for 7d with limit 200 from the first page until the cursor is null
- **THEN** all 2,595 refs are returned once in id order and every page states total 2,595

#### Scenario: Short list ends on its first page
- **WHEN** a metric has 12 task refs
- **THEN** the first page holds all 12, total 12, and a null cursor

#### Scenario: Live pages keep their window end
- **WHEN** page 2 is read an hour after page 1, with source records unchanged
- **THEN** it is computed for page 1's window end, not for now

#### Scenario: Tool streaks keep their high-water mark
- **WHEN** new abandoned streaks are recorded while an agent pages `tool_abandoned_streaks`
- **THEN** the remaining pages and the total stay those of the first page's high-water mark

#### Scenario: Unknown metric or list
- **WHEN** an agent names metric `velocity`, or list `toolStreaks` for a metric without tool streaks
- **THEN** the call is refused naming the allowed values, through either tool runtime

#### Scenario: Cursor bound to its request
- **WHEN** a cursor is malformed, carries another team, or is sent with a different limit
- **THEN** the call is refused with no entries, through either tool runtime

#### Scenario: Another team's report
- **WHEN** a drill names a report of another team
- **THEN** the call is refused as an unknown report

### Requirement: The Metrics tab reads metrics whole
The Metrics tab's reads SHALL NOT be compacted or capped. Every drill entry, breakdown, and slice row stays reachable there, and compacting or paging an agent read SHALL NOT change the value the tab shares with it.

#### Scenario: Tab keeps the whole drill list
- **WHEN** the human opens `mail_share` in the Metrics tab for a 7d window with 2,595 messages behind it, after an agent's compact read in the same cache period
- **THEN** all 2,595 messages are listed
