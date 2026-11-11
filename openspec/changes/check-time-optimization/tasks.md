# Tasks

## 1. Load-independent timing tests (D1)

1.1 and 1.2 landed in PR #381 (merge `80973e49`, 2026-11-10). 1.3, the loaded-run evidence, is still open.

- [x] 1.1 In `src/server/__tests__/throttled-reconnect.integration.test.ts`, remove the wall-clock ratio assertion (`meanSingle < meanDouble * 0.75`), keep the byte-ratio assertion, keep the timing report as printed diagnostics, and update the header comment. Verify: the file passes under the runner, and `grep -nE "expect\(.*(timeMs|meanSingle\b|meanDouble\b)" ` finds no duration assertion (A4).
- [x] 1.2 In `src/server/__tests__/output-coalescing.integration.test.ts`, set every `waitUntil` deadline to at least half the enclosing test's timeout (30 s of 60 s), with a comment that deadlines are liveness bounds and the ordering assertions are the oracle. Verify: the file passes under the runner, and a reviewer-checkable list of each wait and its deadline is in the result (A4).
- [ ] 1.3 Run both files 5 times serially next to a CPU-saturating load inside the workspace (for example 6 busy loops), recording `/sys/fs/cgroup/cpu.pressure` during each run (some avg10 of 50% or more), and keep the raw log. Do not use `/proc/loadavg`; it reports the whole node. Verify V4: 10 of 10 runs pass, log attached. Negative control: with the 1.1 assertion restored, at least one loaded run fails or the result states it never did.

## 2. Real-tmux selection and the nightly run (D6, D7)

Implementation notes (branch `feat/real-tmux-selection`):
- 2.1 trial: the workflow is on master only after merge, so a dispatch could not reach it. The trial ran it from the branch instead, through a temporary `workflow_call` trigger and `nightly-real-tmux-trial.yml`, both removed before merge. Run https://github.com/MotusLabs/kawai/actions/runs/42989716546: all 7 files passed on the first trial (`nightly-real-tmux: 7 passed, 0 failed`). The dispatched run on master that V7 names follows the merge.
- 2.2: the report is filed by `scripts/nightly-real-tmux.ts report`, so the open-or-comment rule is unit-tested (`scripts/__tests__/nightlyRealTmux.test.ts`). The forced-failure job in the same trial failed as intended, but the report step got `the 'MotusLabs/kawai' repository has disabled issues`. The owner chose to enable issues (2026-11-11); A9 waits on a rerun after that.
- The workflow has no `concurrency` group: the trial calls it twice in one run, and overlapping nightly runs are harmless.
- 2.3: the pre-commit hook refuses a commit with failing tests, so the tables could not be committed failing first. Instead, the mutants in 2.4 and the runner bypass in 2.6 show the tables fail without the code.
- 2.4 mutants (`scripts/__tests__/realTmuxSelection.test.ts`): trigger check removed killed by SE3, no-merge-base fallback removed killed by SE2, own-file match dropped killed by SE4.
- An unreadable real-tmux file declares `**`, so it is never skipped; a changed set that cannot be listed counts as no merge-base, so every file runs.
- The selection reaches the record through `real-tmux-selection.json` in the check's report directory (the JUnit merge reads only `*.junit.xml`), as `CheckRecord.realTmux: { mergeBase, skipped }`.
- 2.6: SE4 and SE5 through the real `runCheck` and runner (`src/server/__tests__/realTmuxSelection.integration.test.ts`); with selection bypassed in `test-runner.ts` (forced always), both fail with every fixture in the test list.

- [ ] 2.1 Add `.github/workflows/nightly-real-tmux.yml` (`schedule` daily plus `workflow_dispatch`, master, tmux installed as in the e2e job) running the 7 real-tmux files. Trial it by dispatch on a branch push before selection lands. Verify V7: a dispatched run's URL with all 7 files executed. Stop rule: if no run passes on a clean master within three dispatched trials, stop and report to the owner (D7).
- [ ] 2.2 Add the failure reporting: on failure, comment on the open `nightly-real-tmux` issue or open one, naming the failing tests and the run URL. Verify A9: one dispatched run with a forced failure (an input that fails one test on purpose) produces the issue or comment, and its link is in the result.
- [x] 2.3 Commit SE1–SE5 and G1–G2 verbatim as table-driven tests over a pure selector (`selectRealTmuxFiles(changed, declarations, mergeBase, forced)`), failing first. Verify: the tests exist and fail before 2.4.
- [x] 2.4 Implement the selector and the shared-trigger constant beside `REAL_TMUX_FILES`, the changed set (diff from the local `origin/master` merge-base plus untracked non-ignored files, no fetch), and `--all-real-tmux` in `scripts/test-runner.ts`. Record skipped files and the merge-base. Verify V6: 2.3 passes. Mutants: the trigger check removed (kills SE3), the no-merge-base fallback removed (kills SE2), and the own-file match dropped (kills SE4).
- [x] 2.5 Add `// @exercises:` headers to the 7 real-tmux files, each glob justified by what the file drives (for example `src/server/terminal/**`, `src/server/ws/**`, `src/server/SessionManager.ts`, `src/server/tmux*.ts`), and the guard test (missing header, dead glob). Verify: G1 and G2 pass, and the result lists each file's globs with a one-line reason.
- [x] 2.6 Production-composition rows SE4 and SE5: a temporary git repository with an `origin/master` ref and two fixture real-tmux files run through the real runner, observed by which JUnit reports exist. Verify: both pass, and with selection bypassed in `test-runner.ts` SE5 fails (A8, I6).
- [x] 2.7 Add `@covers` annotations for "Real-tmux files run only when affected" and "A nightly run executes every real-tmux file" (the latter on the workflow's selector test, with the workflow run as evidence). Verify: the coverage guard passes.

## 3. Real-tmux retry and record fields (D2, D3)

- [ ] 3.1 Commit the RT1–RT6 table verbatim as a table-driven test in `scripts/__tests__/runPlanRetry.test.ts` over `runBatchesAndPublish` with an injected `runCommand`. Commit it failing first. Verify: the test exists and fails on the current code for RT3–RT5.
- [ ] 3.2 Change `scripts/runPlan.ts` so a real-tmux batch failure is collected, later real-tmux batches still run, and failed files (at most two) rerun once each after the last real-tmux batch. The main batch keeps throwing. Add `--no-retry` to `scripts/test-runner.ts`, and pass it through from `scripts/check.ts`. Verify V1: 3.1 passes, and these mutants each fail a named row: the rerun removed (kills RT3), the F ≤ 2 bound removed (kills RT5), the main-batch guard removed (kills RT1), and `--no-retry` ignored (kills RT6).
- [ ] 3.3 Append each rerun's report name to the planned-report manifest before the rerun starts. In `scripts/lib/junitReports.ts`, merge the rerun's report for a retried file and drop its first report. Verify: a test where a retried file's first report holds a failure and its rerun report a pass yields a test list with the pass and no duplicate entries. Mutant: the first report kept, which must fail.
- [ ] 3.4 Add `retries` and `caseProfile` to `CheckRecord` (`src/server/checks/checkRecords.ts`) and write them from `scripts/lib/checkRun.ts`. A record without them reads as no retries and an unknown profile. Verify: a test reads a fixture record written before this change, and the RT3 row's record names the file and its first-attempt failures (A1).
- [ ] 3.5 Commit RU1–RU5 verbatim as a table-driven test over `runCheck`, then implement the reuse rule: `--full-properties` reuses only `full` or unknown. Verify V1: every RU row passes, and the profile check removed in reuse fails RU4 (A6).
- [ ] 3.6 Production-composition rows (hazard M1): RT3 and RU4 through the real `runCheck` and runner, with two fixture test files and real `bun test` children. One real-tmux-classified fixture fails on its first run and passes on its second, using a marker file in its root. Verify: both rows pass, and with the retry wiring removed from `test-runner.ts` RT3 fails (A2).
- [ ] 3.7 Confirm the pre-push hook accepts records with retries or a `reduced` profile, by a test in `scripts/__tests__/` over `scripts/lib/pushCheck.ts`. Verify: the test passes. Mutant: rejecting `reduced` makes it fail.
- [ ] 3.8 Add the `@covers: dev-checks › …` annotations for the scenarios of "A failed real-tmux file is retried once" and "A recorded pass names its retries and case profile" above their tests. Verify: `scripts/__tests__/specCoverageGuard.test.ts` passes.

## 4. Reduced local case profile (D4)

- [ ] 4.1 Add `src/server/__tests__/helpers/propertyCases.ts` with `propertyCases(declared)` and the PC1 exhaustive test (n 1–2,000 × 4 environments). Verify V2: PC1 passes, and these mutants each fail it: the `CI` check removed, `ceil` replaced by `floor`, and the threshold moved from 50 to 51.
- [ ] 4.2 Switch the 6 test files that declare a `CASES` or `SEQUENCES` constant of 50 or more to loop to `propertyCases(CASES)` with unchanged titles and seeds. First list them, with `grep -rnE "const (CASES|SEQUENCES) = [0-9]+"`, in the result. Verify: every title is byte-identical to before (`git diff` shows no title line), and each file passes locally and with `CI=true` (I2, I4).
- [ ] 4.3 Make `bun run check --full-properties` export `KAWAI_FULL_PROPERTIES=1` to the test step and record `caseProfile: 'full'`. Otherwise record `reduced`, or `full` when `CI=true`. Verify: a runner probe file under `scripts/__tests__/fixtures/` counts executed cases: 75 by default, 300 with `CI=true`, 300 with `--full-properties` (A3). Mutant: the export removed, which must fail the `--full-properties` row.
- [ ] 4.4 Add the `@covers` annotations for "Local runs execute a reduced case profile". Verify: the coverage guard passes.

## 5. Template test database (D5)

- [ ] 5.1 In `scripts/test-runner.ts`, build `<runRoot>/template.db` with `initDatabase` before the first batch, close it with a WAL checkpoint, export `KAWAI_TEST_DB_TEMPLATE`, and fail the run, naming the migration, when the build fails. Verify: a runner test sees the variable in a child and a single file with no `-wal`/`-shm` beside it. With a failing fixture migration, the run fails and names it.
- [ ] 5.2 Add `src/server/__tests__/helpers/testDatabase.ts` with `freshTestDatabase(path)`: copy the template and call `initDatabase`, or create a new database when the variable is unset. Its header lists the migration, backup, and startup-refusal test files that must keep `initDatabase`. Verify TD2: a copy reports the registry's latest version. Mutant: no checkpoint before the copy fails it. Also verify the bare-`bun test` fallback.
- [ ] 5.3 Rank the server test files by recorded duration × `initDatabase` call sites, and migrate the heaviest to `freshTestDatabase` until the next file would save under 1 s by its recorded time. Put the ranked list with expected savings in the result. Verify: each migrated file passes under the runner.
- [ ] 5.4 Add the TD1 runner test: two fixture files, one migration test and one helper user. After the run, `pre-migration-*` backups exist only in the migration test's root. Verify V3: it passes. Mutant: the helper's copy skipped fails it (A5).
- [ ] 5.5 Add the `@covers` annotations for "Test databases start from a migrated template" and "Real-tmux tests do not fail on machine speed". Verify: the coverage guard passes.

## 6. Docs and integration

- [ ] 6.1 Update AGENTS.md's Commands paragraph: the real-tmux selection and `--all-real-tmux`, the nightly run, the retry and `--no-retry`, the reduced case profile, `--full-properties`, CI's full counts, and the template database. Verify: the AGENTS.md diff names all seven, and the `@reads` tests pass (A7).
- [ ] 6.2 Run `bun run check` on the clean committed tree before and after the change, on an otherwise idle machine, and report total test work and wall time from the timings record and the check output (V5). Verify: both figures are in the result. This is evidence, not a pass bound.
- [ ] 6.3 Map each oracle id (SE1–SE5, G1–G2, RT1–RT6, RU1–RU5, PC1, TD1, TD2) to its test title and killed mutant in the result, and map A1–A9, I1–I6, and V1–V7 to evidence. Verify: no id is unmapped.

## Workflow follow-up

- After the change lands, archive it with `/openspec-archive-change` and add `@covers` annotations for any scenario still uncovered.
