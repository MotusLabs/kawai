# Spec Delta

## MODIFIED Requirements

### Requirement: Reports are listed with their freshness
The Metrics tab SHALL list reports newest first with window, author, summary, frozen snapshot, and proposals with their state, and SHALL show the latest report per window and its age. `process_reports_list` and `process_report_get` SHALL return the same to any team member. A snapshot frozen before a metric or field existed SHALL read it as absent, never 0, and SHALL never be rewritten or re-projected.

#### Scenario: Missed daily report
- **WHEN** no 1d report was submitted for 30 hours
- **THEN** the tab shows the latest 1d report's age as 30 hours

#### Scenario: Report frozen before delivery metrics
- **WHEN** a report frozen before the delivery family existed is read
- **THEN** its snapshot has no delivery metrics, and the reader shows them as absent rather than 0
