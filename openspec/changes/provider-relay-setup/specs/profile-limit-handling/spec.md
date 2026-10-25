## ADDED Requirements

### Requirement: Connection failures are diagnostics, never limits
The existing limit predicate SHALL run first and unchanged: `rate_limit`,
`billing_error`, `overloaded`, HTTP 429, and HTTP 402 (credit window)
record limits on any status code, a 403 carrying a limit class included.
Only failures the predicate does not treat as limits SHALL be classified as
connection diagnostics, and no diagnostic SHALL record a limit event, start
a cooldown, or park, forward, or release work.

#### Scenario: A relay 403 cools nothing
- **WHEN** a session's model request fails with a relay 403 that carries no limit error class
- **THEN** no limit event is recorded, the profile does not cool, and the failure is classified as a connection diagnostic

#### Scenario: A limit-shaped 403 cools as before
- **WHEN** a request fails with a 403 carrying a `rate_limit` error class
- **THEN** the existing limit event records exactly as before and no diagnostic class applies

#### Scenario: The limit table is unchanged
- **WHEN** a turn fails with HTTP 429
- **THEN** the existing limit event records exactly as before
