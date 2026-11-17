# Spec Delta

## ADDED Requirements

### Requirement: Quota observations preserve identity and freshness
Quota history SHALL retain the effective provider/account identity, applicable model and window scope, reported usage/reset, source, per-window observation time, receipt time and collection outcome. A failed or status-only update SHALL NOT freshen older window values. Provider catalog changes SHALL NOT relabel past observations.

#### Scenario: Host-login fallback
- **WHEN** a routed model's report describes an unrelated host Claude login
- **THEN** the report retains that source and does not establish capacity for the routed provider

#### Scenario: Failed refresh
- **WHEN** a refresh fails after a successful quota observation
- **THEN** both the failure and the old observation remain visible with the old window timestamp

### Requirement: Incident alternatives use facts available at the time
At quota/context incidents Kawai SHALL freeze the eligible alternatives, routing constraints, effective cooldowns and latest known quota observations with their age. Historical analysis SHALL use observations available by the incident time and SHALL NOT substitute later quota reports or today's configuration.

#### Scenario: Capacity arrives later
- **WHEN** provider B first reports capacity after provider A's incident
- **THEN** the original incident shows B's capacity as unknown and later advice is a new assessment

### Requirement: Recommendation evidence outlives observation detail
Incident recommendations, their immutable assessments and frozen evidence summaries SHALL survive observation pruning. A detailed link to a pruned observation SHALL state that the record expired instead of disappearing.

#### Scenario: Detail pruned
- **WHEN** an observation referenced by an older recommendation is pruned
- **THEN** its frozen evidence summary remains readable and its detailed link states that the record expired
