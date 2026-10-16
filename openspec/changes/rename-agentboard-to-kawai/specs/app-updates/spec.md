## MODIFIED Requirements

### Requirement: Update install verifies the tarball before extracting
Applying an update SHALL download the release tarball for the running platform and verify that tarball's SHA256 against an entry in the release's published checksum file **before** extracting it and before any write to the live install root. The tarball SHALL be `kawai-<platform>.tar.gz`. A mismatch, a missing checksum file, or a missing entry for that tarball MUST refuse the update and leave the running install unchanged. There is no alternate acceptance path.

#### Scenario: Checksum mismatch refuses the update
- **WHEN** the downloaded tarball's SHA256 does not match its published entry
- **THEN** the update stops before extract and the existing install is left unchanged

#### Scenario: Missing checksum file refuses the update
- **WHEN** the target release has no checksum file, or the file has no entry for the platform tarball
- **THEN** the update stops with an error naming the missing checksum and the existing install is left unchanged

#### Scenario: Matching checksum proceeds
- **WHEN** the downloaded tarball's SHA256 matches its published entry
- **THEN** the update proceeds to extract into a staging location outside the live install root

#### Scenario: Kawai tarball is downloaded
- **WHEN** the renamed build updates on `linux-x64`
- **THEN** it downloads and verifies `kawai-linux-x64.tar.gz`

### Requirement: Update install places both installed paths
A successful update SHALL place the new `kawai` executable and the new `dist/client` frontend bundle in the discovered install root. An install root whose executable is the legacy `bin/agentboard` SHALL be accepted, and the update SHALL place the new executable at both `bin/kawai` and `bin/agentboard` so existing service definitions keep starting it. Because `dist/client` is a directory, the update MUST NOT assume it is replaceable by a single rename over a non-empty directory.

#### Scenario: Both paths are replaced
- **WHEN** an update completes successfully against an install root
- **THEN** the install root's `bin/kawai` and `dist/client` both come from the new release

#### Scenario: Legacy install root is updated in place
- **WHEN** an update runs from `~/.agentboard/app/bin/agentboard`
- **THEN** `~/.agentboard/app/bin/agentboard`, `~/.agentboard/app/bin/kawai`, and `~/.agentboard/app/dist/client` all come from the new release, and the service restarts on it

#### Scenario: Partial layout is refused
- **WHEN** the discovered install root does not contain the expected binary and client bundle paths
- **THEN** the update is refused with an error naming the unexpected layout

#### Scenario: Unknown binary name is refused
- **WHEN** the compiled binary runs under a name other than `kawai` or `agentboard`
- **THEN** the update is refused with an error naming the unexpected layout

### Requirement: Source checkouts install the release binary without rebuilding
When discovery finds a newer release while running from source, the update action SHALL install the release binary into the user's Kawai application directory (`~/.kawai/app`) and MUST NOT modify the git working tree or rebuild from source.

#### Scenario: Source install lands the binary
- **WHEN** the update action runs while the server is executing from a source checkout
- **THEN** the release binary and client bundle are installed under `~/.kawai/app` as `bin/kawai` and `dist/client`

#### Scenario: Git tree is untouched
- **WHEN** the update action runs while the server is executing from a source checkout
- **THEN** no tracked or untracked file in the checkout is created, modified, or deleted
