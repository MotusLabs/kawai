# Spec Delta

## Purpose

Discover newer kawai releases, surface them in the running dashboard, and apply an update in place across bare, systemd, and launchd deployments.

## ADDED Requirements

### Requirement: Update discovery compares base versions
The server SHALL compare the latest GitHub Release's `MAJOR.MINOR.PATCH` base against the running build's base and SHALL report an update only when the latest base is greater. A newer PR-suffixed build of the same base MUST NOT count as an update, and a running build at or ahead of the latest base MUST NOT report one.

#### Scenario: Base version bump is an update
- **WHEN** the running build is `1.0.0-321` and the latest release is `1.1.0-12`
- **THEN** the server reports an update to `1.1.0-12`

#### Scenario: Newer build of the same base is not an update
- **WHEN** the running build is `1.0.0-321` and the latest release is `1.0.0-400`
- **THEN** the server reports no update

#### Scenario: Running build is ahead of the latest release
- **WHEN** the running build is `1.1.0-3` and the latest release is `1.0.0-400`
- **THEN** the server reports no update

### Requirement: Update checks fail silent
Update discovery SHALL run on server startup and periodically thereafter, and MUST NOT change the UI when the network is unavailable, the releases API returns an error, or no newer release exists.

#### Scenario: Offline check produces no signal
- **WHEN** a check cannot reach the releases API
- **THEN** the UI is unchanged and no error is shown

#### Scenario: No newer release produces no signal
- **WHEN** a check succeeds and the latest base is not greater than the running base
- **THEN** no update chip is shown

### Requirement: Update availability appears as a persistent header chip
While an update is available, the header SHALL show a small persistent chip naming the target version. The chip MUST NOT be a transient toast, and it SHALL disappear once the running build's base is current.

#### Scenario: Chip appears when an update is found
- **WHEN** discovery reports an update to `1.1.0-12`
- **THEN** the header shows a persistent chip naming `1.1.0`

#### Scenario: Chip is not a toast
- **WHEN** the chip has been visible longer than a transient notification timeout
- **THEN** it is still shown

#### Scenario: Chip clears after a successful update
- **WHEN** the server restarts on a build whose base matches the latest release
- **THEN** the chip is not shown

### Requirement: Update install verifies checksums before replacing files
Applying an update SHALL download the release tarball for the running platform, extract it to a staging location, and verify its SHA256 against the release's published checksum file before any installed file is replaced. A failed or missing checksum MUST abort the update and leave the running install unchanged.

#### Scenario: Checksum mismatch aborts the update
- **WHEN** the downloaded tarball's SHA256 does not match the published checksum
- **THEN** the update stops and the existing install is left unchanged

#### Scenario: Matching checksum proceeds
- **WHEN** the downloaded tarball's SHA256 matches the published checksum
- **THEN** the update proceeds to replace installed files

### Requirement: Update install replaces both the binary and the client bundle
A successful update SHALL replace both the installed `agentboard` executable and its `dist/client` frontend bundle in the discovered install root. The running process MAY continue serving the previous build until it is restarted.

#### Scenario: Both paths are replaced
- **WHEN** an update is applied to an install root
- **THEN** the install root's `bin/agentboard` and `dist/client` both come from the new release

#### Scenario: Partial layout is refused
- **WHEN** the discovered install root does not contain the expected binary and client bundle paths
- **THEN** the update is refused with an error naming the unexpected layout

### Requirement: Update restarts the running deployment
After replacing files, the update action SHALL restart the running server so the new build takes over: the systemd unit for a systemd deployment, the launchd agent for a launchd deployment, and the current process otherwise.

#### Scenario: Systemd deployment restarts its unit
- **WHEN** the update completes on a systemd-managed server
- **THEN** its service unit is restarted and the new build serves subsequent requests

#### Scenario: Launchd deployment restarts its agent
- **WHEN** the update completes on a launchd-managed server
- **THEN** its launch agent is restarted and the new build serves subsequent requests

#### Scenario: Bare deployment restarts in place
- **WHEN** the update completes on a server with no service manager
- **THEN** the new binary takes over the server's port without requiring a manual re-download

### Requirement: Source checkouts install the release binary without rebuilding
When discovery finds a newer release while running from source, the update action SHALL install the release binary into the user's agentboard application directory and MUST NOT modify the git working tree or rebuild from source.

#### Scenario: Source install lands the binary
- **WHEN** the update action runs while the server is executing from a source checkout
- **THEN** the release binary and client bundle are installed under the agentboard application directory

#### Scenario: Git tree is untouched
- **WHEN** the update action runs while the server is executing from a source checkout
- **THEN** no tracked or untracked file in the checkout is created, modified, or deleted

### Requirement: Service installers run the release binary
The systemd and launchd install scripts SHALL install and start the release binary rather than a source checkout's `bun run start`, and SHALL configure restart behavior such that a completed update can restart the deployment.

#### Scenario: Systemd unit runs the binary
- **WHEN** the systemd install script completes
- **THEN** the enabled unit's start command is the installed release binary and the service comes back after a stop

#### Scenario: Launchd agent runs the binary
- **WHEN** the launchd install script completes
- **THEN** the loaded agent's program is the installed release binary and the agent comes back after a kick
