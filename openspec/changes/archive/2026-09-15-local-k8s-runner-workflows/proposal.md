## Why

CI and release builds consume GitHub-hosted runner minutes and queue on shared hosted capacity. The operator already runs a hardened GitHub Actions runner pool on a local Kubernetes cluster (proven by `ru-sh/tg-assistant`), so agentboard's workflows can run there: faster, no per-minute cost, and full control over the environment.

## What Changes

- Re-point every job in `.github/workflows/ci.yml`, `create-release-tag.yml`, and `release.yml` from GitHub-hosted runners (`ubuntu-*`, `macos-latest`) to the local Kubernetes runner pool (`runs-on: local-k8s`). — *Superseded during validation: runner labels returned to `ubuntu-latest`; see Outcome.*
- Add per-job `timeout-minutes` and CI `concurrency` (cancel-in-progress) — self-hosted runners have no automatic cleanup or queue fairness.
- Add a `setup-bun` composite action (`.github/actions/`) that installs Bun, points installs at the cluster-local npm proxy (Verdaccio), and falls back to the public registry when the proxy is down.
- Collapse the release build matrix: all four targets (`darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`) cross-compile on one Linux runner, since every build is already `bun build --compile --target <triple>`. No macOS hosted runner is needed.
- The e2e job moves to the local runner too; it must make tmux and Playwright Chromium system dependencies work on the runner image (install, or verify pre-installed).
- Publishing shrinks to this repository's GitHub Releases: drop the four npm platform packages, the main npm package, and the Homebrew tap update (scope change requested during apply — no remote registries except repo-specific GitHub ones).
- Add a `local-runner-test.yml` workflow (manual dispatch) that verifies the CI environment: runner isolation (no docker socket, no k8s service account token) and Bun availability.

Confirmed decisions:
- e2e moves to the local runner (system dependencies handled within the workflow; not deferred to hosted runners).
- Release builds cross-compile on `local-k8s` rather than keeping darwin builds on hosted macOS runners.
- Re-decided 2026-09-14 after pool evaluation: this public repository runs on GitHub-hosted runners; the local pools serve the organization's private repositories.

Assumptions (from the working reference configuration):
- Runner label is `local-k8s`; same cluster as `ru-sh/tg-assistant`, so the Verdaccio proxy at `http://verdaccio.ci-npm.svc.cluster.local:4873` is reachable and the public-registry fallback pattern applies. *(superseded 2026-09-14 — see Outcome)*
- Existing action pins (checkout, upload/download-artifact, setup-node, setup-bun) carry over unchanged.

## Outcome

The pool migration was implemented (tasks 1–3), evaluated on real runs, and its runner-selection premise deliberately rolled back for this repository:

- `b497047` retargeted the workflows at the new organization-scoped public pool (`local-k8s-public`) after discovering scale-set names are unique per organization, so the public pool could not share the name `local-k8s`.
- `875b924` returned every workflow to GitHub-hosted `ubuntu-latest` runners: kawai is a public repository, so hosted minutes are free and unlimited; the pool image has no C toolchain (node-pty's node-gyp build fails with `not found: make`), no tmux, and no Chromium system libraries, with no passwordless sudo to install them; and hosted runners keep fork-PR code off the cluster node.

Everything else this change introduced survives on master: the `setup-bun` composite action (from hosted runners its proxy probe always falls back to the public registry with the designed visible warning), per-job `timeout-minutes`, CI `concurrency` with cancel-in-progress, the single-job four-target cross-compile release build, and GitHub-Releases-only publishing. Validation: the canary releases `v0.5.2`/`v0.5.3` (2026-09-14) each carry all four platform binaries + tarballs; npm's latest remains the pre-change `0.5.2` (published 2026-09-10) and the Homebrew tap was untouched.

## Capabilities

### New Capabilities
- `github-workflows`: Observable behavior of agentboard's CI/CD workflows — which runner pool executes each job, that every job is time-bounded and concurrency-safe, that installs route through the registry proxy with public fallback, that release binaries for all four platforms build on the local pool, and that the runner self-test verifies pool health.

### Modified Capabilities
<!-- none: openspec/specs/ is empty; this is the first capability spec -->

## Impact

- `.github/workflows/ci.yml`, `.github/workflows/create-release-tag.yml`, `.github/workflows/release.yml` — runner labels, timeouts, concurrency, release matrix reshaped.
- `.github/actions/setup-bun/` (new composite action), `.github/workflows/local-runner-test.yml` (new).
- No product code changes. Release artifacts become GitHub Release tarballs/binaries only; npm publishing and the Homebrew tap update are removed from CI (repo scaffolding for them — `npm/` packages, `scripts/update-optional-deps.js` — becomes inert and is proposed as follow-up cleanup). The risk surface is the cross-compiled darwin binaries, verified by sanity checks in the apply phase plus a real-Mac check of the first canary release.
- The runner-label portion was rolled back (see Outcome), so this public repo runs on GitHub-hosted runners — free and unlimited for public repositories, consuming none of the organization's pool capacity; the macOS image pin caveat in `ci.yml` (the ubuntu-22.04 Bun-spawn note) is still obsolete and removed.
