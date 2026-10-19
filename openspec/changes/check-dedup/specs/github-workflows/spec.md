# Spec Delta

## ADDED Requirements

### Requirement: Pull-request CI runs the unit suite once
On pull requests the quality-gates job SHALL run the unit suite exactly once, without the coverage pass. On pushes to master it SHALL also run the coverage pass and upload the coverage artifact. Coverage MUST NOT gate either run.

#### Scenario: Pull request
- **WHEN** CI runs for a pull request
- **THEN** the quality-gates job runs the unit suite once and runs no coverage pass

#### Scenario: Push to master
- **WHEN** CI runs for a push to master
- **THEN** the quality-gates job runs the unit suite and the coverage pass, and uploads the coverage artifact
