# Design

## Context

Measured on 2026-10-19 (Bun 1.4.3, a replica of `scripts/test-runner.ts` with per-file JUnit timings):

```
main batch   449 files, one process, serial          411.8 s
  chatSessionManager.test.ts (5031 lines, 21 describes) 88.8 s   22%
  next 13 files (execution matrices, team/task/plan
  services and stores, two E08/E09 integration files)   ~110 s  -> 50%
  337 files                                              < 0.5 s each
~33 one-file processes (isolated, real-tmux, client)     ~30 s
```

- The workspace reports 16 CPUs (`nproc`, `os.availableParallelism()`), but its cgroup CPU quota is 6 (`cpu.max` reads `600000 100000`). Its memory limit is 18 GiB with OOM-group kill (12 GiB until 2026-10-19). Heavy commands share three concurrent slots (two until 2026-10-19), so up to three full suites can run at once on 6 CPUs. A serial suite keeps about one CPU busy.
- Bun 1.4's `bun test` offers `--parallel=<n>`, which implies `--isolate`: per-file global and module registry; `--no-isolate` keeps one per worker. It also offers `--timings=<file>` (per-file durations that make `--parallel` start the slowest first) and `--changed`.
- The runner sets one `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `LOG_FILE`, and `AGENTBOARD_DB_PATH` for the whole run. Tests reference these variables in 256 places. Many set their own, but any that rely on the runner's value would collide under parallel workers.
- Hand-kept isolation lists exist only because Bun 1.3's single process leaked module mocks and global patches between files. Each list entry has a comment describing such a leak.

### Measurements

Recorded 2026-10-21 in one exclusive window (`suite-run -x`; evidence under `/home/coder/kawai-lead/logs/ps-window/`, `<label>.summary`/`.load1`/`.exit`/`.jsonl` per run, `A.log`–`D2.log`, `22-runs/`, `24-runs/`). Peak memory is the sampler's process-tree PSS sum at 1 Hz; every run's summary also records the cgroup `memory.current` baseline, `memory.oom.group = 0`, and `cpu.max 600000 100000` (a 6-CPU quota).

**1.1 baseline** — the old runner, serial:

| Run | Exit | Wall | Peak PSS (kB) | Notes |
|---|---|---|---|---|
| Alone | 0 | 466.4 s | 1,079,656 | the D2 bar; cgroup peak anon 5.75 GB, load1 1.42 |
| Beside two old-runner suites | 0 | 1320.7 s | 961,796 | load1 1.12 |

**2.3, new runner, alone:**

| N | Wall | Peak PSS (kB) | load1 at start | Note |
|---|---|---|---|---|
| 1 | 474.5 s | 766,174 | 1.46 | |
| 2 | 524.8 s | 758,402 | 1.44 | |
| 4 | 357.2 s | 1,047,611 | 1.46 | |
| 6 | 246.2 s | 1,427,926 | 0.69 | 1.32× the serial peak, so excluded |

**2.3, loaded** — N=4 three times, each beside two N=1 suites; every run exit 0, no test failed at the 20 s default:

| Run | Wall | Peak PSS (kB) | load1 |
|---|---|---|---|
| 1 | 409.2 s | 1,016,900 | 1.69 |
| 2 | 408.1 s | 981,301 | 2.63 |
| 3 | 380.8 s | 991,373 | 1.33 |

**The chosen N is 4**: the largest measured N whose alone peak stays within the serial run's peak (N=6 exceeds it), its loaded triple passed, and the 6-CPU quota is above 4. This is the D2 rationale for the runner's `MEASURED_WORKERS = 4`, capped at the quota.

**Worker count**: the window's sampler recorded no worker pids (it matched the root's cmdline; the workers' argv differs — a sampler defect, the peaks are unaffected). The count is established instead by the hand probe (N=1, 2, 4, 6 each report exactly N distinct `--test-worker` pids and max=N; `logs/ps-a-probe.log`) and held by `scripts/__tests__/parallelWorkers.test.ts`; the window's argv record agrees (`parallelArgMax`: n6=6, each loaded run 4). For the short 2.4 ordering runs (~4 s) the 1 Hz sampler sometimes catches fewer pids than were spawned, so those runs are gated on exit, file count, and `parallelArgMax`, not on `distinctWorkerPids`.

**N=2 observation** (open): N=2 showed no speedup over N=1 in five runs at the same peak. It does not change the choice.

**1.1 per-file timings** — new runner at N=1, per-file isolation (`logs/ps-window/timings-n1.json`, written by `--timings --update-timings` on a full serial run; 573 files, 524.2 s summed). The 20 slowest, 49.2% of the total: chatSessionManager 51.0 s, throttled-reconnect.integration 30.3 s, promotionSteps 19.9 s, executionLandingMatrix 19.9 s, copy-mode-async.integration 12.7 s, executionRoundsMatrix 11.2 s, planExecution.integration 9.9 s, executionRounds 9.6 s, integrationLandingRules 9.5 s, executionScenarioMatrix 9.3 s, taskRevisionE09.integration 9.2 s, effectLifecycleTable 8.8 s, promotionService 8.5 s, integrationLanding 8.4 s, executionPlanWideChecks 8.1 s, promotion.integration 6.9 s, impactService 6.5 s, taskResultsE08.integration 6.5 s, integrationLanding.integration 6.2 s, effectResumeRounds 5.2 s.

## Goals / Non-Goals

**Goals:**
- Cut a full run's wall time from about 7.5 minutes to about 2, in the same memory slot.
- Remove the isolation lists, a recurring source of order-dependent CI failures.
- Give `per-result-suite` a slow tier to leave out of per-commit runs.

**Non-Goals:**
- Changing which tests exist or what they assert, beyond the split and the setup fixes below.
- Parallelizing e2e (Playwright stays `--workers=1`).
- Changing the team's slot count (three since 2026-10-19). Slots are workspace procedure outside the repository; D2's loaded measurement gives the evidence to revisit them.

## Decisions

### D1. One `bun test --parallel=N` over every non-tmux file
The runner passes every unit file (server, shared, client, and the former isolated sets) to a single `bun test --parallel=$KAWAI_TEST_WORKERS`, then runs the real-tmux files serially as today. A file that fails only under the parallel run stays in a one-file serial step, listed with its reason, until fixed. The list is expected to be empty. `KAWAI_TEST_WORKERS=1` passes `--parallel=1` explicitly: serial scheduling that still gives every file a fresh global and module registry; leaving the flag out would restore the shared-global batch. Every child also gets `--timeout=20000`: per-file isolation pays cold module compilation and per-test database backups inside hook/test time that the shared process amortized, and four main-batch tests (one db migration, three effect/landing fixture setups) crossed Bun's 5 s default on the first isolated full run — a pure timeout, no assertion or isolation failure; tests keep any explicit per-test timeout. Coverage runs inside this one invocation, so the lcov report is written once; every file outside the invocation is listed with its reason, and the reported percentage is expected to rise — today's lcov is mostly zero-padded by coverage-all.ts — a recorded baseline change, not a regression. Alternatives: sharding by hand across processes, rejected because it duplicates what Bun now does with scheduling. `--no-isolate`, rejected because it brings the leaks back.

### D2. Worker count from measurement, default fixed
Measure peak memory with a sampler over the runner's process tree (the runner pid and every descendant), summing PSS from `/proc/<pid>/smaps_rollup` at 1 Hz or more — RSS where PSS is unreadable; cgroup `memory.peak` is a since-boot high-water mark shared with every other workload and cannot attribute a peak to one run. Measure the serial runner and N = 1, 2, 4, 6, alone (counts above the CPU quota are not measured), and pick the largest measured N whose peak is at most the serial peak. Each measured run also records the cgroup `memory.current` baseline, `memory.oom.group`, and its distinct worker-pid count, which must equal N. Parallel and serial peaks are compared inside one exclusive window, and the loaded runs below stay mandatory. If none fits, retain the existing runner by default and treat parallel activation as blocked until memory is reduced; do not silently raise the budget. Fix it as the default in the runner, documented beside the measurement, and allow override through `KAWAI_TEST_WORKERS`; until 2.3 measures, the branch default is 1. CI uses the same measured default, capped by the available CPU count; it does not automatically raise the count to the runner's CPU count. Any higher CI override needs its own memory measurement within that runner's budget. Alternative: deriving N from free memory at run time, rejected because it is nondeterministic and racy against the other slots.

The CPU quota bounds N as well. Three suites at N = 6 would queue 18 workers on 6 CPUs, stretching each test toward Bun's 5 s per-test timeout, a known flake source under host load. So:
- The default is capped at the cgroup CPU quota (`cpu.max`, or `os.availableParallelism()` where no quota is set), never at the CPU count the platform reports. CPU counts above the quota are not measured.
- Each N is measured alone. The chosen N is then run three times with two serial full suites running beside it, standing in for the other slots. If any of those runs fails a test at the 20 s default or at a per-test budget from the timings report, step down to the next measured N.
- The loaded wall time is recorded beside the alone one. Whether a lone parallel run's gain survives a busy workspace is then evidence, not an assumption.

### D3. Per-file temporary directories
A preload creates a fresh temporary root on every isolated file load and points the four variables at it before application imports. A worker index alone is insufficient: sequential files on a reused worker must also get fresh paths. The parent runner owns a unique run root, each preload creates its file root beneath it, and the parent removes the run root after all children exit, including failure paths. Verify that the preload re-runs under `--parallel=1` as well as multiple workers. Before turning on parallelism, audit tests that read the runner's values without setting their own. The preload is registered by the runner itself (`--preload scripts/test-preload.ts`); bunfig.toml carries no test preload, because a preload there loads once per process under a plain serial `bun test` (probed: 3 files gave 1 root and a leak pair failed). A bare `bun test` keeps the old shared-process mode, and the preload sets only the four path variables — everything else passes through. Each run root carries an owner marker (the runner's pid and its `/proc/<pid>/stat` start time). SIGINT/SIGTERM forward the signal to the detached `bun test` child's whole process group, wait at most about 10 s, SIGKILL the group, remove the run root, and exit 130 or 143. At startup the runner removes only stale roots under its prefix: marked roots whose owner is dead (pid gone, or start time differs — pid reuse) or unmarked roots older than 24 h; a live concurrent run's root is never touched.

The `bun test` child is spawned detached and so leads its own process group. Signals sent to the runner's own group no longer reach a detached child, so the runner forwards SIGINT/SIGTERM to the child's group (`kill(-pid)`), escalates to a group SIGKILL after the bound, and kills a finished batch's leftover group members before the next batch starts or the run root is removed — no live process of a batch may write into a removed root. A runner killed with SIGKILL cannot clean up: its run root waits for the next sweep, and its child group runs until `bun test` ends, which the per-test timeout bounds. The sweep kills nothing. Follow-up for PR B: should the sweep keep a dead owner's root while the run's recorded child group still has members?

### D4. Timings record
Write per-file durations, from the JUnit report or `--timings` output, to `<git-common-dir>/kawai-checks/timings.json` after each full run. All worktrees share it, next to `check-dedup`'s records. Read it with `--timings`, and ignore it when it is missing or malformed. Use a per-run snapshot and atomically rename a unique temporary file into place after the run, so concurrent suites never read a partial record. Lost timing updates may affect scheduling only, never test selection or correctness.

### D5. Remove the floor: split `chatSessionManager.test.ts`
Split by its 21 describe blocks into files of at most 500 lines, named `chatSessionManager.<area>.test.ts`, with the shared fakes and builders moved to `__tests__/helpers/chatSessionManagerHarness.ts`. The 7.5 s test ("a transcript that appears long after the SDK id still arms the title tail") moves to fake timers or an injected clock. Its behavior assertion stays unchanged. The goal is no single file over about 20 s, so the parallel run's floor drops from 89 s.

### D6. Profile, then fix, the slow store and service files
The hypothesis to check first: these files pay per-test setup, a file-backed `initDatabase` (baseline schema, 12 migrations, a startup backup with `integrity_check`) or a real git repository per test. Profile three representative files (`teamAssignmentStore`, `teamTaskService`, `executionLandingMatrix`). Where setup dominates, share it per file (schema once, a copy or transaction rollback per test), or use the in-memory `schemaDb()` the stores already support. Tests whose subject is migration or backup behavior keep their file-backed setup.

### D7. Slow tier by name
The `*.integration.test.ts` suffix exists already, on 26 files. The slow tier is that suffix plus the real-tmux set. After D5 and D6, files still over 5 s are renamed into the tier, or listed with a reason (for example, a matrix whose assertions need its size). The timings report flags misplaced files, so the tier stays honest without manual tagging.

## Risks / Trade-offs

- [A test relies on running after another file (hidden order coupling)] → Per-file isolation exposes it as a failure. Fix the test, or park it in the serial list with a reason. Leaving it hidden is the worse outcome.
- [Memory peaks higher than measured under real load (several parallel suites at once)] → N is chosen against the serial peak, so concurrent parallel runs cost what concurrent serial runs cost today. Re-measure after adoption using `memsample.log`.
- [Several slots run parallel suites at once on the 6-CPU quota] → The default is capped by the quota and validated beside two serial suites (D2). A test that still nears its timeout under that load moves to the slow tier, or gets an explicit timeout with a reason; the timings report shows it.
- [Coverage under `--parallel` may not merge per-worker data] → Verify early (task 1.2). If it doesn't merge, the coverage run (master-only after `check-dedup`) keeps a serial invocation.
- [Bun 1.4 parallel-runner bugs] → The runner keeps `KAWAI_TEST_WORKERS=1` for serial scheduling with per-file isolation. Verify it independently: it does not reproduce the old shared-global main batch. Retain the legacy runner until the isolated path passes the migration checks.
- [Fixed ports or shared external resources (tmux sockets, HTTP ports) clash across workers] → Real-tmux files stay serial. Port-binding unit tests use port 0. The audit in D3 also lists fixed ports.

## Migration Plan

Land in this order, each step keeping the suite green: the per-worker directories and audit, then the parallel runner with any temporary serial list, then the timings record, the split, the setup fixes, and finally the tier renames. `KAWAI_TEST_WORKERS=1` disables parallel scheduling while retaining per-file isolation; rollback of isolation is reverting the runner commit.
