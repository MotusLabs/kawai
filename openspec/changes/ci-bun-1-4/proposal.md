# Proposal

## Why

Agents develop and test kawai on Bun 1.4.3, but `.bun-version` pins CI, the release build, and therefore every shipped binary (`bun build --compile` embeds the runtime) to 1.3.14. The combination that ships is the one no agent runs locally, and failures that exist only on one runtime surface late, as CI-only reds (the 1.3 fake-timer `setSystemTime` drop was one). The test-time work that follows (`check-dedup`, `parallel-suite`, `per-result-suite`) also relies on Bun 1.4's `bun test --parallel`, `--isolate`, `--changed`, and `--timings`, which 1.3.14 does not have.

## What Changes

- Pin Bun 1.4.3 in `.bun-version`, the single version file every workflow's shared setup action reads, so CI, the release build, the e2e job, and the self-test workflow all move together.
- Shipped release binaries embed Bun 1.4.3 instead of 1.3.14.
- `engines.bun` in `package.json` stays `>=1.3.14`: kawai's runtime code uses no 1.4-only API, and test-only flags do not raise the floor for people running from source.
- Align the `bun-types` dev dependency with the pinned runtime.
- No workflow logic changes; this lands alone so that any CI-only failure is attributable to the runtime.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `github-workflows`: adds a requirement that every workflow runs the one pinned Bun version, and that release binaries embed it.

## Impact

- `.bun-version`, `package.json` (`bun-types`), `bun.lock`.
- Every workflow through `.github/actions/setup-bun` (`ci.yml`, `release.yml`, `local-runner-test.yml`).
- Release artifacts: the embedded runtime of all four platform binaries changes, and with them the live kawai build once it updates.
- Follow-on changes `check-dedup`, `parallel-suite`, and `per-result-suite` depend on this one landing first.
