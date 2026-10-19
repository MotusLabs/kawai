# Spec Delta

## ADDED Requirements

### Requirement: Workflows run one pinned Bun version
Every workflow SHALL install the Bun version named in the repository's single version file through the shared setup action, and no workflow or step MAY name a Bun version of its own. Release binaries SHALL embed exactly that version as their runtime.

#### Scenario: CI uses the pinned version
- **WHEN** the version file names 1.4.3 and CI runs on a pull request
- **THEN** both the quality-gates job and the e2e job report Bun 1.4.3 from the shared setup

#### Scenario: Release binaries embed the pinned version
- **WHEN** a release build compiles the platform binaries while the version file names 1.4.3
- **THEN** every binary runs on the Bun 1.4.3 runtime

#### Scenario: Changing the pin moves every workflow together
- **WHEN** a change edits only the version file
- **THEN** CI, the release build, and the self-test workflow all install the new version, with no other workflow edit
