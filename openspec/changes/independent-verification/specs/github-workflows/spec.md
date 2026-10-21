# Spec Delta

## ADDED Requirements

### Requirement: CI runs every fixture-gated e2e spec
The CI fixture e2e step SHALL run every spec under `tests/e2e/` that is gated on the development chat fixture. A script SHALL list these specs from their own gate, rather than the workflow naming them.

The unit suite SHALL fail in either case:
- the workflow's fixture step names spec files itself;
- a spec without the gate uses the fixture variable in code other than to set it to `0`.

#### Scenario: New fixture spec
- **WHEN** a pull request adds a spec gated on the fixture
- **THEN** CI's fixture step runs it, with no workflow edit

#### Scenario: Specs outside the fixture
- **WHEN** a spec sets the fixture variable to `0`, or is gated on the real-model opt-in
- **THEN** the fixture step does not run it

#### Scenario: Literal list in the workflow
- **WHEN** the workflow's fixture step names spec files itself
- **THEN** the unit suite fails, naming the step

#### Scenario: Unrecognized use of the variable
- **WHEN** a spec without the gate reads the fixture variable in code
- **THEN** the unit suite fails, naming the spec
