# spec-coverage Specification

## Purpose
Ties each spec scenario to the tests that cover it, so that coverage is a checked fact of the repository rather than a claim in a result or a review.

## Requirements

### Requirement: Tests name the scenarios they cover
A test MAY name each spec scenario it covers with a comment line, `// @covers: <capability> › <requirement> › <scenario>`, directly above its `test` or `it` call.

The unit suite SHALL fail, naming the file and line, when an annotation either:
- names no scenario of the main specs or of an active change's delta specs; or
- is not directly above a test.

It SHALL also fail, naming the spec file and line, when a requirement or scenario name in those specs contains ` › `.

#### Scenario: Annotation resolves
- **WHEN** an annotation names a scenario defined in `openspec/specs/`
- **THEN** the suite counts that test as covering the scenario

#### Scenario: Annotation for an active change
- **WHEN** an annotation names a scenario defined only in an active change's delta spec
- **THEN** the suite accepts it

#### Scenario: Stale annotation
- **WHEN** a scenario is renamed and an annotation still names it by the old name, which an archived change's delta still holds
- **THEN** the suite fails, naming the annotation's file and line

#### Scenario: Annotation away from a test
- **WHEN** an annotation is followed by something other than a test call, comments and blank lines aside
- **THEN** the suite fails, naming the file and line

#### Scenario: Name containing the separator
- **WHEN** a requirement or scenario name in a main spec or an active change's delta contains ` › `
- **THEN** the suite fails, naming the spec file and line

### Requirement: Newly archived changes have covered scenarios
This requirement applies to every change archived on or after the coverage start date and not listed as exempt. Each scenario of its ADDED or MODIFIED delta requirements that still exists in the main specs SHALL be covered by at least one annotation.

The unit suite SHALL fail, naming each uncovered scenario and its change. Every exempt entry SHALL name an existing active or archived change.

#### Scenario: Covered archive
- **WHEN** a change is archived after the start date, and every scenario of its delta has an annotated test
- **THEN** the suite passes

#### Scenario: Uncovered scenario
- **WHEN** an archived change's delta defines a scenario that no annotation covers
- **THEN** the suite fails, naming the scenario and the change

#### Scenario: Older archives
- **WHEN** a change was archived before the start date
- **THEN** its scenarios are not required to be covered

#### Scenario: Exempt change
- **WHEN** a change is listed as exempt
- **THEN** its scenarios are not required to be covered

#### Scenario: Stale exemption
- **WHEN** an exempt entry names no existing active or archived change
- **THEN** the suite fails, naming the entry

#### Scenario: Scenario since removed or renamed
- **WHEN** a later change removed or renamed a requirement that an archived delta defined
- **THEN** that requirement's scenarios are not required under their old names
