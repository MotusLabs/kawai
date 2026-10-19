# Proposal

## Why

The unit suite's wall time is one serial process. In a timed run on 2026-10-19, the main batch took 411.8 s for 449 files, one after another, on a 16-core workspace. The about 33 one-file isolated processes took about 30 s in total. A single file, `chatSessionManager.test.ts` (5031 lines, 21 describe blocks), took 88.8 s, 22% of the batch. The next 13 files took 6–19 s each and bring the share to 50%, while 337 files take under 0.5 s. Every full run holds one of the team's two memory slots for that whole time, so the length of a run sets everyone's queue. Bun 1.4 (`ci-bun-1-4`) can run test files in parallel worker processes, with a fresh global and module registry per file (`--parallel`, `--isolate`), and schedule the slowest first (`--timings`).

## What Changes

- The test runner runs the unit suite as one parallel, per-file-isolated `bun test` invocation with a fixed worker count chosen from measured memory, so the run fits the same memory slot it uses today.
- The hand-kept isolation lists (`ISOLATED_FILES`, `ISOLATED_CLIENT_FILES`, `isolated/`) fold into the parallel run once each file is shown to pass under per-file isolation. Real-tmux integration files keep their own serial step.
- Each worker gets its own temporary data, log, and config directories, so parallel files never share runner-provided paths.
- Recorded per-file timings from the last full run make the slowest files start first.
- `chatSessionManager.test.ts` is split by describe block into files under the 500-line guideline, which removes the single-file floor. Its 7.5 s title-tail test moves to fake timers.
- The slowest store and service files get profiled, and their dominant per-test setup cost is fixed where it is setup, not behavior under test.
- Cost tiers: the existing `*.integration.test.ts` suffix, plus the real-tmux set, marks the slow tier. The runner can include or exclude that tier, so `per-result-suite` can keep it out of per-commit runs.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `dev-checks`: the unit suite's execution: parallel isolated workers within the memory budget, per-worker temporary directories, slowest-first scheduling, and selectable cost tiers. The capability is introduced by `check-dedup`.

## Impact

- `scripts/test-runner.ts` (rewrite of the orchestration; the env setup stays).
- `src/server/__tests__/chatSessionManager.test.ts` split into several files. Test helpers shared between them move to a helper module.
- The slow store and service test files' setup (scope decided by profiling).
- Some test files renamed to `*.integration.test.ts` where the timings put them in the slow tier.
- `package.json` scripts (`test`, `test:ci`, `test:coverage`). Coverage must still produce `coverage/lcov.info`.
- Depends on `ci-bun-1-4` (the Bun 1.4 flags) and `check-dedup` (the `dev-checks` capability).
