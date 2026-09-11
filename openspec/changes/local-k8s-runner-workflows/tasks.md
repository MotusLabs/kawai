## 1. Shared setup action

- [x] 1.1 Create `.github/actions/setup-bun/action.yml`: runs the pinned `oven-sh/setup-bun` with `bun-version-file: .bun-version`, then a registry-selection step that probes the Verdaccio proxy (`curl -fsS --max-time 5 http://verdaccio.ci-npm.svc.cluster.local:4873/-/ping`) and exports `NPM_CONFIG_REGISTRY` + `COREPACK_NPM_REGISTRY` to `$GITHUB_ENV` — proxy on hit, public registry with a `::warning::` on miss. Verify: `openspec`-independent YAML parse (`bun x yaml-lint .github/actions/setup-bun/action.yml` or equivalent) and the action reads correctly in a dispatched test job.

- [x] 1.2 Create `.github/workflows/local-runner-test.yml`: `workflow_dispatch` only, job on `runs-on: local-k8s` with `timeout-minutes`, isolation checks from the reference (assert no `/var/run/docker.sock`, no `/run/containerd/containerd.sock`, no k8s service-account token), then the `setup-bun` action, then `bun --version`. Verify: workflow dispatches and passes on the pool (per Migration Plan step 1); any isolation failure names the violated check.

## 2. CI workflow

- [x] 2.1 In `.github/workflows/ci.yml`: change both jobs to `runs-on: local-k8s`, add `timeout-minutes` (quality 15, e2e 25), add workflow-level `concurrency` (`group: ci-${{ github.workflow }}-${{ github.ref }}`, `cancel-in-progress: true`), remove the `ubuntu-22.04` pin and its comment, and replace both inline `setup-bun` steps with the shared action. Verify: `actionlint` (or `bun x actionlint`) passes and no job references a hosted runner label.

- [x] 2.2 Rework the e2e job's dependency steps per design decision 4: `command -v tmux` check with `sudo apt-get install -y tmux` fallback and named failure otherwise; `bunx playwright install chromium`; attempt launch and run `bunx playwright install-deps chromium` only when system libs are missing, failing with a named error if that is impossible. Verify: the tmux branch logic is exercised by the first pool run; a deliberately missing-dependency simulation fails with the dependency named.

## 3. Release workflows

- [x] 3.1 In `.github/workflows/release.yml`: collapse the build matrix into one job on `runs-on: local-k8s` (timeout 20) that builds the frontend once, then loops the four `bun build --compile --target` triples into the existing `agentboard-<platform>` artifact layout; add darwin sanity checks (`file` reports Mach-O, size within expected range) and on-runner smoke tests for the linux artifacts (`agentboard --version` executes). Verify: a manual `workflow_dispatch`-enabled test run uploads all four artifacts with `bin/agentboard` + `dist/client` inside.

- [x] 3.2 Confirm the publish job needs no behavioral change: same artifact names, same OIDC trusted publishing (`id-token: write` retained), same tarball/tap logic — only add `timeout-minutes: 15` and `runs-on: local-k8s`. Verify: diff of the publish job shows only runner label + timeout changes.

- [x] 3.3 In `.github/workflows/create-release-tag.yml`: switch to `runs-on: local-k8s`, add `timeout-minutes: 5`, keep `RELEASE_PAT` checkout logic untouched. Verify: `actionlint` passes and the `if: github.event.pull_request.merged == true` gate is unchanged.

- [x] 3.4 Remove non-GitHub publishing from the release job: drop `setup-node`, both npm publish steps (`Publish platform packages`, `Publish main package`), `Update main package optionalDependencies`, and the entire `Update Homebrew tap` step; trim job permissions to `contents: write`. Verify: the release job contains no `npm publish`, no tap clone, and no `id-token`/`packages` permissions; YAML parses.

## 4. Validation

- [x] 4.1 Run `actionlint` (or equivalent YAML/action validation) over all workflow and action files. Verify: zero errors.

- [ ] 4.2 Open a throwaway PR and watch `ci.yml` run on the pool end to end: quality gates green, e2e green with Chromium + tmux resolved on the image, proxy hit or fallback warning visible in the install step logs. Verify: run page shows both jobs on `local-k8s` runners with all steps green.

- [ ] 4.3 Cut a canary patch tag and verify the release chain: GitHub Release created with the four platform tarballs and binaries, nothing published to npm or the Homebrew tap. Verify: the release page lists all four tarballs; `npm view @gbasin/agentboard@<version>` shows nothing newer than the last pre-change version; a real Mac runs the darwin binary from the tarball.
