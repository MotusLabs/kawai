# Spec Delta

## Purpose

Distribute one versioned agent runtime from Kawai so Kawai and external headless consumers install and exercise the same implementation with separately installed CLIs.

## ADDED Requirements

### Requirement: The runtime is an ESM package with types
The package SHALL be named @motuslabs/agent-runtime and provide ESM entry points with TypeScript declarations for Bun >=1.3.0. The packed artifact SHALL be usable outside the repository and SHALL contain no imports of Kawai application modules or undeclared workspace paths.

#### Scenario: Clean external consumer
- **WHEN** a new Bun project installs the packed package with its documented dependencies
- **THEN** its headless imports and type checks succeed without Kawai source files, root aliases or server configuration

### Requirement: Kawai consumes the shared implementation
Kawai SHALL construct its Claude and Codex drivers from the package using application adapters. It SHALL retain existing chat, profile, permission, mailbox, audit, history and usage behavior. A second in-tree driver implementation SHALL NOT remain as an alternative path.

#### Scenario: Existing Kawai workflows
- **WHEN** Kawai runs with the package dependency
- **THEN** its build and unit suite pass and affected Claude, Codex, approval, question, profile and resume workflows retain their specified behavior

### Requirement: CLI binaries are installed separately
The runtime and its dependency recipe SHALL NOT bundle or install Claude or Codex CLI binaries. The Claude SDK's platform CLI packages SHALL use the documented no-CLI override approach at the consumer root. Executable paths SHALL be supplied or resolved from the explicit supplied PATH, never from ambient host configuration.

#### Scenario: Installation without native CLI packages
- **WHEN** a clean Bun project installs the runtime, pinned SDK and documented empty-stub overrides
- **THEN** no Claude platform executable is installed and neither CLI is downloaded or launched by installation

#### Scenario: Missing executable
- **WHEN** the caller requests a runtime whose separately installed executable is unavailable
- **THEN** that runtime reports an actionable error while importing the package and using the other runtime remain possible

### Requirement: Releases have an independent compatibility contract
Runtime releases SHALL have semver versions and a changelog separate from Kawai application build versions. Every breaking public API change SHALL increment the major version, including a change after an initial 0.x release. Released versions SHALL be immutable and correspond to a tested source commit.

#### Scenario: Initial and breaking releases
- **WHEN** the first compatible runtime is released as 0.1.0 and a later release breaks its documented API
- **THEN** the breaking release uses a new major version and documents migration steps

### Requirement: Kawai CI publishes to GitHub Packages
Kawai's package-release CI SHALL publish the runtime and required no-CLI companion to npm.pkg.github.com under the @motuslabs scope after the exact release commit passes its required checks. Untrusted pull requests SHALL NOT receive publication credentials or trigger publication.

#### Scenario: Version mismatch or failed checks
- **WHEN** a release tag disagrees with the package version or a required acceptance check fails
- **THEN** no package version is published

### Requirement: Installation access is demonstrated
The released runtime and required companion SHALL be installable with an authorized read:packages token and from MotusLabs/smartfactory Actions using that repository's GITHUB_TOKEN with package-read permission. Missing repository access SHALL be identified explicitly with the required package setting or token fallback.

#### Scenario: SmartFactory Actions install
- **WHEN** MotusLabs/smartfactory has Read access through each package's Manage Actions access setting
- **THEN** a clean job using its own GITHUB_TOKEN installs the released version without a personal publication token

#### Scenario: Local authenticated install
- **WHEN** a caller with package-read access supplies a classic token scoped read:packages through the documented registry configuration
- **THEN** a clean Bun project installs the same released version without embedding a token in source or the lockfile

### Requirement: A headless example proves both runtimes
The distribution SHALL include a minimal headless example and controlled automated tests with no Kawai server modules. Release acceptance SHALL additionally demonstrate real Claude and Codex turns, cooperative interruption, actual forced process exit and resume with retained homes, and usage, rate-limit and quota callback wiring.

#### Scenario: Headless lifecycle demonstration
- **WHEN** the example runs with separately installed supported CLIs and explicitly provided authorized credentials and homes
- **THEN** it runs a turn on each runtime, interrupts a turn, awaits forced exit and resumes the same conversation, printing safe callback output

### Requirement: Documentation covers the complete consumer contract
The README SHALL document every entry point, injected seam, permission option, callback, result, environment helper, stop-receipt scope, resume requirement and installation step. It SHALL include the headless example, CLI compatibility matrix, no-CLI overrides and package access instructions without credentials.

#### Scenario: Consumer implements against documentation
- **WHEN** agent-host implements the documented driver interface with no tools or optional Kawai integrations
- **THEN** it can configure both runtimes and answer requests immediately without relying on undocumented server behavior

