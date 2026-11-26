# Spec Delta

## ADDED Requirements

### Requirement: Agents read report snapshots compactly
`process_report_get` SHALL return a report's snapshot in `team_metrics`' compact form by default, and whole with detail `full`. `process_report_submit` SHALL return the stored report with a compact snapshot. `team_metrics_drill` SHALL page a report's drill lists over the frozen snapshot. Compacting and paging SHALL NOT change a stored snapshot.

#### Scenario: Reading a 7d report
- **WHEN** an agent calls `process_report_get` for a 7d report whose snapshot holds 6,998 message refs
- **THEN** the snapshot is under 32 KB and carries every metric's value, `n`, baseline, and flags, with shortened lists marked by their totals

#### Scenario: Full report snapshot
- **WHEN** an agent calls `process_report_get` with detail `full`
- **THEN** the snapshot equals the stored snapshot with the live measurement status

#### Scenario: Paging a report drill list
- **WHEN** an agent pages a 7d report's `mail_share` messages to the end
- **THEN** every message ref of the frozen snapshot is returned exactly once, in id order

#### Scenario: Paging a report after new activity
- **WHEN** new mail arrives between two pages of a report's drill list
- **THEN** the pages still list the frozen snapshot's refs, and the total is unchanged

#### Scenario: Submit echoes a compact snapshot
- **WHEN** a reporting agent submits a 7d report
- **THEN** the returned report carries the compact snapshot, and the stored snapshot is whole

#### Scenario: Stored snapshot unchanged
- **WHEN** a report is read compactly, read in full, and paged
- **THEN** its stored snapshot is byte-identical before and after

## MODIFIED Requirements

### Requirement: Reports are listed with their freshness
The Metrics tab SHALL list reports newest first with window, author, summary, frozen snapshot, and proposals with their state, and SHALL show the latest report per window and its age. `process_reports_list` SHALL return the same to any team member without frozen snapshots, and `process_report_get` SHALL return one report with its snapshot.

#### Scenario: Missed daily report
- **WHEN** no 1d report was submitted for 30 hours
- **THEN** the tab shows the latest 1d report's age as 30 hours

#### Scenario: Listing without snapshots
- **WHEN** an agent calls `process_reports_list` with limit 10
- **THEN** each report carries its id, window, author, period, time, summary, and proposals with their state, and no snapshot

#### Scenario: Tab keeps whole snapshots
- **WHEN** the human opens a report in the Metrics tab
- **THEN** its snapshot is shown whole, with every drill list
