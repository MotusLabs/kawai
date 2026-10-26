## ADDED Requirements

### Requirement: Connection failures are diagnostics, never limits
The existing limit predicate SHALL run first and unchanged in live
sessions: `rate_limit`, `billing_error`, `overloaded`, HTTP 429, and HTTP
402 (credit window) record limits on any status code, a 403 carrying a
limit class included. Only failures the predicate does not treat as limits
SHALL be classified as connection diagnostics, and no diagnostic SHALL
record a limit event, start a cooldown, or park, forward, or release work.

#### Scenario: A relay 403 cools nothing
- **WHEN** a session's model request fails with a relay 403 that carries no limit error class
- **THEN** no limit event is recorded, the profile does not cool, and the failure is classified as a connection diagnostic

#### Scenario: A limit-shaped 403 cools as before
- **WHEN** a request fails with a 403 carrying a `rate_limit` error class
- **THEN** the existing limit event records exactly as before and no diagnostic class applies

#### Scenario: The limit table is unchanged
- **WHEN** a turn fails with HTTP 429
- **THEN** the existing limit event records exactly as before

### Requirement: Connection tests never record limits
The connection test SHALL write no row of any kind. A limit-shaped test
outcome SHALL be reported as the test's limit class, with the reset time
when the response states one, and SHALL record no limit event, cooldown, or
other durable row. Live-session limit recording SHALL be unchanged.

#### Scenario: A test 429 reports and records nothing
- **WHEN** the connection test's request returns 429 with a stated reset time
- **THEN** the test result reports the limit class with that reset time and no limit event or cooldown exists

#### Scenario: A test 402 reports the credit class
- **WHEN** the connection test's request returns 402
- **THEN** the test result reports the credit class and nothing is recorded
