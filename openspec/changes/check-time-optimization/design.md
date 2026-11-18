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

## Landed implementation contract (PRs #381, #389, #393, historical)

The contract the implementation was judged against, kept for history with its clause bullets rewritten from `- A1.` to the parseable `- A1:` form (2026-11-18); the clause texts are unchanged. Below it is called the landed contract, and its ids are written L-A1, L-I1, and so on. The parsed contract of this change is the closeout contract at the end of this file.


### Acceptance

- A1: A full check where one real-tmux file fails once and passes when rerun alone records a pass that names the file and its first-attempt failures (RT3).
- A2: Every row RT1–RT6 and RU1–RU5 holds as a table-driven test, at least one row of each table through the production composition.
- A3: With `CI` and `KAWAI_FULL_PROPERTIES` unset, a declared-300 test executes 75 cases with seeds `SEED+0 … SEED+74`, and with `CI=true` it executes 300 (PC1).
- A4: `throttled-reconnect` has no assertion on a duration or a ratio of durations, and `output-coalescing` waits allow at least half the test timeout.
- A5: After a full runner run, no `pre-migration-*` backup exists in a non-migration file's root (TD1), and helper copies open at the latest schema version (TD2).
- A6: `bun run check --full-properties` on a tree with a `reduced` record runs and records `full` (RU4).
- A7: AGENTS.md's Commands paragraph states the selection, `--all-real-tmux`, the nightly run, the retry, `--no-retry`, the case profile, and `--full-properties`.
- A8: Every row SE1–SE5 and G1–G2 holds as a table-driven test, with SE4 and SE5 through the production runner.
- A9: A dispatched run of the nightly workflow on master runs all 7 real-tmux files. A forced failure comments on, or opens, the `nightly-real-tmux` issue.

### Invariants

- I1: A main-batch failure is never retried, and CI behavior is unchanged.
- I2: A reduced run's seeds are a prefix of the full run's.
- I3: Production `initDatabase` and the `database-safety` backup rule are unchanged.
- I4: Test titles of the counted tests are unchanged.
- I5: The content key is unchanged; records without the new fields read as no retries and an unknown profile.
- I6: Selection never skips a real-tmux file when there is no merge-base, when forced, or when a shared trigger changed.

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

- V1: Table-driven tests of RT1–RT6 and RU1–RU5, with the production-composition rows, and with mutants: the rerun removed (kills RT3), the F ≤ 2 bound removed (kills RT5), the main-batch guard removed (kills RT1), and the profile check in reuse removed (kills RU4).
- V2: The PC1 exhaustive test, plus the runner probe file. Mutants: the `CI` check removed, `ceil` replaced by `floor`, and the seed offset shifted by one.
- V3: TD1 and TD2 tests. Mutants: the helper's copy skipped (kills TD1), and the template not checkpointed (equivalent under the rollback journal: committed transactions are already in the main file, so the leftover-file check guards this instead).
- V4: Both timing tests run 5 times serially next to a CPU-saturating load inside the workspace, with `cpu.pressure` some avg10 of 50% or more recorded during each run, and pass. Output and pressure readings are kept as evidence.
- V5: A full `bun run check` before and after, on an otherwise idle machine, reporting total test work from the timings record. Evidence only, not a pass bound.
- V6: SE1–SE5, G1–G2 tests. Mutants: the shared-trigger check removed (kills SE3), the no-merge-base fallback removed (kills SE2), and the own-file match dropped (kills SE4).
- V7: The nightly workflow's dispatched trial runs and one forced-failure run, with their run URLs and the issue link kept as evidence.

### Excluded

- X1: Changes to the per-PR CI workflow and `test:ci` behavior.
- X2: Changes to `database-safety` and production database code.
- X3: Changing the worker count or the slow-tier definition.
- X4: Retries for any file outside `REAL_TMUX_FILES`.

## Closeout (proposed 2026-11-18)

### Current state (source pin `f52963d0`)

- Landed: every requirement of the dev-checks delta, through PR #381 (`80973e49`, D1), PR #389 (`1421e437`, selection and the nightly run), and PR #393 (`4488b150`, retry, records and profile, reduced cases, the template database). After `4488b150`, one commit touched this change's scripts: `8692da13` (extract-agent-runtime task 6.4) added the agent-runtime package's tests to the root runner's batches. The closeout's preserved-behavior tests run on the current runner, not on `4488b150`.
- Every scenario of the delta (22) carries a `@covers: dev-checks › …` annotation.
- The nightly workflow has a `concurrency` group (`.github/workflows/nightly-real-tmux.yml:22-24`, `group: nightly-real-tmux`, `cancel-in-progress: false`). The tasks.md note that it has none is obsolete; it was true of the trial workflow only.

### Receipts for tasks 2.1 and 2.2 (read 2026-11-18 from GitHub, read-only)

| Receipt | Run or issue | What it shows |
| --- | --- | --- |
| Dispatched run on master (V7, L-A9 first half) | Actions run 43102992960, `workflow_dispatch`, master `4488b150`, success | the log line `nightly-real-tmux: 7 passed, 0 failed` |
| Forced failure (V7, L-A9 second half) | Actions run 43102975960, `workflow_dispatch` with `force_failure`, master `4488b150`, failure | `7 passed, 1 failed`; the report step logged `nightly-real-tmux: create https://github.com/MotusLabs/kawai/issues/394` |
| The issue | #394 "Nightly real-tmux run failed", label `nightly-real-tmux`, open | names the forced-failure file and its test |
| Daily schedule | runs 43208433239 (11-12) through 44078591177 (11-17), master, all success | the latest logs `7 passed, 0 failed` |

Three earlier dispatches the same evening ended in `startup_failure` (runs 43095125222, 43095129212, 43095779275); the D7 stop rule counts trial runs that ran, and the next run passed.

The "comment on the open issue" path has run only in its unit test (`scripts/__tests__/nightlyRealTmux.test.ts` › `with an open nightly issue, the failure comments on the oldest one instead of opening another`). Issue #394 is still open, so the next real failure comments on it. Closing #394 is the owner's housekeeping, not part of this change.

### Proposed retirements (need the owner's approval)

| Item | Why | Proposed disposition |
| --- | --- | --- |
| Task 6.2, V5 (a full check before and after) | The "before" tree's check cannot be rerun on the machine and load of 2026-11-10, so the comparison would not measure this change. It was evidence only, never a pass bound, and no scenario depends on it. | Retire. Claim no check-time figure. |
| Task 1.3, V4 (both timing tests 5 times under CPU saturation, plus the negative control) | It is a load and timing probe, not a behavior check; the behavior it guards (L-A4: no duration assertion, half-timeout deadlines) is checked structurally by grep and by the two `Real-tmux tests do not fail on machine speed` scenarios' tests. Since then, six scheduled nightly runs passed all 7 files. A loaded run remains possible, so this retirement is a judgment call, not an impossibility. | Retire, or keep as an owner-gated probe the closeout runs once with its raw log. The owner chooses at plan approval. |

### What the closeout preserves

The real-tmux selection with its shared-trigger and no-merge-base floor (L-I6), the main-batch-never-retried rule and the two-file retry bound (L-I1, RT1, RT5), the recorded `retries` and `caseProfile` with the `--full-properties` reuse rule (RU4), and the reduced profile's seed prefix (L-I2). The closeout changes only test call shapes.

### Oracle evidence map

At the source pin `f52963d0` the SE, RT, RU, and pre-push-profile rows had no literal titles: their tests came from loops. Closeout task 7.1 (commit `c1c14b6d`) unrolled each loop into literal `test` calls whose titles equal the rows' rendered text, with the tables, bodies, order, and counts unchanged (24, 14, 19, and 4 tests per file, identical before and after by their JUnit lists). Every citation below is literal at the closeout head and resolves through `parseCitation` and `testTitles` (V1's preflight).

- **SE1**: `scripts/__tests__/realTmuxSelection.test.ts` › `SE1: merge-base yes, forced true, changed [] → run (forced)`; `scripts/__tests__/realTmuxSelection.test.ts` › `SE1: merge-base none, forced true, changed [bun.lock, src/server/terminal/a.ts] → run (forced)`
- **SE2**: `scripts/__tests__/realTmuxSelection.test.ts` › `SE2: merge-base none, forced false, changed [] → run (no-merge-base)`; `scripts/__tests__/realTmuxSelection.test.ts` › `SE2: merge-base none, forced false, changed [src/server/plans/a.ts] → run (no-merge-base)`
- **SE3**: `scripts/__tests__/realTmuxSelection.test.ts` › `SE3: merge-base yes, forced false, changed [bun.lock] → run (shared-trigger)`; `scripts/__tests__/realTmuxSelection.test.ts` › `SE3: merge-base yes, forced false, changed [.bun-version, src/server/terminal/a.ts] → run (shared-trigger)`
- **SE4**: `scripts/__tests__/realTmuxSelection.test.ts` › `SE4: merge-base yes, forced false, changed [src/server/terminal/outputCoalescer.ts] → run (declared-path)`; `scripts/__tests__/realTmuxSelection.test.ts` › `SE4: merge-base yes, forced false, changed [src/server/__tests__/output-coalescing.integration.test.ts] → run (declared-path)`; production: `src/server/__tests__/realTmuxSelection.integration.test.ts` › `SE4 through the real runner: a change in one file's declared area runs only that real-tmux file`
- **SE5**: `scripts/__tests__/realTmuxSelection.test.ts` › `SE5: merge-base yes, forced false, changed [] → skip (unaffected)`; `scripts/__tests__/realTmuxSelection.test.ts` › `SE5: merge-base yes, forced false, changed [src/server/plans/a.ts, notes/x.md] → skip (unaffected)`; production: `src/server/__tests__/realTmuxSelection.integration.test.ts` › `SE5 through the real runner: a change outside every declared area and trigger skips every real-tmux file`
- **G1**: `scripts/__tests__/realTmuxSelection.test.ts` › `G1: a real-tmux file without an @exercises header fails the guard, naming the file`
- **G2**: `scripts/__tests__/realTmuxSelection.test.ts` › `G2: a glob matching no tracked file fails the guard, naming the file and the glob`
- **RT1**: `scripts/__tests__/runPlanRetry.test.ts` › `RT1: main fail, F=1, retries on, reruns pass → fail`; `scripts/__tests__/runPlanRetry.test.ts` › `RT1: main fail, F=0, retries off, reruns pass → fail`
- **RT2**: `scripts/__tests__/runPlanRetry.test.ts` › `RT2: main pass, F=0, retries on, reruns pass → pass`; `scripts/__tests__/runPlanRetry.test.ts` › `RT2: main pass, F=0, retries off, reruns pass → pass`
- **RT3**: `scripts/__tests__/runPlanRetry.test.ts` › `RT3: main pass, F=1, retries on, reruns pass → pass`; `scripts/__tests__/runPlanRetry.test.ts` › `RT3: main pass, F=2, retries on, reruns pass → pass`; production: `src/server/__tests__/realTmuxRetry.integration.test.ts` › `RT3 through the real runner: one real-tmux file fails once, passes alone, and the record names it`; record: `src/server/__tests__/checkRunReuse.test.ts` › `RT3's record names the retried file and its first-attempt failures`
- **RT4**: `scripts/__tests__/runPlanRetry.test.ts` › `RT4: main pass, F=1, retries on, a rerun fails → fail`; `scripts/__tests__/runPlanRetry.test.ts` › `RT4: main pass, F=2, retries on, a rerun fails → fail`
- **RT5**: `scripts/__tests__/runPlanRetry.test.ts` › `RT5: main pass, F=3, retries on, reruns pass → fail`; `scripts/__tests__/runPlanRetry.test.ts` › `RT5: main pass, F=7, retries on, reruns pass → fail`; `scripts/__tests__/runPlanRetry.test.ts` › `RT5: main pass, F=3, retries off, reruns pass → fail`
- **RT6**: `scripts/__tests__/runPlanRetry.test.ts` › `RT6: main pass, F=1, retries off, reruns pass → fail`; `scripts/__tests__/runPlanRetry.test.ts` › `RT6: main pass, F=2, retries off, reruns pass → fail`
- **RU1**: `src/server/__tests__/checkRunReuse.test.ts` › `RU1: default request, none record → run`
- **RU2**: `src/server/__tests__/checkRunReuse.test.ts` › `RU2: default request, reduced record → reuse`; `src/server/__tests__/checkRunReuse.test.ts` › `RU2: default request, full record → reuse`; `src/server/__tests__/checkRunReuse.test.ts` › `RU2: default request, unknown record → reuse`
- **RU3**: `src/server/__tests__/checkRunReuse.test.ts` › `RU3: full-properties request, full record → reuse`; `src/server/__tests__/checkRunReuse.test.ts` › `RU3: full-properties request, unknown record → reuse`
- **RU4**: `src/server/__tests__/checkRunReuse.test.ts` › `RU4: full-properties request, reduced record → run`; production: `src/server/__tests__/realTmuxRetry.integration.test.ts` › `RU4 through the real runner: --full-properties on a reduced pass runs again and records full`
- **RU5**: `src/server/__tests__/checkRunReuse.test.ts` › `RU5: --force with default request, none record → run`; `src/server/__tests__/checkRunReuse.test.ts` › `RU5: --force with full-properties request, none record → run`; `src/server/__tests__/checkRunReuse.test.ts` › `RU5: --force with default request, reduced record → run`; `src/server/__tests__/checkRunReuse.test.ts` › `RU5: --force with full-properties request, reduced record → run`
- **RU5 (full and unknown records)**: `src/server/__tests__/checkRunReuse.test.ts` › `RU5: --force with default request, full record → run`; `src/server/__tests__/checkRunReuse.test.ts` › `RU5: --force with full-properties request, full record → run`; `src/server/__tests__/checkRunReuse.test.ts` › `RU5: --force with default request, unknown record → run`; `src/server/__tests__/checkRunReuse.test.ts` › `RU5: --force with full-properties request, unknown record → run`
- **PC1**: `src/server/__tests__/propertyCases.test.ts` › `PC1: propertyCases(n) is n below 50 or under CI or the full flag, else ceil(n/4), for n 1–2,000 in 4 environments`
- **PC1 wiring (L-A3)**: `src/server/__tests__/caseProfileProbe.integration.test.ts` › `default: a declared-300 probe executes the first 75 seeds and the record says reduced`; `src/server/__tests__/caseProfileProbe.integration.test.ts` › `CI=true: the probe executes all 300 seeds and the record says full`; `src/server/__tests__/caseProfileProbe.integration.test.ts` › `--full-properties: the probe executes all 300 seeds and the record says full`
- **TD1**: `scripts/__tests__/testDbTemplate.test.ts` › `TD1 through the real runner: pre-migration backups exist only in the migration test's root; every child sees the template`
- **TD2**: `src/server/__tests__/testDatabase.test.ts` › `TD2: a copy of the template opens at the latest version, records exactly the registry, and takes no pre-migration backup`
- **L-A4 machine speed**: `src/server/__tests__/throttled-reconnect.integration.test.ts` › `single-attach sends under 75% of double-attach's bytes through the throttled proxy`; `src/server/__tests__/output-coalescing.integration.test.ts` › `ordered markers arrive in order, history precedes ready, pane renders all`
- **L-A9 nightly report**: `scripts/__tests__/nightlyRealTmux.test.ts` › `with no open nightly issue, the failure opens one with the label and the report`; `scripts/__tests__/nightlyRealTmux.test.ts` › `with an open nightly issue, the failure comments on the oldest one instead of opening another`; `scripts/__tests__/nightlyRealTmux.test.ts` › `the workflow runs daily and on dispatch, may write issues, and runs then reports through the script`
- **3.7 pre-push accepts any recorded pass**: `scripts/__tests__/pushReducedPass.test.ts` › `the pre-push hook accepts a reduced-profile pass`; `scripts/__tests__/pushReducedPass.test.ts` › `the pre-push hook accepts a reduced-profile pass with retries`; `scripts/__tests__/pushReducedPass.test.ts` › `the pre-push hook accepts a full-profile pass with retries`; `scripts/__tests__/pushReducedPass.test.ts` › `the pre-push hook accepts a unknown-profile pass`

### Landed clause map (task 6.3, carried by the closeout)

Every landed clause maps to the tests above, to a receipt, or to the closeout's mutant evidence (task 7.3, logs kept beside the change). Tests cite the Oracle evidence map's entries.

- **L-A1** (RT3's pass names the file and its first-attempt failures): RT3's record and production rows, plus the test-list rule `scripts/__tests__/junitReruns.test.ts` › `the rerun report replaces the failed first report: the pass, once, no duplicate entries`.
- **L-A2** (every RT1–RT6 and RU1–RU5 row a table-driven test, one row of each table through production): the RT1–RT6 and RU1–RU5 rows, through production via RT3's and RU4's production rows.
- **L-A3** (a declared-300 test runs 75 seeds locally, 300 under CI): PC1 and the three PC1 wiring rows.
- **L-A4** (no duration assertion; waits allow half the timeout): the L-A4 machine-speed rows, plus the structural grep proof of task 1.1 (PR #381, `80973e49`).
- **L-A5** (no pre-migration backups outside migration roots; copies at the latest version): TD1 and TD2.
- **L-A6** (`--full-properties` on a `reduced` record runs again and records `full`): RU4's unit and production rows.
- **L-A7** (AGENTS.md's Commands paragraph states the seven items): receipt — AGENTS.md's Commands section as landed in PR #393 (`4488b150`), guarded by the `@reads` machinery (`scripts/__tests__/reads.test.ts`).
- **L-A8** (SE1–SE5 and G1–G2 as table-driven tests, SE4 and SE5 through production): the SE1–SE5 and G1–G2 rows, through production via SE4's and SE5's production rows.
- **L-A9** (the nightly run executes all 7 files; a forced failure reports to the issue): the L-A9 nightly report rows plus the receipts (runs 42989716546, 43102992960, 43102975960, issue #394, the daily schedule runs).
- **L-I1** (a main-batch failure is never retried; CI unchanged): RT1's rows; receipt — per-PR CI kept `test:ci` (`--skip-real-tmux`), unchanged by PRs #381, #389, #393.
- **L-I2** (a reduced run's seeds prefix the full run's): PC1 (the property asserts the seed prefix) and the default PC1 wiring row.
- **L-I3** (production `initDatabase` and `database-safety` unchanged): receipt — PRs #381, #389, #393 touch no production database code; TD2 and `src/server/__tests__/testDatabase.test.ts` › `without a template (a bare bun test) the helper migrates a new file, taking its pre-migration backups` pin the behavior.
- **L-I4** (test titles unchanged): receipt — task 4.2's grep (no title line changed) and the closeout's before/after JUnit comparison of the four unrolled files (identical title lists, order, and counts).
- **L-I5** (the content key unchanged; old records read as no retries and unknown profile): `src/server/__tests__/checkRunReuse.test.ts` › `a record written before this change reads as no retries and an unknown profile`; `src/server/__tests__/checkRunReuse.test.ts` › `malformed retries or profile drop only themselves`.
- **L-I6** (selection never skips without a merge-base, when forced, or on a shared trigger): SE1, SE2, and SE3's rows plus `scripts/__tests__/realTmuxSelection.test.ts` › `without a merge-base every real-tmux file runs`; `scripts/__tests__/realTmuxSelection.test.ts` › `forced, every real-tmux file runs whatever the diff`; `scripts/__tests__/realTmuxSelection.test.ts` › `a change to the Bun pin or the lockfile runs every real-tmux file`; and `scripts/__tests__/realTmuxSelection.test.ts` › `an unreadable real-tmux file declares everything, so it is never skipped`.
- **L-V1** (retry/reuse tables with mutants RT3, RT5, RT1, RU4): the table rows plus task 7.3's mutant evidence.
- **L-V2** (PC1 exhaustive and probe; mutants CI check, ceil→floor, seed offset): PC1, the PC1 wiring rows, plus task 7.3's mutant evidence.
- **L-V3** (TD1/TD2 with the copy-skip mutant): TD1, TD2, plus task 7.3's mutant evidence.
- **L-V4** (timing tests under CPU saturation): not kept as a probe by the owner's plan approval; the closeout runs no load probe (contract I3, X1). The behavior it would have probed stays covered by the L-A4 machine-speed rows.
- **L-V5** (a full check before and after): retired by the owner's plan approval (the unrecoverable historical comparison, rev 2, 2026-11-18); no check-time figure is claimed.
- **L-V6** (SE/G tests with mutants SE2, SE3, SE4): the SE/G rows plus task 7.3's mutant evidence.
- **L-V7** (the nightly trial and forced-failure runs with their URLs): the receipts (runs 42989716546, 43102992960, 43102975960, issue #394, the daily schedule runs 43208433239–44078591177).

## Implementation contract

### Acceptance

- A1: Every oracle id SE1–SE5, G1–G2, RT1–RT6, RU1–RU5, PC1, TD1, and TD2 maps to at least one literal test title that the repository's title resolver finds at the closeout head (zero unresolved), and every landed clause L-A1–L-A9 maps to a test or a cited receipt.
- A2: The unrolled tests keep each row's inputs and assertions; each new title equals the text its template rendered, and no file's test count drops.
- A3: On the closeout head, the landed contract's named mutants (L-V1, L-V2, L-V3, L-V6) each fail their named row, with each mutant's script and log kept.
- A4: Tasks 2.1 and 2.2 cite the run ids and the issue of this design's receipt table; tasks 1.3, 6.2, and V4/V5 read as the owner decided through plan approval; nothing claims a check-time figure.
- A5: Only after A4 records the decisions: the dev-checks delta is synced into `openspec/specs/dev-checks/spec.md` byte-equal to this change's blocks, before per-result-suite's archive touches that file, and the change is archived; `specCoverageGuard.test.ts` passes.

### Invariants

- I1: No file under `scripts/` other than `scripts/__tests__/` changes, and no workflow file changes.
- I2: The selection floor (forced, no merge-base, shared trigger), the main-batch and two-file retry rules, the recorded retries and profile, and the seed prefix stay as the landed contract states (L-I1, L-I2, L-I6).
- I3: No load probe, timing run, forced nightly failure, or issue write is performed by the closeout unless the owner keeps 1.3 as a probe.

### Scope

- `openspec/changes/check-time-optimization/**`
- `scripts/__tests__/realTmuxSelection.test.ts`
- `scripts/__tests__/runPlanRetry.test.ts`
- `scripts/__tests__/pushReducedPass.test.ts`
- `src/server/__tests__/checkRunReuse.test.ts`
- `openspec/specs/dev-checks/spec.md`
- `openspec/changes/archive/**`

### Verification

- V1: A citation preflight (`parseCitation` plus `testTitles`) over the map reports zero malformed or unresolved citations at the closeout head.
- V2: The four unrolled files pass under `bun run test`, and each named mutant of A3 fails its row; logs kept.
- V3: `openspec validate check-time-optimization --strict` passes before the archive, and `scripts/__tests__/specCoverageGuard.test.ts` after it.
- V4: `bun run check --full-properties` passes on the clean committed closeout head under the pinned Bun, and `scripts/verify-result.ts` reports the head.

### Excluded

- X1: Retired or owner-gated measurements (1.3/V4, 6.2/V5), unless the owner keeps 1.3 as a probe.
- X2: Closing issue #394 or dispatching the nightly workflow.
- X3: Any change to the runner, the check machinery, CI, or the per-result-suite change, whose archive follows this one on the same main spec.
