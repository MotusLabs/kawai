# Spec Delta

## ADDED Requirements

### Requirement: Release artifacts publish SHA256 checksums
The release publish job SHALL upload a SHA256 checksum file on the GitHub Release covering every platform tarball it publishes. The publish job MUST fail rather than create a release whose checksum file is missing or does not list every tarball.

#### Scenario: Checksums accompany the release
- **WHEN** a `v*` tag triggers `release.yml` and the build job succeeds
- **THEN** the GitHub Release carries a checksum file with one SHA256 entry per platform tarball, each matching its tarball's content

#### Scenario: Incomplete checksums block publishing
- **WHEN** a checksum cannot be computed for one of the platform tarballs
- **THEN** the publish job fails and no release is created
