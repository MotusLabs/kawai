# Design

## Context

See proposal.md, "Why". Current state that shapes the approach:

- `scripts/runPlan.ts` `runBatchesAndPublish` runs the planned batches in order: the parallel main batch, then one batch per real-tmux file (`REAL_TMUX_FILES` in `scripts/planBatches.ts`, 7 files). `runCommand` throws on a non-zero exit, so the first failing batch stops the run and later real-tmux files never run.
- `scripts/lib/checkRun.ts` records a pass only when every step passed and the tree is unchanged. The test list (`scripts/lib/junitReports.ts`) is all-or-nothing over a manifest of planned report names written before the first batch.
- `CheckRecord` (`src/server/checks/checkRecords.ts`) holds key, tree, Bun, platform, time, worktree, steps, and an optional test-list pointer. The content key holds no run options.
- CI runs `bun run test:ci`, which is `--skip-real-tmux`, with `CI=true` (GitHub Actions). Real-tmux files run only locally. The e2e job already installs tmux (`.github/workflows/ci.yml`, "Ensure tmux is available"); why `test:ci` skips real-tmux files is not recorded.
- The 7 real-tmux files take about 90–110 s serially and start `src/server/index.ts` as a child process. They import no product module directly, except `hibernation` (`../db`) and `chatRename` (`../../shared/types`), so import-following selection (`scripts/affected-tests.ts`, Bun `--changed`) cannot see what they exercise.
- From 2026-10-10 to 2026-11-10, the server source files changed on master were mostly under `chat/` (1,447 file changes), `team/` (685), and `plans/` (602). The terminal path (`terminal/`, `ws/`, `sessions/`, `SessionManager.ts`, `tmux*.ts`) changed rarely.
- Heavy property tests hardcode counts (`const CASES = 300`) and seed each case as `mulberry32(SEED + index)`. 9 test files declare a `CASES` or `SEQUENCES` constant, 6 of them 50 or more. Titles quote the count, and coverage citations quote titles verbatim.
- `throttled-reconnect.integration.test.ts:625` asserts a byte ratio and `:632` a wall-clock ratio, both `< 0.75`. `output-coalescing.integration.test.ts:197` waits 10 s for `terminal-ready` inside a 60 s test.
- Contention came from inside the workspace, not from the shared node. On 2026-11-10 the kawai server ran `openspec list` in every worktree at once on each 30 s reconciliation (up to 48 processes at a time over 131 worktrees). Those bursts filled the workspace's 6-CPU quota (`cpu.max` 600000/100000), so its tasks waited for a CPU about 25% of the time (`/sys/fs/cgroup/cpu.pressure` some avg60, up to 53%), and `cpu.stat` shows the cgroup throttled in about a quarter of its periods since the workspace started. bounded-openspec-discovery (PR #384, released as v1.0.0-3372 on 2026-11-11) runs at most 3 at once and reuses unchanged results; pressure since is about 1.5% some avg60. `/proc/loadavg` (22–36 on 2026-11-10) reports the whole 16-CPU node and does not measure this. Any contention figure in this change means that cgroup pressure, never the load average.
- `initDatabase` on a new file took 0.56–1.18 s while the workspace was contended and wrote 4 pre-migration backups of about 1.2 MB each (`database-safety` requires a backup before each pending migration). 176 server test files call `initDatabase`, many per test.

## Goals / Non-Goals

**Goals:**
- A real-tmux timing failure costs one file's rerun, not a full check.
- Local checks run fewer generated cases without changing what CI certifies.
- Fresh test databases cost a file copy instead of a migration and its backups.

- A full check runs real-tmux files only for changes that can affect them, and a daily run covers drift that no diff shows.

**Non-Goals:**
- Changing `database-safety` or production `initDatabase`.
- Retrying main-batch files, or any file in CI.
- Running real-tmux files in per-PR CI.
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
- Rerunning immediately after the failure. Rejected: the cause, CPU contention, is usually still present then.

### D3. Record fields and reuse

`CheckRecord` gains `retries?: { file, failures: string[] }[]` and `caseProfile?: 'reduced' | 'full'`. An absent field reads as no retries and an unknown profile. The content key is unchanged. Reuse depends on the request:
- `--full-properties` reuses only a `full` or unknown record (every pass before this change ran declared counts);
- the default request reuses any record.

The pre-push hook accepts any pass. CI runs the declared counts for every merge.

### D4. One case-count helper over a prefix of the same seeds

`src/server/__tests__/helpers/propertyCases.ts` exports `propertyCases(declared)`. It returns `declared` when `declared < 50`, when `CI === 'true'`, or when `KAWAI_FULL_PROPERTIES === '1'`. Otherwise it returns `ceil(declared / 4)`. Tests keep `const CASES = 300` for titles and loop to `propertyCases(CASES)`, so a reduced run executes exactly the first k seeds of the full run. A local failure therefore reproduces in CI and the reverse. `bun run check --full-properties` exports `KAWAI_FULL_PROPERTIES=1` to the test step and records `caseProfile: 'full'`. Otherwise the check records `reduced`, or `full` when `CI=true`.

Alternative: a random subset of seeds. Rejected, because it breaks reproduction between local runs and CI.

### D5. A template database per run root

Before the first batch, the runner opens `<runRoot>/template.db` with `initDatabase`, then closes it; the database uses a rollback journal, so the closed file is self-contained, and the build fails if a `-wal`, `-shm`, or `-journal` file remains. It exports `KAWAI_TEST_DB_TEMPLATE`, and a build failure fails the run, naming the migration. `src/server/__tests__/helpers/testDatabase.ts` `freshTestDatabase(path)` copies the template to `path` and calls `initDatabase({ path })`, which finds no pending migration and takes no pre-migration backup (its `startup` snapshot, taken on every open, still runs). Without the variable, under a bare `bun test`, it calls `initDatabase` on a new file.

Files migrate to the helper heaviest first. Migration, backup, and startup-refusal tests keep `initDatabase` on new files and are listed as such in the helper's header.

Alternatives:
- A test-only branch in production `initDatabase`. Rejected: test hooks would ship.
- `mock.module` in the preload. Rejected: it is process-wide, and it would also replace the migrations under test.

### D6. Real-tmux selection by declared paths

Each real-tmux file carries `// @exercises: <globs>` in its first 20 lines, beside `@reads`. A full run selects a real-tmux file when the changed set intersects its globs, the file itself, or the shared triggers. The changed set is `git diff --name-only <merge-base>`, the working tree against the merge-base of HEAD with the local `origin/master` ref, plus untracked non-ignored files. The runner does no fetch. The shared triggers are `.bun-version`, `package.json`, `bun.lock`, `tsconfig*.json`, `scripts/test-runner.ts`, `scripts/planBatches.ts`, `scripts/runPlan.ts`, `scripts/test-preload.ts`, `src/server/index.ts`, `src/server/bootstrap.ts`, and the helper files the real-tmux files import. The list lives in one constant beside `REAL_TMUX_FILES`. Without a merge-base, every file runs.

A guard test, in the `readsGuard` style, fails when a real-tmux file lacks the header or a glob matches no tracked file. Explicit file arguments and `--all-real-tmux` bypass selection. The record names skipped files and the merge-base.

The content key is unchanged, so a record reused on the same tree carries the earlier selection. That is sound: the tree is identical, and master's own changes were selected against their own merge-bases when they landed.

Alternatives:
- Import following. Rejected, because the tests reach the product through a child process.
- Selecting by commit messages or a manual flag. Rejected, because neither is mechanical.

### D7. A scheduled workflow instead of per-PR CI

`.github/workflows/nightly-real-tmux.yml` runs on `schedule` (daily) and `workflow_dispatch`, on master. It installs tmux as the e2e job does and runs `bun run test --all-real-tmux` over the real-tmux files only. On failure, it uses `gh issue` to comment on the open issue labeled `nightly-real-tmux`, or opens one, naming the failing tests and the run URL. Why `test:ci` skips these files is unknown, so the first task is a dispatched trial. If the files cannot pass on a clean master within three trial runs, implementation stops and the owner decides between fixing the CI environment and a local scheduler.

Alternatives:
- A per-PR CI job. The owner chose the nightly run (2026-11-10).
- A local cron. The workspace has no cron, and a cloud routine cannot reach the workspace's tmux.

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

### Selection decision table (real-tmux file × changed set)

Inputs: merge-base available; `--all-real-tmux` or the file named explicitly; changed set ∩ shared triggers; changed set ∩ (the file's globs ∪ the file itself). Output: run or skip, as reported.

| id | merge-base | forced or named | ∩ triggers | ∩ own | result |
|---|---|---|---|---|---|
| SE1 | * | yes | * | * | run |
| SE2 | none | no | * | * | run |
| SE3 | yes | no | non-empty | * | run |
| SE4 | yes | no | empty | non-empty | run |
| SE5 | yes | no | empty | empty | skip, unaffected |

Completeness: forced → SE1; not forced and no merge-base → SE2; otherwise triggers non-empty → SE3; else own non-empty → SE4; else SE5. Exactly one row per combination. Guard rows: G1 a missing header fails the guard; G2 a glob matching no tracked file fails the guard.

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
- **SE rows:** SE4 and SE5 run through the real runner in a temporary git repository with an `origin/master` ref and two fixture real-tmux files, observed by which files' JUnit reports exist. The rest may use the pure selector.

## Risks / Trade-offs

- [A real regression in a real-tmux file passes on its rerun] → It must fail twice in a row to be caught. The record names every retry, the runner prints a retry warning, and the real-tmux behavior assertions stay strict. A failure on the rerun fails the step.
- [Reduced local counts miss a counterexample beyond the first quarter] → CI runs the declared counts on every PR, and `--full-properties` gives the same locally. Authors of new properties keep choosing declared counts as before.
- [A template built from a broken migration] → The build fails the run loudly, naming the migration (D5), and migration tests still run every migration on new files.
- [A wrong or missing `@exercises` glob lets a terminal regression through a local check] → The guard rejects missing and dead globs, the shared triggers cover entry points, and the nightly run fails within a day, opening an issue.
- [The nightly workflow cannot run real-tmux on GitHub runners] → The first task is a dispatched trial with a stop rule (D7).
- [Copying a database mid-write] → The runner closes the template before any batch starts and fails if a `-wal`, `-shm`, or `-journal` file remains. Copies are made only from the closed file.

## Migration Plan

1. Land D1 alone first; it is safe on its own.
2. Trial the nightly workflow by dispatch (D7). Then land D6 and D7 together, so selection never lands without the daily full run.
3. Land D2/D3, the runner and record changes, with their tests.
4. Land D4: the helper plus the 6 files with declared counts of 50 or more.
5. Land D5: the runner template and the helper, then migrate files heaviest first by recorded duration.
6. Update AGENTS.md's Commands paragraph.

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
- A7. AGENTS.md's Commands paragraph states the selection, `--all-real-tmux`, the nightly run, the retry, `--no-retry`, the case profile, and `--full-properties`.
- A8. Every row SE1–SE5 and G1–G2 holds as a table-driven test, with SE4 and SE5 through the production runner.
- A9. A dispatched run of the nightly workflow on master runs all 7 real-tmux files. A forced failure comments on, or opens, the `nightly-real-tmux` issue.

### Invariants

- I1. A main-batch failure is never retried, and CI behavior is unchanged.
- I2. A reduced run's seeds are a prefix of the full run's.
- I3. Production `initDatabase` and the `database-safety` backup rule are unchanged.
- I4. Test titles of the counted tests are unchanged.
- I5. The content key is unchanged; records without the new fields read as no retries and an unknown profile.
- I6. Selection never skips a real-tmux file when there is no merge-base, when forced, or when a shared trigger changed.

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
- `scripts/affected-tests.ts`
- `.github/workflows/nightly-real-tmux.yml`
- `AGENTS.md`

### Verification

- V1. Table-driven tests of RT1–RT6 and RU1–RU5, with the production-composition rows, and with mutants: the rerun removed (kills RT3), the F ≤ 2 bound removed (kills RT5), the main-batch guard removed (kills RT1), and the profile check in reuse removed (kills RU4).
- V2. The PC1 exhaustive test, plus the runner probe file. Mutants: the `CI` check removed, `ceil` replaced by `floor`, and the seed offset shifted by one.
- V3. TD1 and TD2 tests. Mutants: the helper's copy skipped (kills TD1), and the template not checkpointed (equivalent under the rollback journal: committed transactions are already in the main file, so the leftover-file check guards this instead).
- V4. Both timing tests run 5 times serially next to a CPU-saturating load inside the workspace, with `cpu.pressure` some avg10 of 50% or more recorded during each run, and pass. Output and pressure readings are kept as evidence.
- V5. A full `bun run check` before and after, on an otherwise idle machine, reporting total test work from the timings record. Evidence only, not a pass bound.
- V6. SE1–SE5, G1–G2 tests. Mutants: the shared-trigger check removed (kills SE3), the no-merge-base fallback removed (kills SE2), and the own-file match dropped (kills SE4).
- V7. The nightly workflow's dispatched trial runs and one forced-failure run, with their run URLs and the issue link kept as evidence.

### Excluded

- X1. Changes to the per-PR CI workflow and `test:ci` behavior.
- X2. Changes to `database-safety` and production database code.
- X3. Changing the worker count or the slow-tier definition.
- X4. Retries for any file outside `REAL_TMUX_FILES`.
