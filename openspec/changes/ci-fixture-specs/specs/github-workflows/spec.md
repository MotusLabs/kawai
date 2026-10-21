# Spec Delta

## ADDED Requirements

### Requirement: CI runs every fixture-gated e2e spec
The CI fixture e2e step SHALL run every spec Playwright collects under `tests/e2e/`, at any depth, that is gated on the development chat fixture. A script SHALL list these specs from their own gate. When it finds none, it SHALL exit non-zero and fail the step.

#### Scenario: New fixture spec
- **WHEN** a pull request adds a spec gated on the fixture
- **THEN** CI's fixture step runs it, with no workflow edit

#### Scenario: Nested fixture spec
- **WHEN** a spec gated on the fixture sits in a subdirectory of `tests/e2e/`
- **THEN** CI's fixture step runs it

#### Scenario: Specs outside the fixture
- **WHEN** a spec sets the fixture variable to `0`, or is gated on the real-model opt-in
- **THEN** the fixture step does not run it

#### Scenario: No gated spec found
- **WHEN** the script finds no spec gated on the fixture
- **THEN** it exits non-zero, and the fixture step fails without running Playwright

### Requirement: The unit suite guards the fixture list
The unit suite SHALL fail, naming the step, configuration, or file at fault, in each of these cases:
- the fixture step passes Playwright anything besides the script's output and allowed options;
- the fixture variable appears elsewhere in the workflow;
- the Playwright configuration collects other files than the script reads;
- a file under `tests/` without the gate uses the fixture variable in code other than to set it to `0`.

#### Scenario: Literal list in the workflow
- **WHEN** the workflow's fixture step names spec files itself, by path, by bare file name, or by the `tests/e2e` directory
- **THEN** the unit suite fails, naming the step

#### Scenario: Output not passed to Playwright
- **WHEN** the workflow's fixture step assigns the script's output but does not pass it to Playwright
- **THEN** the unit suite fails, naming the step

#### Scenario: Narrowing option
- **WHEN** the workflow's fixture step passes Playwright an option outside the allowed ones, such as `--grep`
- **THEN** the unit suite fails, naming the step

#### Scenario: Fixture variable elsewhere in the workflow
- **WHEN** another step, or a job's environment, sets the fixture variable
- **THEN** the unit suite fails, naming where it appears

#### Scenario: Playwright collects differently
- **WHEN** the Playwright configuration changes its test directory, sets a test match or ignore pattern, or defines projects
- **THEN** the unit suite fails, naming the configuration

#### Scenario: Unrecognized use of the variable
- **WHEN** a spec without the gate, or a helper under `tests/`, reads the fixture variable in code
- **THEN** the unit suite fails, naming the file
