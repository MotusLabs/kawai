# Spec Delta

## ADDED Requirements

### Requirement: A failed real-tmux file is retried once
A failing real-tmux file SHALL NOT stop the remaining real-tmux files. After them, the runner SHALL rerun each failed real-tmux file once, alone. When the main batch passed, at most two real-tmux files failed, and every rerun passed, the unit step SHALL pass. Otherwise the run SHALL fail. A main-batch failure SHALL NOT be retried, and `--no-retry` SHALL disable retries.

#### Scenario: One timing failure
- **WHEN** the main batch passes and one real-tmux file fails, then passes when rerun alone
- **THEN** the unit step passes and the remaining real-tmux files all ran

#### Scenario: The rerun fails too
- **WHEN** a failed real-tmux file fails again when rerun alone
- **THEN** the unit step fails, naming the file and both attempts' failing tests

#### Scenario: Three real-tmux files fail
- **WHEN** three real-tmux files fail in one run
- **THEN** no file is rerun and the unit step fails

#### Scenario: A main-batch failure
- **WHEN** a file in the main batch fails
- **THEN** no file is rerun, no real-tmux file runs, and the unit step fails

#### Scenario: Retries turned off
- **WHEN** the runner is given `--no-retry` and one real-tmux file fails
- **THEN** no file is rerun and the unit step fails

### Requirement: A recorded pass names its retries and case profile
A full pass SHALL record each retried file with its first attempt's failing tests, and the case profile that ran: `reduced` or `full`. Its test list SHALL hold the rerun's tests for a retried file. A record without these fields SHALL read as no retries and an unknown profile. The pre-push hook SHALL accept a pass whatever its retries and profile.

#### Scenario: Pass after a retry
- **WHEN** a full check passes after one real-tmux file was retried
- **THEN** its record names that file and the first attempt's failing tests, and its test list holds the rerun's outcomes

#### Scenario: An older record
- **WHEN** a record written before this change is read
- **THEN** it reads as having no retries and an unknown case profile

#### Scenario: Pushing a reduced pass
- **WHEN** the pushed commit's tree has a recorded pass with the `reduced` profile
- **THEN** the pre-push hook accepts it

### Requirement: Local runs execute a reduced case profile
A test declaring a case count of 50 or more SHALL run the first quarter of its seeded cases, rounded up, in local runs, and the declared count when `CI=true` or when the check is given `--full-properties`. A reduced run SHALL use the same seeds as the first cases of a full run. Test titles SHALL keep the declared count.

#### Scenario: Local run
- **WHEN** a test declaring 300 seeded cases runs locally without `CI=true`
- **THEN** it runs cases 1 to 75 with the seeds the full run uses for them

#### Scenario: CI run
- **WHEN** the same test runs with `CI=true`
- **THEN** it runs all 300 cases

#### Scenario: Full properties on request
- **WHEN** `bun run check --full-properties` runs
- **THEN** every such test runs its declared count and the record's profile is `full`

#### Scenario: A small declared count
- **WHEN** a test declares 40 cases
- **THEN** it runs all 40 locally and in CI

### Requirement: Real-tmux tests do not fail on machine speed
A real-tmux test SHALL NOT assert on a wall-clock duration or a ratio of durations, and a wait inside it SHALL allow at least half of the test's timeout. Durations MAY be printed as diagnostics.

#### Scenario: Throttled reconnect under load
- **WHEN** `throttled-reconnect` runs on a saturated machine and single-attach still transfers under 75% of double-attach's bytes
- **THEN** the test passes, whatever the measured times

#### Scenario: Slow terminal-ready
- **WHEN** `terminal-ready` arrives 20 s after the attach in `output-coalescing`
- **THEN** the test still checks the ordering and passes when the order holds

### Requirement: Test databases start from a migrated template
The runner SHALL migrate one template database per run, and a test that asks for a fresh database SHALL get a copy of it, at the current schema version, with no pre-migration backups. Tests of migrations and backups SHALL keep migrating a new database.

#### Scenario: A fresh test database
- **WHEN** a test asks for a fresh database under the runner
- **THEN** it opens at the current schema version and no backup file is written for it

#### Scenario: A migration test
- **WHEN** a migration test opens a new database
- **THEN** every migration runs and takes its pre-migration backup, as in production

#### Scenario: No runner
- **WHEN** a test asks for a fresh database under a bare `bun test`
- **THEN** it gets a newly migrated database
