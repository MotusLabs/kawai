# Design

## Context

See proposal.md, "Why". Current state that shapes the approach:

- `scripts/runPlan.ts` `runBatchesAndPublish` runs the planned batches in order: the parallel main batch, then one batch per real-tmux file (`REAL_TMUX_FILES` in `scripts/planBatches.ts`, 7 files). `runCommand` throws on a non-zero exit, so the first failing batch stops the run and later real-tmux files never run.
- `scripts/lib/checkRun.ts` records a pass only when every step passed and the tree is unchanged. The test list (`scripts/lib/junitReports.ts`) is all-or-nothing over a manifest of planned report names written before the first batch.
- `CheckRecord` (`src/server/checks/checkRecords.ts`) holds key, tree, Bun, platform, time, worktree, steps, and an optional test-list pointer. The content key holds no run options.
- CI runs `bun run test:ci`, which is `--skip-real-tmux`, with `CI=true` (GitHub Actions). Real-tmux files run only locally.
- Heavy property tests hardcode counts (`const CASES = 300`) and seed each case as `mulberry32(SEED + index)`. 9 test files declare a `CASES` or `SEQUENCES` constant, 6 of them 50 or more. Titles quote the count, and coverage citations quote titles verbatim.
- `throttled-reconnect.integration.test.ts:625` asserts a byte ratio and `:632` a wall-clock ratio, both `< 0.75`. `output-coalescing.integration.test.ts:197` waits 10 s for `terminal-ready` inside a 60 s test.
- `initDatabase` on a new file took 0.56–1.18 s at load 28 and wrote 4 pre-migration backups of about 1.2 MB each (`database-safety` requires a backup before each pending migration). 176 server test files call `initDatabase`, many per test.

## Goals / Non-Goals

**Goals:**
- A real-tmux timing failure costs one file's rerun, not a full check.
- Local checks run fewer generated cases without changing what CI certifies.
- Fresh test databases cost a file copy instead of a migration and its backups.

**Non-Goals:**
- Changing `database-safety` or production `initDatabase`.
- Retrying main-batch files, or any file in CI.
- A general flaky-test quarantine.

## Decisions

### D1. Load-independent assertions in the two timing tests

`throttled-reconnect` drops the wall-clock ratio assertion and keeps the byte ratio. The pacing proxy turns bytes into time at a fixed rate, so bytes are the controlled quantity; times stay in the printed report. `output-coalescing` raises every `waitUntil` deadline in a test to half its timeout (30 s of 60 s). These are liveness bounds; the oracles are the ordering assertions. Alternative: longer ratios or more trials. Rejected, because any wall-clock ratio still depends on CPU contention between the two arms.

### D2. Retry only real-tmux files, after the serial batch, at most two

`runBatchesAndPublish` keeps throwing on a main-batch failure. A real-tmux batch failure is collected instead, and the next real-tmux batch starts. After the last one:
- with no failures, the step passes;
- with one or two failures and retries on, each failed file reruns once, alone, in its own batch;
- with three or more failures, or retries off, the step fails.

Each rerun's JUnit report name is appended to the manifest before it starts, and the merge reads the rerun's report for a retried file and the first report for the others.

Alternatives:
- Retry any failed file. Rejected: main-batch failures are rarely timing failures, and retrying them would hide real ones.
- Unlimited retries. Rejected: three failed real-tmux files signal a broken environment or real breakage.
- Rerunning immediately after the failure. Rejected: the cause, load, is still present then.

### D3. Record fields and reuse

`CheckRecord` gains `retries?: { file, failures: string[] }[]` and `caseProfile?: 'reduced' | 'full'`. An absent field reads as no retries and an unknown profile. The content key is unchanged. Reuse depends on the request:
- `--full-properties` reuses only a `full` or unknown record (every pass before this change ran declared counts);
- the default request reuses any record.

The pre-push hook accepts any pass. CI runs the declared counts for every merge.

### D4. One case-count helper over a prefix of the same seeds

`src/server/__tests__/helpers/propertyCases.ts` exports `propertyCases(declared)`. It returns `declared` when `declared < 50`, when `CI === 'true'`, or when `KAWAI_FULL_PROPERTIES === '1'`. Otherwise it returns `ceil(declared / 4)`. Tests keep `const CASES = 300` for titles and loop to `propertyCases(CASES)`, so a reduced run executes exactly the first k seeds of the full run. A local failure therefore reproduces in CI and the reverse. `bun run check --full-properties` exports `KAWAI_FULL_PROPERTIES=1` to the test step and records `caseProfile: 'full'`. Otherwise the check records `reduced`, or `full` when `CI=true`.

Alternative: a random subset of seeds. Rejected, because it breaks reproduction between local runs and CI.

### D5. A template database per run root

Before the first batch, the runner opens `<runRoot>/template.db` with `initDatabase`, then closes it with a WAL checkpoint so one self-contained file remains. It exports `KAWAI_TEST_DB_TEMPLATE`, and a build failure fails the run, naming the migration. `src/server/__tests__/helpers/testDatabase.ts` `freshTestDatabase(path)` copies the template to `path` and calls `initDatabase({ path })`, which finds no pending migration and takes no backup. Without the variable, under a bare `bun test`, it calls `initDatabase` on a new file.

Files migrate to the helper heaviest first. Migration, backup, and startup-refusal tests keep `initDatabase` on new files and are listed as such in the helper's header.

Alternatives:
- A test-only branch in production `initDatabase`. Rejected: test hooks would ship.
- `mock.module` in the preload. Rejected: it is process-wide, and it would also replace the migrations under test.

## Acceptance oracles

### Retry decision table (unit step)

Inputs: main batch result; F = number of real-tmux files that failed their first attempt; retries on or off; rerun outcomes. Outputs: which files rerun; step result; recorded retries.

| id | main | F | retries | reruns | rerun files | step | record `retries` |
|---|---|---|---|---|---|---|---|
| RT1 | fail | * | * | * | none; no real-tmux file runs | fail | no record |
| RT2 | pass | 0 | * | * | none | pass | none |
| RT3 | pass | 1–2 | on | all pass | each failed file once, after all real-tmux files | pass | each failed file with its first-attempt failures |
| RT4 | pass | 1–2 | on | any fail | each failed file once | fail, naming file and both attempts | no record |
| RT5 | pass | ≥3 | * | * | none | fail | no record |
| RT6 | pass | 1–2 | off | * | none | fail | no record |

Unreachable: rerun outcomes for rows with no reruns (RT1, RT2, RT5, RT6) are don't-cares. F > 7 cannot occur (7 real-tmux files). A signal during a rerun takes the existing interrupted path: no record.

Completeness: main ∈ {pass, fail} × F ∈ {0, 1–2, ≥3} × retries ∈ {on, off} × reruns ∈ {all pass, any fail}. Every combination matches exactly one row: fail → RT1; pass,0 → RT2; pass,1–2,on → RT3 or RT4 by rerun outcome; pass,1–2,off → RT6; pass,≥3 → RT5, with either retry setting.

### Reuse table (record × request)

| id | request | existing record profile | result |
|---|---|---|---|
| RU1 | default | none | run |
| RU2 | default | reduced, full, or unknown | reuse |
| RU3 | `--full-properties` | full or unknown | reuse |
| RU4 | `--full-properties` | reduced | run, then record `full` |
| RU5 | `--force` with either request | * | run |

### Case-count property

- **PC1, invariant:** for every declared n, `propertyCases(n)` equals n when n < 50 or when CI or the full flag is set, and `ceil(n/4)` otherwise. The executed seeds are `SEED + 0 … SEED + k-1`, a prefix of the full run's.
- **Generator:** n from 1 to 2,000, every value. Environment × {unset, `CI=true`, `KAWAI_FULL_PROPERTIES=1`, both}. Fixed: exhaustive over the range, so no seed is needed. Case count: 8,000.

### Template-database oracles

- **TD1:** after a full runner run, no `pre-migration-*` backup exists under any per-file root except roots of files listed as migration tests.
- **TD2:** a `freshTestDatabase` copy reports the registry's latest schema version and an empty `schema_migrations` difference from the registry.

### Seams through production wiring (hazard M1)

- **RT and RU rows:** rows run through the real `runBatchesAndPublish` and `runCheck` with fixture test files and a spawn seam that runs real `bun test` children, at least one row per table. The other rows may use the injected `runCommand`.
- **PC1 wiring:** one probe test file under the real runner counts executed cases with and without `CI=true`.
- **TD1:** runs the real runner over two fixture files, one migration test and one using the helper.

## Risks / Trade-offs

- [A real regression in a real-tmux file passes on its rerun] → It must fail twice in a row to be caught. The record names every retry, the runner prints a retry warning, and the real-tmux behavior assertions stay strict. A failure on the rerun fails the step.
- [Reduced local counts miss a counterexample beyond the first quarter] → CI runs the declared counts on every PR, and `--full-properties` gives the same locally. Authors of new properties keep choosing declared counts as before.
- [A template built from a broken migration] → The build fails the run loudly, naming the migration (D5), and migration tests still run every migration on new files.
- [Copying a WAL-mode database mid-write] → The runner closes the template with a checkpoint before any batch starts. Copies are made only from the closed file.

## Migration Plan

1. Land D1 alone first; it is safe on its own.
2. Land D2/D3, the runner and record changes, with their tests.
3. Land D4: the helper plus the 6 files with declared counts of 50 or more.
4. Land D5: the runner template and the helper, then migrate files heaviest first by recorded duration.
5. Update AGENTS.md's Commands paragraph.

Rollback: each step reverts alone. Records without the new fields stay readable (D3).

## Open Questions

- Which test files beyond the first batch to move to `freshTestDatabase`. The task's measured list decides; it does not change the approach.

## Implementation contract

### Acceptance

- A1. A full check where one real-tmux file fails once and passes when rerun alone records a pass that names the file and its first-attempt failures (RT3).
- A2. Every row RT1–RT6 and RU1–RU5 holds as a table-driven test, at least one row of each table through the production composition.
- A3. With `CI` and `KAWAI_FULL_PROPERTIES` unset, a declared-300 test executes 75 cases with seeds `SEED+0 … SEED+74`, and with `CI=true` it executes 300 (PC1).
- A4. `throttled-reconnect` has no assertion on a duration or a ratio of durations, and `output-coalescing` waits allow at least half the test timeout.
- A5. After a full runner run, no `pre-migration-*` backup exists in a non-migration file's root (TD1), and helper copies open at the latest schema version (TD2).
- A6. `bun run check --full-properties` on a tree with a `reduced` record runs and records `full` (RU4).
- A7. AGENTS.md's Commands paragraph states the retry, the case profile, `--no-retry`, and `--full-properties`.

### Invariants

- I1. A main-batch failure is never retried, and CI behavior is unchanged.
- I2. A reduced run's seeds are a prefix of the full run's.
- I3. Production `initDatabase` and the `database-safety` backup rule are unchanged.
- I4. Test titles of the counted tests are unchanged.
- I5. The content key is unchanged; records without the new fields read as no retries and an unknown profile.

### Scope

- `scripts/test-runner.ts`
- `scripts/runPlan.ts`
- `scripts/planBatches.ts`
- `scripts/check.ts`
- `scripts/lib/checkRun.ts`
- `scripts/lib/junitReports.ts`
- `scripts/__tests__/**`
- `src/server/checks/checkRecords.ts`
- `src/server/__tests__/helpers/propertyCases.ts`
- `src/server/__tests__/helpers/testDatabase.ts`
- `src/server/__tests__/**/*.test.ts`
- `AGENTS.md`

### Verification

- V1. Table-driven tests of RT1–RT6 and RU1–RU5, with the production-composition rows, and with mutants: the rerun removed (kills RT3), the F ≤ 2 bound removed (kills RT5), the main-batch guard removed (kills RT1), and the profile check in reuse removed (kills RU4).
- V2. The PC1 exhaustive test, plus the runner probe file. Mutants: the `CI` check removed, `ceil` replaced by `floor`, and the seed offset shifted by one.
- V3. TD1 and TD2 tests. Mutants: the helper's copy skipped (kills TD1), and the template not checkpointed (kills TD2 through a missing-table read).
- V4. Both timing tests run 5 times serially next to a saturating CPU load and pass, with output kept as evidence.
- V5. A full `bun run check` before and after, on an otherwise idle machine, reporting total test work from the timings record. Evidence only, not a pass bound.

### Excluded

- X1. CI workflow changes and `test:ci` behavior.
- X2. Changes to `database-safety` and production database code.
- X3. Changing the worker count or the slow-tier definition.
- X4. Retries for any file outside `REAL_TMUX_FILES`.
