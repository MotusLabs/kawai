## Why

CI and release builds consume GitHub-hosted runner minutes and queue on shared hosted capacity. The operator already runs a hardened GitHub Actions runner pool on a local Kubernetes cluster (proven by `ru-sh/tg-assistant`), so agentboard's workflows can run there: faster, no per-minute cost, and full control over the environment.

## What Changes

- Re-point every job in `.github/workflows/ci.yml`, `create-release-tag.yml`, and `release.yml` from GitHub-hosted runners (`ubuntu-*`, `macos-latest`) to the local Kubernetes runner pool (`runs-on: local-k8s`).
- Add per-job `timeout-minutes` and CI `concurrency` (cancel-in-progress) — self-hosted runners have no automatic cleanup or queue fairness.
- Add a `setup-bun` composite action (`.github/actions/`) that installs Bun, points installs at the cluster-local npm proxy (Verdaccio), and falls back to the public registry when the proxy is down.
- Collapse the release build matrix: all four targets (`darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`) cross-compile on one Linux runner, since every build is already `bun build --compile --target <triple>`. No macOS hosted runner is needed.
- The e2e job moves to the local runner too; it must make tmux and Playwright Chromium system dependencies work on the runner image (install, or verify pre-installed).
- Add a `local-runner-test.yml` workflow (manual dispatch) that verifies the runner pool serves agentboard's needs: runner isolation (no docker socket, no k8s service account token) and Bun availability.

Confirmed decisions:
- e2e moves to the local runner (system dependencies handled within the workflow; not deferred to hosted runners).
- Release builds cross-compile on `local-k8s` rather than keeping darwin builds on hosted macOS runners.

Assumptions (from the working reference configuration):
- Runner label is `local-k8s`; same cluster as `ru-sh/tg-assistant`, so the Verdaccio proxy at `http://verdaccio.ci-npm.svc.cluster.local:4873` is reachable and the public-registry fallback pattern applies.
- Existing action pins (checkout, upload/download-artifact, setup-node, setup-bun) carry over unchanged.

## Capabilities

### New Capabilities
- `github-workflows`: Observable behavior of agentboard's CI/CD workflows — which runner pool executes each job, that every job is time-bounded and concurrency-safe, that installs route through the registry proxy with public fallback, that release binaries for all four platforms build on the local pool, and that the runner self-test verifies pool health.

### Modified Capabilities
<!-- none: openspec/specs/ is empty; this is the first capability spec -->

## Impact

- `.github/workflows/ci.yml`, `.github/workflows/create-release-tag.yml`, `.github/workflows/release.yml` — runner labels, timeouts, concurrency, release matrix reshaped.
- `.github/actions/setup-bun/` (new composite action), `.github/workflows/local-runner-test.yml` (new).
- No product code changes. Release artifacts (tarballs, npm packages, Homebrew tap) must remain byte-for-byte usable — the risk surface is the cross-compiled darwin binaries, verified by smoke-testing each artifact in the apply phase.
- GitHub-hosted runner minutes drop to zero for this repo; macOS image pin caveats in `ci.yml` (the ubuntu-22.04 Bun-spawn note) become obsolete and are removed.
