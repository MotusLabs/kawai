# Spec Delta

## ADDED Requirements

### Requirement: Every named change carries an implementation contract
For each registered, unarchived change of the plan, validation SHALL parse the `## Implementation contract` section of the change's `design.md` and report under Intent and implementation strategy. A missing `design.md`, a missing section, or a section that does not parse SHALL be an error of the `implementation-contract` check naming the change and carrying every parser problem with its line. A change that parses SHALL record its contract hash as evidence.

#### Scenario: Missing section
- **WHEN** a plan names a change whose `design.md` has no Implementation contract section
- **THEN** `implementation-contract` reports an error naming that change, and the revision is not Ready

#### Scenario: Malformed section
- **WHEN** a change's Implementation contract section has a scope glob `/etc/**` and no Verification heading
- **THEN** `implementation-contract` reports one error naming the change and both problems with their lines

#### Scenario: Well-formed section
- **WHEN** every change of the plan has a well-formed Implementation contract section
- **THEN** `implementation-contract` reports no error, and each change's contract hash appears as evidence

#### Scenario: Unregistered change is skipped
- **WHEN** a plan names a change that is not registered
- **THEN** `change-registered` reports its error, and `implementation-contract` reports nothing for that change

### Requirement: Reports from earlier checks are out of date
Adding the `implementation-contract` check SHALL raise the checks version, so a report produced before it SHALL read as Out of date and SHALL NOT satisfy approval or Start until the revision is validated again.

#### Scenario: Earlier report after the upgrade
- **WHEN** an approved revision's newest report was produced before the upgrade
- **THEN** the Plans view shows it Out of date naming the checks version, and Start is refused until a new report is Ready

#### Scenario: A running execution is unaffected
- **WHEN** an execution started before the upgrade provisions a change whose `design.md` has no Implementation contract section
- **THEN** the execution keeps running, and the change's task is created without a contract
