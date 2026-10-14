# Spec Delta

## ADDED Requirements

### Requirement: Codex limit failures are recorded as limit events
A Codex turn failing on a usage, rate, spend, credit, or overload limit SHALL record a final limit event. Its reset SHALL be the latest known reset among applicable exhausted windows; cooldown and parked-work resume SHALL use that reset. Non-exhausted windows SHALL NOT extend it. Codex retries SHALL record non-final events only. Other failures SHALL NOT record limit events.

#### Scenario: Usage limit ends the turn
- **WHEN** a Codex member's turn fails because its plan's usage limit was reached and the weekly window resets in 2 days
- **THEN** a final limit event is recorded with that reset time, and the message it was handling is resolved as park, release, or forward

#### Scenario: Multiple exhausted windows
- **WHEN** a Codex turn fails with both the five-hour and weekly windows exhausted, resetting in 1 hour and 2 days respectively
- **THEN** the final limit event and shared-home cooldown use the 2-day reset, and if the work is parked its resume is scheduled for that reset rather than the five-hour reset

#### Scenario: Only one exhausted window
- **WHEN** a Codex turn fails with the five-hour window exhausted and resetting in 1 hour, while the weekly window is below its limit and resets in 2 days
- **THEN** the final limit event and cooldown use the 1-hour reset

#### Scenario: Unrelated failure
- **WHEN** a Codex turn fails because the context window was exceeded
- **THEN** no limit event is recorded

### Requirement: Codex limits cool every profile sharing the login
A Codex limit event SHALL be recorded for every Codex profile whose Codex home is the same as the limited session's, because those profiles share one login and one plan. Each of them SHALL then cool down under the existing cooldown rules. Claude profiles and Codex profiles on other homes SHALL NOT be affected.

#### Scenario: Two profiles on one home
- **WHEN** `codex` and `codex-fast` both use `~/.codex` and a `codex` member hits its usage limit
- **THEN** both profiles cool down, and group mail skips members on either one

#### Scenario: Separate homes
- **WHEN** `codex` uses `~/.codex`, `codex-2` uses `~/.codex-2`, and a `codex` member hits its limit
- **THEN** only `codex` cools down

#### Scenario: Forwarding avoids the shared login
- **WHEN** work from a limited `codex` member is forwarded to a group with members on `codex-fast` and `default`
- **THEN** a `default` member receives it
