# Spec Delta

## MODIFIED Requirements

### Requirement: Export distinguishes counters histograms and current gauges
Kawai SHALL export cumulative event/token counters, duration/token histograms, and current queue, blocked-work, open-age, quota and collection-health gauges with documented units, scopes and coverage. Each histogram SHALL expose count and sum. Windowed percentiles SHALL NOT be exported as cumulative counters or used as observations in another histogram.

#### Scenario: Completion distribution
- **WHEN** a task first accepts a result
- **THEN** its creation-to-acceptance duration enters the appropriate histogram once with its count and sum

### Requirement: Prometheus integration is optional
Kawai SHALL operate chats, tasks, observation collection, recommendations, reports and daily digests without Prometheus configured or reachable. Metrics export SHALL be disabled by default. Invalid export configuration SHALL disable the endpoint with a diagnostic rather than prevent core operation.

#### Scenario: No Prometheus
- **WHEN** no export configuration exists
- **THEN** Kawai records observations and generates recommendations and digests normally

#### Scenario: Scraper unavailable
- **WHEN** Prometheus stops scraping
- **THEN** managed work and durable observation recording continue without outbound retries to Prometheus
