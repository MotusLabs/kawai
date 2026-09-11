## Context

See proposal.md — Why. Current state:

- Three workflows (`ci.yml`, `create-release-tag.yml`, `release.yml`) run on GitHub-hosted images. `ci.yml` pins the quality job to `ubuntu-22.04` to dodge a Bun child-spawn regression on the 24.04 runner image.
- The release matrix builds four Bun compile targets on three different hosted images; every build is `bun build --compile --target <triple>` plus a shared `vite build`, so nothing requires matching host hardware.
- The reference configuration (`ru-sh/tg-assistant`) runs on the operator's local Kubernetes pool: label `local-k8s`, Verdaccio npm proxy in `ci-npm` namespace with public fallback, per-job timeouts, composite setup actions, and an isolation self-test workflow. Its `bun.lock`-era equivalent: agentboard's `bun.lock` records **no** absolute `resolved` URLs, so the registry host is chosen at install time — the proxy can be selected with an environment variable, no lockfile rewriting (the sed-repoint step the reference needs for Yarn 1 does not apply here).

## Goals / Non-Goals

**Goals:**
- All three workflows execute on `local-k8s`; zero hosted-runner minutes.
- One shared `setup-bun` composite action: Bun install + proxy-aware registry selection + public fallback.
- Release matrix collapses to one Linux job; artifact layout and names unchanged so the publish job, npm layout, and Homebrew tap logic are untouched.
- e2e runs on the pool with tmux + Chromium satisfied, failing with a named error when the image can't provide them.
- `local-runner-test.yml` for on-demand pool verification (isolation + Bun), modeled on the reference.

**Non-Goals:**
- Runner deployment itself (cluster-side ARC setup exists and serves tg-assistant).
- Adding security scanning (Trivy/CodeQL/Sonar) — tg-assistant concerns, not requested here.
- Changes to dependabot, CODEOWNERS, or any release publishing logic (npm provenance/OIDC, tap formula generation stay as-is).
- Docker/BuildKit integration — agentboard has no container builds.

## Decisions

**1. Runner label `local-k8s`, per-job `timeout-minutes`, CI concurrency keyed on ref.**
Mirrors the working reference; on a small self-hosted pool, unbounded jobs and un-cancelled superseded runs are the two failure modes hosted runners hide. Timeouts: quality ~15m, e2e ~25m, release build ~20m, publish ~15m, tag ~5m — generous, tightened after observation. Alternative considered: keep hosted runners for latency-critical paths — rejected; the pool is local and the reference shows acceptable latency at equal job shapes.

**2. Registry proxy via `NPM_CONFIG_REGISTRY` (+ `COREPACK_NPM_REGISTRY` for symmetry), health-checked with public fallback.**
Bun's lockfile pins integrity, not hosts, so a single env var routes installs through Verdaccio; the `/-/ping` probe with 5s timeout falls back to `https://registry.npmjs.org/` and logs a warning, exactly like the reference's `select-npm-registry`. Encapsulated in `.github/actions/setup-bun/` alongside `oven-sh/setup-bun` (already pinned, works on self-hosted Linux) reading `.bun-version`. Alternative considered: bunfig.toml committed to the repo — rejected, it would also affect developer machines, not just CI.

**3. Release build: one job, frontend once, four cross-compile targets in a loop.**
`vite build` is platform-independent — build once, then `bun build --compile --target <t>` per target into the existing `agentboard-<platform>` artifact layout (`bin/agentboard` + `dist/client`). The publish job needs no changes. Bun cross-compilation is an established feature covering all four triples from a Linux host. Alternative considered: keep darwin targets on hosted macOS — rejected (defeats the point; `--compile` targets are cross-compilable), with a documented rollback path (see Risks).

**4. e2e dependencies: verify-then-install, fail with a named error.**
Order: (a) `command -v tmux` — use it if present; (b) absent → `sudo apt-get install -y tmux` if sudo exists; (c) neither → exit with an error naming tmux. Same shape for Chromium: `bunx playwright install chromium`; system libs via `bunx playwright install-deps chromium` (sudo) when launching fails, else named failure. This makes the first run on the pool a *diagnosis*, not a mystery — whatever the image lacks is named in the log. Alternative considered: `container:` job with a pre-baked image — rejected for now (needs ARC container mode + image maintenance); revisit if the image proves incapable.

**5. `local-runner-test.yml`: dispatch-only, checks isolation + Bun.**
Adapts the reference's isolation checks (no k8s service-account token, no docker/containerd sockets) and adds what agentboard specifically needs: `setup-bun` action runs end-to-end (proxy selection included) and `bun --version` succeeds. This is the pre-migration gate: dispatch it before trusting the pool with real runs.

**6. Delete the `ubuntu-22.04` pin and its comment.**
The pinned regression was specific to the GitHub 24.04 image. The k8s runner has its own image/kernel; the same symptom (child `bun` spawns under `--coverage` never becoming healthy) is re-tested by the first real CI run there. Keeping the pin would be meaningless on a custom image.

## Risks / Trade-offs

- [Runner image lacks tmux, Chromium system libs, or sudo] → Decision 4 turns this into a named, logged failure; image prep (add packages to the runner image) is a cluster-side follow-up, and `local-runner-test.yml` catches it before real CI depends on it.
- [Cross-compiled darwin binaries misbehave on real Macs (cannot be executed on a Linux runner)] → build success + `file`/size sanity checks per darwin artifact on-runner; the next tag is the full canary. Rollback: re-add the two hosted `macos-latest` matrix legs — the workflow diff is small and mechanical. (linux-x64/arm64 artifacts are smoke-tested on-runner: `agentboard --version` runs.)
- [Bun spawn-under-coverage regression reappears on the k8s image/kernel (e.g. sandboxed syscall filtering)] → CI keeps using `test:ci` (skips real tmux); if it reproduces, investigate the runner image rather than reverting runner selection.
- [Pool capacity: reference notes ~one runner at a time; CI + e2e + a concurrent release could queue] → timeouts + cancel-in-progress bound the damage; jobs are independent so queuing degrades latency, not correctness. Release build (~single job) + CI (~2 jobs) fit a 3-runner pool.
- [Verdaccio proxy cache misses make installs slower than hosted runners' warm caches] → proxy persists across runs/jobs on a PVC (reference); first fetch of a new package is the only slow path.

## Migration Plan

1. Dispatch `local-runner-test.yml`; fix image gaps it names (cluster-side) until green.
2. Land workflow changes; open a throwaway PR to watch `ci.yml` + e2e run on the pool end to end.
3. Cut a canary tag (patch bump) to exercise the cross-compiled release chain; verify the darwin artifacts on a real Mac and the Homebrew install before announcing.
4. Rollback: revert the single workflows commit — hosted runners resume exactly as before; no cluster-side state is affected.

## Open Questions

None blocking. (Exact `timeout-minutes` values and whether sudo exists on the runner image are discovered by the migration plan's first run, and the design already defines the behavior for each outcome.)
