# Design

## Context

`.github/actions/setup-bun` installs Bun with `bun-version-file: .bun-version`, and every workflow (`ci.yml`, `release.yml`, `local-runner-test.yml`) uses that action, so `.bun-version` is already the only pin. The workspace where agents run checks has Bun 1.4.3; the full unit suite (5051 tests) passes there (timed run, 2026-10-19). The release job builds with `bun build --compile`, so the CI pin is also the shipped runtime.

## Goals / Non-Goals

**Goals:**
- One Bun version for agents' local checks, CI, and shipped binaries.
- Unblock the Bun 1.4 test-runner features the follow-on changes use.

**Non-Goals:**
- Using any 1.4 feature in this change. The runner, the hook, and CI steps are unchanged.
- Raising `engines.bun`. Running from source on 1.3.14 stays supported until runtime code needs 1.4.
- Enforcing that a developer's local Bun matches the pin.

## Decisions

- **Edit only `.bun-version` (plus `bun-types`).** The shared action already routes every workflow through it, so the spec's "one pin" requirement holds without workflow edits. Alternative: a `bun-version:` input per workflow. Rejected because it creates the drift the requirement forbids.
- **Ship 1.4.3 in release binaries now, not in a later change.** Splitting CI (1.4) from release (1.3) would keep the shipped runtime untested locally, which is the problem this change exists to fix.
- **Land alone, before any other test-time change.** A CI-only failure after this merge is then the runtime's, not a runner change's.

## Risks / Trade-offs

- [A behavior difference between 1.3.14 and 1.4.3 surfaces only in CI steps not run locally (coverage, release build, e2e)] → The implementation PR runs the full CI, including e2e. Separately, before merge, rehearse `release.yml`'s four cross-compiles, format/size checks, and native boot check in a disposable checkout with the proposed pin, without creating a tag or publishing a release. Record the commands, Bun version, and results; ordinary PR CI runs no release dry run.
- [The compiled binary misbehaves at runtime on 1.4.3] → The release job's existing boot test (the binary must report its version) runs on every release; the live server is updated only after that passes. Rollback is reverting `.bun-version` and cutting a new release.
- [Coverage figures shift slightly with the new runtime] → Nothing gates on an exact percentage; note the delta in the PR.

## Migration Plan

1. Change `.bun-version` to 1.4.3, align `bun-types`, and refresh `bun.lock`.
2. Open the PR; confirm the CI jobs log Bun 1.4.3 and pass, including e2e and the chat fixture e2e step.
3. Dispatch the self-test workflow (`local-runner-test.yml`) on the branch and confirm it reports 1.4.3.
4. Before merge, rehearse the release build and native boot check from `release.yml` in a disposable checkout using 1.4.3, with no tag or publishing. Run the native binary outside a checkout containing `node_modules`, with temporary data/config paths and a spare port, as the workflow requires. Record the results in the implementation PR.
5. After merge, confirm the automatically created release tag's build and boot test pass before adopting the live build.

Rollback: revert the commit; the next merge cuts a release on 1.3.14 again.
