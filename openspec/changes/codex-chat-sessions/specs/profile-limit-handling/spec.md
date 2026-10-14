# Spec Delta

## ADDED Requirements

### Requirement: Codex limit failures are recorded as limit events
A Codex chat turn that fails because a usage limit, rate limit, spend or credit limit, or server overload was reached SHALL record a final limit event, with the reset time Codex reports for the reached window when known. Codex retrying a request on its own SHALL record a non-final event only. Other Codex failures SHALL NOT record limit events.

#### Scenario: Usage limit ends the turn
- **WHEN** a Codex member's turn fails because its plan's usage limit was reached and the weekly window resets in 2 days
- **THEN** a final limit event is recorded with that reset time, and the message it was handling is resolved as park, release, or forward

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
