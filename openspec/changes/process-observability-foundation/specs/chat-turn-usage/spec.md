# Spec Delta

## RENAMED Requirements

- FROM: `### Requirement: Usage rows are retained for 60 days`
- TO: `### Requirement: Usage rows are retained for 90 days`

## MODIFIED Requirements

### Requirement: Usage rows are retained for 90 days
Usage rows SHALL survive restart and SHALL be retained for at least 90 days after the turn ended; older rows MAY be pruned. Killing, archiving, or restoring a session SHALL NOT remove its usage rows.

#### Scenario: A killed session's usage
- **WHEN** a session is killed a day after its turns ran
- **THEN** its usage rows remain and still count toward its team

#### Scenario: Restart
- **WHEN** the server restarts
- **THEN** usage rows recorded before it are still present

#### Scenario: Extended history
- **WHEN** a completed turn's usage is 75 days old
- **THEN** its usage remains available to outcome analysis

#### Scenario: Older pruned history cannot be restored
- **WHEN** the retention extension is enabled after older rows were already pruned
- **THEN** those rows remain unavailable and analyses report the historical coverage gap
