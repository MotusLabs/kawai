# Tasks

## 1. Pin Bun 1.4.3

- [x] 1.1 Set `.bun-version` to `1.4.3` and confirm no workflow or action names a Bun version of its own (`grep -rn 'bun-version' .github` lists only the shared action's `bun-version-file`).
- [x] 1.2 Align the `bun-types` dev dependency with 1.4.x when a matching release exists (else leave it and say so in the PR), refresh `bun.lock` with `bun install`, and verify `bun run typecheck` passes.
- [x] 1.3 Leave `engines.bun` at `>=1.3.14` and verify no source under `src/` uses a Bun API introduced after 1.3.14 (a typecheck against 1.3 `bun-types` is enough evidence).

## 2. Verify in CI

- [x] 2.1 Open the PR and verify each job's setup step logs Bun 1.4.3 and that the quality-gates job (lint, typecheck, `test:ci`, coverage, build) and both e2e steps pass. Record any test that passes on 1.3.14 and fails on 1.4.3, with its fix.
- [ ] 2.2 Dispatch `local-runner-test.yml` on the branch and verify it reports Bun 1.4.3. Open at archive, with the human's approval: the workflow fails at its first step, "Verify isolation", before setup-bun runs. That failure is pre-existing and unrelated to the pin; it has failed on `ubuntu-latest` runners since 875b9244 ("ci: run on GitHub-hosted runners"). PR #239 records the evidence.
- [x] 2.3 Record the coverage delta against the last master run in the PR body.
- [x] 2.4 Before merging the implementation, rehearse `release.yml` with the proposed pin in a disposable checkout: build the frontend and all four platform binaries, check their formats and sizes, and boot the native binary outside `node_modules` with temporary data/config paths and a spare port. Verify the injected build version in `startup_state`; record the commands and results in the PR. Do not create a tag or publish artifacts for this rehearsal.

## Workflow follow-up

- After merge, confirm the release run for the automatically created merge tag passes its boot test on the 1.4.3 runtime before the live build updates.
- Archive the change.
