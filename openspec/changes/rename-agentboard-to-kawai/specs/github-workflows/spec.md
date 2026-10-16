## MODIFIED Requirements

### Requirement: Release binaries cross-compile from a single Linux job
The release build job SHALL produce all four platform binaries (`darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`) by cross-compiling on one Linux runner, and each artifact SHALL contain the platform binary plus the frontend bundle, packaged exactly as the current matrix packages them.

#### Scenario: All four platforms build on one runner
- **WHEN** the release build job runs
- **THEN** it uploads four artifacts named `kawai-<platform>`, each containing `bin/kawai` for that platform and `dist/client`

#### Scenario: Frontend is built once
- **WHEN** the release build job runs
- **THEN** the frontend bundle is built a single time and reused across all four platform artifacts

### Requirement: Release artifacts publish SHA256 checksums
The release publish job SHALL upload a SHA256 checksum file on the GitHub Release covering every platform tarball it publishes. The publish job MUST fail rather than create a release whose checksum file is missing or does not list every tarball.

#### Scenario: Checksums accompany the release
- **WHEN** a `v*` tag triggers `release.yml` and the build job succeeds
- **THEN** the GitHub Release carries a checksum file with one SHA256 entry per platform tarball, each matching its tarball's content

#### Scenario: Incomplete checksums block publishing
- **WHEN** a checksum cannot be computed for one of the platform tarballs
- **THEN** the publish job fails and no release is created

#### Scenario: Legacy tarballs are covered
- **WHEN** a release publishes both `kawai-<platform>.tar.gz` and `agentboard-<platform>.tar.gz`
- **THEN** the checksum file has an entry for each of the eight tarballs

## ADDED Requirements

### Requirement: Releases publish legacy-named tarballs during the transition
During the transition window, each release SHALL also publish `agentboard-<platform>.tar.gz` for the four platforms. Each one SHALL contain the same build as its `kawai-<platform>.tar.gz`, packaged as `bin/agentboard` plus `dist/client`, so already-installed updaters that fetch only the legacy name still update.

#### Scenario: Legacy updater finds its tarball
- **WHEN** an installed legacy build checks a release cut during the transition window
- **THEN** that release carries `agentboard-<platform>.tar.gz` for its platform, with `bin/agentboard` and `dist/client`

#### Scenario: Legacy and Kawai tarballs carry the same build
- **WHEN** both tarballs for a platform are extracted
- **THEN** `bin/agentboard` and `bin/kawai` are byte-identical and their `dist/client` trees match
