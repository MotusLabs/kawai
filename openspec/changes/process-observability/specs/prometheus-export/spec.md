# Spec Delta

## Purpose

Expose aggregate development and agent measurements to Prometheus while preserving Kawai's independent operation and authoritative detailed history.

## ADDED Requirements

### Requirement: Prometheus integration is optional
Kawai SHALL operate chats, tasks, observation collection, recommendations, reports and daily digests without Prometheus configured or reachable. Metrics export SHALL be disabled by default. Invalid export configuration SHALL disable the endpoint with a diagnostic rather than prevent core operation.

#### Scenario: No Prometheus
- **WHEN** no export configuration exists
- **THEN** Kawai records observations and generates recommendations and digests normally

#### Scenario: Scraper unavailable
- **WHEN** Prometheus stops scraping
- **THEN** managed work and durable observation recording continue without outbound retries to Prometheus

### Requirement: Export is a protected read-only scrape endpoint
When enabled with valid access configuration, Kawai SHALL expose a Prometheus-compatible read-only endpoint using configured scrape credentials. Unauthorized scrapes SHALL receive no metrics. Scrapes SHALL perform no quota polling, model requests, recommendation generation or writes to task/chat state. Export failure SHALL be isolated from normal application requests.

#### Scenario: Repeated scrape
- **WHEN** an authorized scraper requests metrics repeatedly
- **THEN** only committed aggregates and current gauges are returned and no recommendation or provider request is created

### Requirement: Export uses bounded labels and shared definitions
Exported metrics SHALL use a bounded label allowlist for team, group, provider, model, account alias, quota window, stage, execution/wait kind, token kind, acceptance mechanism and outcome as appropriate to each family. Task/session/turn IDs, prompt hashes, paths, free text and secrets SHALL NOT be labels. Durations SHALL use seconds, usage fractions SHALL use ratios, and absence of measurements SHALL NOT become zero measured activity.

#### Scenario: Many tasks
- **WHEN** a team creates thousands of tasks under the same configured workers
- **THEN** the tasks do not create one exported time series each

#### Scenario: Unknown quota
- **WHEN** a provider's quota is unknown or stale
- **THEN** freshness/availability measurements expose that condition and no gauge falsely reports zero usage as fresh

### Requirement: Export distinguishes counters histograms and current gauges
Kawai SHALL export cumulative event/token counters, duration/token histograms, and current queue, blocked-work, open-age, quota and collection-health gauges with documented units, scopes and coverage. Each histogram SHALL expose count and sum. Windowed percentiles SHALL NOT be exported as cumulative counters or used as observations in another histogram.

#### Scenario: Completion distribution
- **WHEN** a task first accepts a result
- **THEN** its creation-to-acceptance duration enters the appropriate histogram once with its count and sum

### Requirement: Cumulative exports survive restart and pruning
Committed observations and their export accumulation SHALL be processed idempotently. A restart, replay, duplicate event or detailed-history prune SHALL NOT decrease cumulative counters or double-count histogram observations. Export SHALL identify aggregate schema version and collection coverage; incompatible definition changes SHALL NOT silently merge with an existing series.

#### Scenario: Crash and replay
- **WHEN** Kawai restarts after recording an observation but before a later processing acknowledgement
- **THEN** recovery counts that observation exactly once

#### Scenario: Retention cleanup
- **WHEN** old detailed usage is pruned
- **THEN** exported lifetime token totals and histogram counts remain unchanged

### Requirement: Historical gaps remain explicit
Kawai SHALL retain detailed evidence independently of scrape availability and SHALL state that resumed scraping does not reconstruct missed gauge history or original event timestamps in Prometheus. Aggregate startup coverage and bounded-label overflow SHALL be observable.

#### Scenario: Missed scrape interval
- **WHEN** Prometheus resumes after an outage
- **THEN** it sees current gauges and cumulative totals while Kawai's timeline remains the source for exact incidents during the gap

### Requirement: Supported metrics can be exported before dependent integrations
The optional endpoint SHALL serve supported observation families while dependent source integrations are unavailable, with bounded source-availability and coverage diagnostics. It SHALL NOT publish fabricated quota, canonical incident or stage samples. Missing sources SHALL remain distinguishable from installed sources with no observations; completing the foundation SHALL NOT count as completing dependent metric integrations.

#### Scenario: Quota adapter has not landed
- **WHEN** core managed-task/turn measurements exist but the shared-provider quota adapter is unavailable
- **THEN** an authorized scrape returns the supported core measurements, identifies provider-quota source unavailability, and does not report synthetic fresh capacity
