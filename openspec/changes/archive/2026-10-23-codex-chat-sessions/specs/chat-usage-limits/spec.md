# Spec Delta

## ADDED Requirements

### Requirement: Codex rate-limit windows are kept per Codex home
For Codex chat sessions, the system SHALL keep the latest Codex rate-limit report per Codex home, not per profile, so every profile and session sharing a home shows the same report. Codex pushes the reports during a session, and the system SHALL read one on demand when a home with a started agent holds none. Reports SHALL stay in memory only, as Claude reports do.

#### Scenario: Two profiles on one home
- **WHEN** two Codex profiles share `~/.codex` and a session of one receives a rate-limit update
- **THEN** sessions of both profiles show that update

#### Scenario: Windows before the first message
- **WHEN** a client attaches to a Codex chat whose home holds no report
- **THEN** the usage bar shows the Codex windows without waiting for a turn

#### Scenario: Claude reports are separate
- **WHEN** a Claude profile and a Codex profile both have reports
- **THEN** each session shows only its own runtime's windows

### Requirement: Codex windows render with their own identity
Each Codex rate-limit window SHALL render as its own usage-bar meter with its percent used and local reset time, labelled by its duration (for example, 5-hour or weekly) and, when Codex names the limit, by that name. A reached limit SHALL render as limited. A window without a usable percentage SHALL be dropped while the others still render.

#### Scenario: Primary and secondary windows
- **WHEN** a Codex report carries a 300-minute window at 40% and a 10080-minute window at 12%
- **THEN** the usage bar shows a 5-hour meter at 40% and a weekly meter at 12% with local reset times

#### Scenario: Limit reached
- **WHEN** a Codex report says a rate limit was reached
- **THEN** the usage bar shows the limited state
