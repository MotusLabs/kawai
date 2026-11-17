## Purpose

Define the observable behavior of agentboard's GitHub Actions workflows: every job runs on GitHub-hosted runners, is time-bounded, resolves dependencies through a registry setup that probes the cluster npm proxy and falls back to the public registry, and produces the same release artifacts as before.

## Requirements

### Requirement: All jobs run on GitHub-hosted runners
Every job in `ci.yml`, `create-release-tag.yml`, `release.yml`, and `local-runner-test.yml` SHALL run on GitHub-hosted `ubuntu-latest` runners and MUST NOT select a self-hosted pool label — the local Kubernetes pools are reserved for the organization's private repositories.

#### Scenario: CI runs on hosted runners
- **WHEN** a push or pull request triggers `ci.yml`
- **THEN** both the quality-gates job and the e2e job run on `ubuntu-latest`

#### Scenario: Release runs on hosted runners
- **WHEN** a `v*` tag triggers `release.yml`
- **THEN** the build and publish jobs run on `ubuntu-latest`

#### Scenario: Tag creation runs on hosted runners
- **WHEN** a PR merged into master triggers `create-release-tag.yml`
- **THEN** the tag job runs on `ubuntu-latest`

### Requirement: Release binaries cross-compile from a single Linux job
The release build job SHALL produce all four platform binaries (`darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`) by cross-compiling on one Linux runner, and each artifact SHALL contain the platform binary plus the frontend bundle, packaged exactly as the current matrix packages them.

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

### Requirement: e2e suite runs with its system dependencies satisfied
The e2e job MUST ensure tmux and a Playwright-capable Chromium (with its system dependencies) are available on the runner — installed by the workflow when absent, or verified present — before running the Playwright suite.

#### Scenario: e2e resolves its system dependencies
- **WHEN** the e2e job runs
- **THEN** tmux is available on PATH, Playwright's Chromium is installed with its system dependencies, and the Playwright suite completes

#### Scenario: Missing system dependency fails explicitly
- **WHEN** tmux or Chromium's system dependencies are unavailable on the runner image and cannot be installed by the job
- **THEN** the job fails with an error naming the missing dependency rather than failing opaquely inside the test suite

### Requirement: Environment self-test workflow is available on demand
A dispatch-only workflow SHALL exist that verifies the workflow environment: it reports whether the runner is isolated (no Docker or containerd socket, no Kubernetes service-account token) and confirms that Bun installs and runs through the shared setup action.

#### Scenario: Operator dispatches the self-test
- **WHEN** the operator dispatches the self-test workflow
- **THEN** the job reports runner isolation status and a working Bun installation, and fails with a named violation if any isolation check trips

### Requirement: Every merge into master cuts a PR-numbered release tag
`create-release-tag.yml` SHALL tag every merged pull request with `v<base>-<PR number>`, where `<base>` is the plain `MAJOR.MINOR.PATCH` version in `package.json` and `<PR number>` is the merged PR's number — a semver prerelease identifier that compares numerically, so tags sort in merge order. The workflow SHALL refuse to tag when the base version already carries a prerelease or build suffix, and SHALL tag the merge commit the PR produced rather than master's current head.

#### Scenario: Merged PR is tagged
- **WHEN** PR 321 merges into master while `package.json` reads `1.0.0`
- **THEN** the workflow creates and pushes tag `v1.0.0-321` on that PR's merge commit, which triggers `release.yml`

#### Scenario: Release happens without a version bump
- **WHEN** a PR that does not change `package.json` merges into master
- **THEN** it still receives its own tag and a full four-platform GitHub Release

#### Scenario: Base version already carries a suffix
- **WHEN** `package.json` reads a non-plain version such as `1.0.0-rc1`
- **THEN** the workflow fails with an error naming the version rather than producing a double-suffixed tag

#### Scenario: Workflow re-run does not duplicate a tag
- **WHEN** the workflow re-runs for a PR whose tag already exists
- **THEN** it skips tag creation and succeeds

### Requirement: Released binaries report their own version
The release build SHALL inject the tag's version into every platform binary at compile time, and the binary SHALL report it in its `startup_state` log line. The build job MUST fail if the booted binary does not report the expected version.

#### Scenario: Binary names its release
- **WHEN** the binary built from tag `v1.0.0-321` starts
- **THEN** its `startup_state` log line carries version `1.0.0-321`

#### Scenario: Injection silently fails
- **WHEN** the version fails to substitute into the compiled binary
- **THEN** the boot test fails with an error naming the expected version, and no release is published

### Requirement: Release publishes only to GitHub Releases
The release workflow SHALL publish release artifacts exclusively to this repository's GitHub Releases — the four platform tarballs and binaries — and MUST NOT publish to npmjs.org, GitHub Packages, or any external registry or tap. The publish job SHALL need no registry credentials beyond the repository's own `contents: write` permission.

#### Scenario: Tag push creates a GitHub Release
- **WHEN** a `v*` tag is pushed and the build job succeeds
- **THEN** the repository's GitHub Release carries the four platform tarballs and binaries, and nothing is published to any npm registry

#### Scenario: No external registry is contacted
- **WHEN** the publish job runs
- **THEN** it contains no `npm publish`, no Homebrew tap update, and requests only `contents: write` permissions

### Requirement: Release artifacts publish SHA256 checksums
The release publish job SHALL upload a SHA256 checksum file on the GitHub Release covering every platform tarball it publishes. The publish job MUST fail rather than create a release whose checksum file is missing or does not list every tarball.

#### Scenario: Checksums accompany the release
- **WHEN** a `v*` tag triggers `release.yml` and the build job succeeds
- **THEN** the GitHub Release carries a checksum file with one SHA256 entry per platform tarball, each matching its tarball's content

#### Scenario: Incomplete checksums block publishing
- **WHEN** a checksum cannot be computed for one of the platform tarballs
- **THEN** the publish job fails and no release is created

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

### Requirement: Pull-request CI runs the unit suite once
On pull requests the quality-gates job SHALL run the unit suite exactly once, without the coverage pass. On pushes to master it SHALL also run the coverage pass and upload the coverage artifact. Coverage MUST NOT gate either run.

#### Scenario: Pull request
- **WHEN** CI runs for a pull request
- **THEN** the quality-gates job runs the unit suite once and runs no coverage pass

#### Scenario: Push to master
- **WHEN** CI runs for a push to master
- **THEN** the quality-gates job runs the unit suite and the coverage pass, and uploads the coverage artifact

### Requirement: CI runs every fixture-gated e2e spec
The CI fixture e2e step SHALL run every spec file that has a test Playwright runs only with the development chat fixture on. A script SHALL find these files from Playwright's own listing of the suite, taken with the fixture off and on. When a listing fails, or no file is found, the script SHALL exit non-zero and fail the step.

#### Scenario: New fixture spec
- **WHEN** a pull request adds a spec whose tests Playwright skips without the fixture
- **THEN** CI's fixture step runs it, with no workflow edit

#### Scenario: Nested or describe-level gate
- **WHEN** a spec gated on the fixture sits in a subdirectory of `tests/e2e/`, or gates inside a `describe` block
- **THEN** CI's fixture step runs it

#### Scenario: Specs outside the fixture
- **WHEN** a spec sets the fixture variable to `0`, or Playwright skips its tests both with and without the fixture
- **THEN** the fixture step does not run it

#### Scenario: Listing fails or finds nothing
- **WHEN** a listing exits non-zero, reports a spec that fails to load, or is not in the shape the script reads, or no file is found
- **THEN** the script exits non-zero, and the fixture step fails without running Playwright

### Requirement: The unit suite guards the fixture list
The unit suite SHALL fail, naming the step, job, or file at fault, when:
- the fixture step passes Playwright anything besides the script's output and allowed options and environment;
- the fixture step holds anything besides its name and run, or its job continues on error;
- the fixture variable appears elsewhere in the workflow;
- a file under `tests/` that the script does not list refers to the variable other than to set it to `0`.

#### Scenario: Literal list in the workflow
- **WHEN** the workflow's fixture step names spec files itself, by path, by bare file name, or by the `tests/e2e` directory
- **THEN** the unit suite fails, naming the step

#### Scenario: Output not passed to Playwright
- **WHEN** the workflow's fixture step assigns the script's output but does not pass it to Playwright
- **THEN** the unit suite fails, naming the step

#### Scenario: Narrowing option
- **WHEN** the workflow's fixture step passes Playwright an option outside the allowed ones, such as `--grep`
- **THEN** the unit suite fails, naming the step

#### Scenario: Conditional or failure-tolerant step
- **WHEN** the fixture step gains a condition, `continue-on-error`, or another shell, or its job gains `continue-on-error`
- **THEN** the unit suite fails, naming the step or the job

#### Scenario: Fixture variable elsewhere in the workflow
- **WHEN** another step, or a job's environment, sets the fixture variable
- **THEN** the unit suite fails, naming where it appears

#### Scenario: Gate the listing cannot see
- **WHEN** a spec reads the fixture variable inside a hook or a test body, or a helper reads it, and the script does not list the file
- **THEN** the unit suite fails, naming the file

#### Scenario: Spec the configuration stops collecting
- **WHEN** the Playwright configuration stops collecting a spec that refers to the fixture variable
- **THEN** the unit suite fails, naming the spec
