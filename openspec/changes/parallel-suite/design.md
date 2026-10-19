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

- The workspace exposes 16 CPUs and has a 12 GiB memory limit with OOM-group kill. Heavy commands are limited to two concurrent slots for memory.
- Bun 1.4's `bun test` offers `--parallel=<n>`, which implies `--isolate`: per-file global and module registry; `--no-isolate` keeps one per worker. It also offers `--timings=<file>` (per-file durations that make `--parallel` start the slowest first) and `--changed`.
- The runner sets one `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `LOG_FILE`, and `AGENTBOARD_DB_PATH` for the whole run. Tests reference these variables in 256 places. Many set their own, but any that rely on the runner's value would collide under parallel workers.
- Hand-kept isolation lists exist only because Bun 1.3's single process leaked module mocks and global patches between files. Each list entry has a comment describing such a leak.

## Goals / Non-Goals

**Goals:**
- Cut a full run's wall time from about 7.5 minutes to about 2, in the same memory slot.
- Remove the isolation lists, a recurring source of order-dependent CI failures.
- Give `per-result-suite` a slow tier to leave out of per-commit runs.

**Non-Goals:**
- Changing which tests exist or what they assert, beyond the split and the setup fixes below.
- Parallelizing e2e (Playwright stays `--workers=1`).
- Raising the team's slot count. That's a separate decision once memory is measured.

## Decisions

### D1. One `bun test --parallel=N` over every non-tmux file
The runner passes every unit file (server, shared, client, and the former isolated sets) to a single `bun test --parallel=$KAWAI_TEST_WORKERS`, then runs the real-tmux files serially as today. A file that fails only under the parallel run stays in a one-file serial step, listed with its reason, until fixed. The list is expected to be empty. Alternatives: sharding by hand across processes, rejected because it duplicates what Bun now does with scheduling. `--no-isolate`, rejected because it brings the leaks back.

### D2. Worker count from measurement, default fixed
Measure peak RSS (cgroup `memory.peak`, or the summed RSS sampled by `memsample.sh`) for the serial runner and for N = 2, 4, 6, 8. Pick the largest N whose peak is at most the serial peak. Fix it as the default in the runner, documented beside the measurement, and allow override through `KAWAI_TEST_WORKERS`. CI on GitHub runners (4 vCPUs) uses the same variable, set to the runner's CPU count. Alternative: deriving N from free memory at run time, rejected because it is nondeterministic and racy against the other slot.

### D3. Per-worker temporary directories
If Bun exposes a worker index to test processes, the runner's preload derives per-worker subdirectories from it. If not, a preload creates a fresh temporary root per test file at load time and points the four variables at it. The per-file form is chosen if both work, because it also isolates files that run one after another on one worker. Before turning on parallelism, an audit lists the tests that read the runner's values without setting their own.

### D4. Timings record
Write per-file durations, from the JUnit report or `--timings` output, to `<git-common-dir>/kawai-checks/timings.json` after each full run. All worktrees share it, next to `check-dedup`'s records. Read it with `--timings`, and ignore it when it is missing or malformed.

### D5. Remove the floor: split `chatSessionManager.test.ts`
Split by its 21 describe blocks into files of at most 500 lines, named `chatSessionManager.<area>.test.ts`, with the shared fakes and builders moved to `__tests__/helpers/chatSessionManagerHarness.ts`. The 7.5 s test ("a transcript that appears long after the SDK id still arms the title tail") moves to fake timers or an injected clock. Its behavior assertion stays unchanged. The goal is no single file over about 20 s, so the parallel run's floor drops from 89 s.

### D6. Profile, then fix, the slow store and service files
The hypothesis to check first: these files pay per-test setup, a file-backed `initDatabase` (baseline schema, 12 migrations, a startup backup with `integrity_check`) or a real git repository per test. Profile three representative files (`teamAssignmentStore`, `teamTaskService`, `executionLandingMatrix`). Where setup dominates, share it per file (schema once, a copy or transaction rollback per test), or use the in-memory `schemaDb()` the stores already support. Tests whose subject is migration or backup behavior keep their file-backed setup.

### D7. Slow tier by name
The `*.integration.test.ts` suffix exists already, on 26 files. The slow tier is that suffix plus the real-tmux set. After D5 and D6, files still over 5 s are renamed into the tier, or listed with a reason (for example, a matrix whose assertions need its size). The timings report flags misplaced files, so the tier stays honest without manual tagging.

## Risks / Trade-offs

- [A test relies on running after another file (hidden order coupling)] → Per-file isolation exposes it as a failure. Fix the test, or park it in the serial list with a reason. Leaving it hidden is the worse outcome.
- [Memory peaks higher than measured under real load (two parallel suites at once)] → N is chosen against the serial peak, so two parallel runs cost what two serial runs cost today. Re-measure after adoption using `memsample.log`.
- [Coverage under `--parallel` may not merge per-worker data] → Verify early (task 1.2). If it doesn't merge, the coverage run (master-only after `check-dedup`) keeps a serial invocation.
- [Bun 1.4 parallel-runner bugs] → The runner keeps a `KAWAI_TEST_WORKERS=1` path that is today's serial behavior.
- [Fixed ports or shared external resources (tmux sockets, HTTP ports) clash across workers] → Real-tmux files stay serial. Port-binding unit tests use port 0. The audit in D3 also lists fixed ports.

## Migration Plan

Land in this order, each step keeping the suite green: the per-worker directories and audit, then the parallel runner with any temporary serial list, then the timings record, the split, the setup fixes, and finally the tier renames. Rollback at any point is `KAWAI_TEST_WORKERS=1`, or reverting the runner commit.
