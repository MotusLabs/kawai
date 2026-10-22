# Spec Delta

## ADDED Requirements

### Requirement: CI runs every fixture-gated e2e spec
The CI fixture e2e step SHALL run every spec file that has a test Playwright runs only with the development chat fixture on. A script SHALL find these files from Playwright's own listing of the suite, taken with the fixture off and on. When a listing fails, or no file is found, the script SHALL exit non-zero and fail the step.

#### Scenario: New fixture spec
- **WHEN** a pull request adds a spec whose tests Playwright skips without the fixture
- **THEN** CI's fixture step runs it, with no workflow edit

#### Scenario: Nested or describe-level gate
- **WHEN** a spec gated on the fixture sits in a subdirectory of `tests/e2e/`, or gates inside a `describe` block
- **THEN** CI's fixture step runs it

#### Scenario: Specs outside the fixture
- **WHEN** a spec sets the fixture variable to `0`, or Playwright skips its tests both with and without the fixture
- **THEN** the fixture step does not run it

#### Scenario: Listing fails or finds nothing
- **WHEN** a listing exits non-zero, reports a spec that fails to load, or is not in the shape the script reads, or no file is found
- **THEN** the script exits non-zero, and the fixture step fails without running Playwright

### Requirement: The unit suite guards the fixture list
The unit suite SHALL fail, naming the step, job, or file at fault, when:
- the fixture step passes Playwright anything besides the script's output and allowed options and environment;
- the fixture step holds anything besides its name and run, or its job continues on error;
- the fixture variable appears elsewhere in the workflow;
- a file under `tests/` that the script does not list refers to the variable other than to set it to `0`.

#### Scenario: Literal list in the workflow
- **WHEN** the workflow's fixture step names spec files itself, by path, by bare file name, or by the `tests/e2e` directory
- **THEN** the unit suite fails, naming the step

#### Scenario: Output not passed to Playwright
- **WHEN** the workflow's fixture step assigns the script's output but does not pass it to Playwright
- **THEN** the unit suite fails, naming the step

#### Scenario: Narrowing option
- **WHEN** the workflow's fixture step passes Playwright an option outside the allowed ones, such as `--grep`
- **THEN** the unit suite fails, naming the step

#### Scenario: Conditional or failure-tolerant step
- **WHEN** the fixture step gains a condition, `continue-on-error`, or another shell, or its job gains `continue-on-error`
- **THEN** the unit suite fails, naming the step or the job

#### Scenario: Fixture variable elsewhere in the workflow
- **WHEN** another step, or a job's environment, sets the fixture variable
- **THEN** the unit suite fails, naming where it appears

#### Scenario: Gate the listing cannot see
- **WHEN** a spec reads the fixture variable inside a hook or a test body, or a helper reads it, and the script does not list the file
- **THEN** the unit suite fails, naming the file

#### Scenario: Spec the configuration stops collecting
- **WHEN** the Playwright configuration stops collecting a spec that refers to the fixture variable
- **THEN** the unit suite fails, naming the spec
