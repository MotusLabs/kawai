# Spec Delta

## ADDED Requirements

### Requirement: Observation definitions are shared across surfaces
The Metrics view, team tools and Prometheus export SHALL share observation definitions, units and scope. Histogram approximations SHALL be distinguished from exact read-time percentiles.

#### Scenario: Different percentile methods
- **WHEN** Prometheus estimates a percentile from histogram buckets
- **THEN** it is documented as an approximation and is not claimed to equal the Metrics view's exact percentile
