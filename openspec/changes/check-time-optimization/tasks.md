# Tasks

## 1. Load-independent timing tests (D1)

- [ ] 1.1 In `src/server/__tests__/throttled-reconnect.integration.test.ts`, remove the wall-clock ratio assertion (`meanSingle < meanDouble * 0.75`), keep the byte-ratio assertion, keep the timing report as printed diagnostics, and update the header comment. Verify: the file passes under the runner, and `grep -nE "expect\(.*(timeMs|meanSingle\b|meanDouble\b)" ` finds no duration assertion (A4).
- [ ] 1.2 In `src/server/__tests__/output-coalescing.integration.test.ts`, set every `waitUntil` deadline to at least half the enclosing test's timeout (30 s of 60 s), with a comment that deadlines are liveness bounds and the ordering assertions are the oracle. Verify: the file passes under the runner, and a reviewer-checkable list of each wait and its deadline is in the result (A4).
- [ ] 1.3 Run both files 5 times serially next to a CPU-saturating load (for example 6 busy loops), keeping the raw log. Verify V4: 10 of 10 runs pass, log attached. Negative control: with the 1.1 assertion restored, at least one loaded run fails or the result states it never did.

## 2. Real-tmux retry and record fields (D2, D3)

- [ ] 2.1 Commit the RT1–RT6 table verbatim as a table-driven test in `scripts/__tests__/runPlanRetry.test.ts` over `runBatchesAndPublish` with an injected `runCommand`. Commit it failing first. Verify: the test exists and fails on the current code for RT3–RT5.
- [ ] 2.2 Change `scripts/runPlan.ts` so a real-tmux batch failure is collected, later real-tmux batches still run, and failed files (at most two) rerun once each after the last real-tmux batch. The main batch keeps throwing. Add `--no-retry` to `scripts/test-runner.ts`, and pass it through from `scripts/check.ts`. Verify V1: 2.1 passes, and these mutants each fail a named row: the rerun removed (kills RT3), the F ≤ 2 bound removed (kills RT5), the main-batch guard removed (kills RT1), and `--no-retry` ignored (kills RT6).
- [ ] 2.3 Append each rerun's report name to the planned-report manifest before the rerun starts. In `scripts/lib/junitReports.ts`, merge the rerun's report for a retried file and drop its first report. Verify: a test where a retried file's first report holds a failure and its rerun report a pass yields a test list with the pass and no duplicate entries. Mutant: the first report kept, which must fail.
- [ ] 2.4 Add `retries` and `caseProfile` to `CheckRecord` (`src/server/checks/checkRecords.ts`) and write them from `scripts/lib/checkRun.ts`. A record without them reads as no retries and an unknown profile. Verify: a test reads a fixture record written before this change, and the RT3 row's record names the file and its first-attempt failures (A1).
- [ ] 2.5 Commit RU1–RU5 verbatim as a table-driven test over `runCheck`, then implement the reuse rule: `--full-properties` reuses only `full` or unknown. Verify V1: every RU row passes, and the profile check removed in reuse fails RU4 (A6).
- [ ] 2.6 Production-composition rows (hazard M1): RT3 and RU4 through the real `runCheck` and runner, with two fixture test files and real `bun test` children. One real-tmux-classified fixture fails on its first run and passes on its second, using a marker file in its root. Verify: both rows pass, and with the retry wiring removed from `test-runner.ts` RT3 fails (A2).
- [ ] 2.7 Confirm the pre-push hook accepts records with retries or a `reduced` profile, by a test in `scripts/__tests__/` over `scripts/lib/pushCheck.ts`. Verify: the test passes. Mutant: rejecting `reduced` makes it fail.
- [ ] 2.8 Add the `@covers: dev-checks › …` annotations for the scenarios of "A failed real-tmux file is retried once" and "A recorded pass names its retries and case profile" above their tests. Verify: `scripts/__tests__/specCoverageGuard.test.ts` passes.

## 3. Reduced local case profile (D4)

- [ ] 3.1 Add `src/server/__tests__/helpers/propertyCases.ts` with `propertyCases(declared)` and the PC1 exhaustive test (n 1–2,000 × 4 environments). Verify V2: PC1 passes, and these mutants each fail it: the `CI` check removed, `ceil` replaced by `floor`, and the threshold moved from 50 to 51.
- [ ] 3.2 Switch the 6 test files that declare a `CASES` or `SEQUENCES` constant of 50 or more to loop to `propertyCases(CASES)` with unchanged titles and seeds. First list them, with `grep -rnE "const (CASES|SEQUENCES) = [0-9]+"`, in the result. Verify: every title is byte-identical to before (`git diff` shows no title line), and each file passes locally and with `CI=true` (I2, I4).
- [ ] 3.3 Make `bun run check --full-properties` export `KAWAI_FULL_PROPERTIES=1` to the test step and record `caseProfile: 'full'`. Otherwise record `reduced`, or `full` when `CI=true`. Verify: a runner probe file under `scripts/__tests__/fixtures/` counts executed cases: 75 by default, 300 with `CI=true`, 300 with `--full-properties` (A3). Mutant: the export removed, which must fail the `--full-properties` row (seed-offset mutant: V2).
- [ ] 3.4 Add the `@covers` annotations for "Local runs execute a reduced case profile". Verify: the coverage guard passes.

## 4. Template test database (D5)

- [ ] 4.1 In `scripts/test-runner.ts`, build `<runRoot>/template.db` with `initDatabase` before the first batch, close it with a WAL checkpoint, export `KAWAI_TEST_DB_TEMPLATE`, and fail the run, naming the migration, when the build fails. Verify: a runner test sees the variable in a child and a single file with no `-wal`/`-shm` beside it. With a failing fixture migration, the run fails and names it.
- [ ] 4.2 Add `src/server/__tests__/helpers/testDatabase.ts` with `freshTestDatabase(path)`: copy the template and call `initDatabase`, or create a new database when the variable is unset. Its header lists the migration, backup, and startup-refusal test files that must keep `initDatabase`. Verify TD2: a copy reports the registry's latest version. Mutant: no checkpoint before the copy fails it. Also verify the bare-`bun test` fallback.
- [ ] 4.3 Rank the server test files by recorded duration × `initDatabase` call sites, and migrate the heaviest to `freshTestDatabase` until the next file would save under 1 s by its recorded time. Put the ranked list with expected savings in the result. Verify: each migrated file passes under the runner.
- [ ] 4.4 Add the TD1 runner test: two fixture files, one migration test and one helper user. After the run, `pre-migration-*` backups exist only in the migration test's root. Verify V3: it passes. Mutant: the helper's copy skipped fails it (A5).
- [ ] 4.5 Add the `@covers` annotations for "Test databases start from a migrated template" and "Real-tmux tests do not fail on machine speed". Verify: the coverage guard passes.

## 5. Docs and integration

- [ ] 5.1 Update AGENTS.md's Commands paragraph: the real-tmux retry and `--no-retry`, the reduced case profile, `--full-properties`, CI's full counts, and the template database. Verify: the AGENTS.md diff names all five, and the `@reads` tests pass (A7).
- [ ] 5.2 Run `bun run check` on the clean committed tree before and after the change, on an otherwise idle machine, and report total test work and wall time from the timings record and the check output (V5). Verify: both figures are in the result. This is evidence, not a pass bound.
- [ ] 5.3 Map each oracle id (RT1–RT6, RU1–RU5, PC1, TD1, TD2) to its test title and killed mutant in the result, and map A1–A7, I1–I5, and V1–V5 to evidence. Verify: no id is unmapped.

## Workflow follow-up

- After the change lands, archive it with `/openspec-archive-change` and add `@covers` annotations for any scenario still uncovered.
