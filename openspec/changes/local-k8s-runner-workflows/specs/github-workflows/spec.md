## Purpose

Define the observable behavior of agentboard's GitHub Actions workflows: every job runs on the operator's local Kubernetes runner pool, is time-bounded, resolves dependencies through the cluster npm proxy with public fallback, and produces the same release artifacts as before — with no GitHub-hosted runner minutes consumed.

## ADDED Requirements

### Requirement: All jobs run on the local Kubernetes runner pool
Every job in `ci.yml`, `create-release-tag.yml`, and `release.yml` SHALL select the local Kubernetes runner pool (`runs-on: local-k8s`) and MUST NOT select a GitHub-hosted runner image.

#### Scenario: CI runs on the local pool
- **WHEN** a push or pull request triggers `ci.yml`
- **THEN** both the quality-gates job and the e2e job are dispatched to runners labeled `local-k8s`

#### Scenario: Release build runs on the local pool
- **WHEN** a `v*` tag triggers `release.yml`
- **THEN** the build job runs on a `local-k8s` runner and no job in the workflow requests a hosted macOS or Ubuntu image

#### Scenario: Tag creation runs on the local pool
- **WHEN** a PR merged into master triggers `create-release-tag.yml`
- **THEN** the tag job runs on a `local-k8s` runner

### Requirement: Release binaries cross-compile from a single Linux job
The release build job SHALL produce all four platform binaries (`darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`) by cross-compiling on one Linux `local-k8s` runner, and each artifact SHALL contain the platform binary plus the frontend bundle, packaged exactly as the current matrix packages them.

#### Scenario: All four platforms build on one runner
- **WHEN** the release build job runs
- **THEN** it uploads four artifacts named `agentboard-<platform>`, each containing `bin/agentboard` for that platform and `dist/client`

#### Scenario: Frontend is built once
- **WHEN** the release build job runs
- **THEN** the frontend bundle is built a single time and reused across all four platform artifacts

### Requirement: Every job is time-bounded
Each job in every workflow SHALL declare a `timeout-minutes` value so a hung job cannot occupy a local runner indefinitely.

#### Scenario: Hung job is terminated
- **WHEN** any job exceeds its declared `timeout-minutes`
- **THEN** the runner cancels the job and frees the runner for the next queued run

### Requirement: CI runs are concurrency-safe
`ci.yml` SHALL declare a concurrency group keyed by workflow and ref with `cancel-in-progress: true`, so pushes to the same branch supersede superseded runs instead of queuing behind them on the limited local pool.

#### Scenario: Successive pushes to one branch
- **WHEN** a second push to the same branch triggers `ci.yml` while the first run is in progress
- **THEN** the first run is cancelled and only the second runs

#### Scenario: Different branches do not cancel each other
- **WHEN** CI runs are active for two different branches
- **THEN** neither run cancels the other

### Requirement: Dependency installs use the cluster npm proxy with public fallback
Workflows SHALL install Bun dependencies through a shared setup that points package resolution at the cluster-local npm proxy and MUST fall back to the public npm registry when the proxy does not answer. The fallback MUST be visible in the job log.

#### Scenario: Proxy reachable
- **WHEN** the npm proxy responds to its health endpoint
- **THEN** `bun install` resolves packages through the proxy

#### Scenario: Proxy down
- **WHEN** the npm proxy does not answer
- **THEN** `bun install` still succeeds by resolving through the public registry, and the job log carries a warning naming the proxy

### Requirement: e2e suite runs on the local pool with its system dependencies satisfied
The e2e job SHALL run on the local pool and MUST ensure tmux and a Playwright-capable Chromium (with its system dependencies) are available on the runner — installed by the workflow when absent, or verified present — before running the Playwright suite.

#### Scenario: e2e runs without hosted runners
- **WHEN** the e2e job runs on a `local-k8s` runner
- **THEN** tmux is available on PATH, Playwright's Chromium is installed with its system dependencies, and the Playwright suite completes

#### Scenario: Missing system dependency fails explicitly
- **WHEN** tmux or Chromium's system dependencies are unavailable on the runner image and cannot be installed by the job
- **THEN** the job fails with an error naming the missing dependency rather than failing opaquely inside the test suite

### Requirement: Runner pool self-test is available on demand
A workflow SHALL exist that, on manual dispatch, verifies the local runner pool: that the job executes on a `local-k8s` runner, that the runner is isolated (no Docker or containerd socket, no Kubernetes service-account token), and that Bun installs and runs.

#### Scenario: Operator verifies the pool before migrating
- **WHEN** the operator dispatches the self-test workflow
- **THEN** the job reports runner isolation status and a working Bun installation, and fails with a named violation if any isolation check trips

### Requirement: Release publication chain is unchanged
The release workflow SHALL still publish the four npm platform packages and the main package via OIDC trusted publishing, create the GitHub Release with binary tarballs, and update the Homebrew tap with correct SHA256s — reading from the artifacts the cross-compiled build job uploads.

#### Scenario: Tag push publishes a release
- **WHEN** a `v*` tag is pushed and the build job succeeds
- **THEN** npm receives the main package and all four platform packages at the tagged version, the GitHub Release carries the four tarballs, and the Homebrew formula is updated with matching URLs and SHA256s
