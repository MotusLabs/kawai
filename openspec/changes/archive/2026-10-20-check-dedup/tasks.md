# Tasks

## 1. Content key and records

- [x] 1.1 Add the content-key function (temporary index copy, `git add -A`, `git write-tree`, plus the Bun version and platform; explicit `GIT_INDEX_FILE` for its own git calls only) with unit tests in a temporary repository: an unchanged tree gives the same key, an edit, an untracked file, or a different Bun version changes it, an ignored file does not, and the real index is byte-identical afterward. All of them spawn git with `cleanGitEnv`.
- [x] 1.2 Add the record store under `<git-common-dir>/kawai-checks/` (atomic write, lookup, pruning past 14 days or 500 records) with unit tests, including a lookup from a second linked worktree of the same temporary repository.

## 2. `bun run check`

- [x] 2.1 Add `scripts/check.ts` and the `check` script: lint, typecheck, `bun run test` in order, stopping at the first failure; record only a full pass; report a hit with its time and worktree; `--force`; `GIT_*` hook variables stripped from step environments. Verify with tests covering a pass that records, a failure that doesn't, a hit that runs nothing, and `--force` running everything.
- [x] 2.2 Document `bun run check` in AGENTS.md's Commands block and paragraph (what it caches, where records live, `--force`, `bun run test` staying raw), and run `bun run test` once because a test reads AGENTS.md.

## 3. Hook and typecheck

- [x] 3.1 Change `.githooks/pre-commit` to run `bun run check` for non-docs commits and keep lint and typecheck only for docs-only ones. Verify by committing the same content twice in a scratch branch (an amend with no edit) and confirming that the second commit reports the recorded pass and takes seconds.
- [x] 3.2 Set `incremental` and `tsBuildInfoFile` (`node_modules/.cache/kawai/tsc.tsbuildinfo`) in `tsconfig.json`. Verify that a second `bun run typecheck` is faster, that an introduced type error shows the same diagnostics as `tsc --noEmit --incremental false`, and that `git status` stays clean.

## 4. CI

- [x] 4.1 Make `Test (coverage)` and `Upload coverage artifact` in `ci.yml` run only on `push`. Parse the file with `Bun.YAML.parse` and check indentation with `cat -A`, then confirm on the PR that the quality-gates job runs no coverage step and gets faster by about the coverage step's time.

## Workflow follow-up

- After merge, the lead switches `suite-run` suite invocations to `bun run check` (lead-owned files, outside the repository).
- Archive the change.
