# Tasks

## 1. Measure and prepare

- [x] 1.1 Record the baseline: one serial full run's wall time, per-file timings, and peak memory from the process-tree PSS sampler (design D2), alone and with two other serial full suites running, saved in the design's Context or a note in `docs/`.
- [x] 1.2 Check two Bun 1.4.3 behaviors in a scratch project and record the answers: whether a preload re-runs for every isolated file, including successive files under `--parallel=1`, and whether `--coverage` under `--parallel` writes one merged `lcov.info`.
- [x] 1.3 Audit the tests that read the runner's `AGENTBOARD_DB_PATH`, `LOG_FILE`, `CLAUDE_CONFIG_DIR`, or `CODEX_HOME` without setting their own, and any fixed ports, and list them in the PR. HOME, XDG, fixed /tmp paths, ports, and tmux sockets are not runner-provided; a test that needs one sets its own.

## 2. Parallel runner

- [x] 2.1 Add per-file temporary roots for the four variables through a test preload beneath a parent-owned run root. Verify that concurrent files and sequential files on one worker get different paths, the preload runs before application imports, and all roots are cleaned after success and failure.
- [x] 2.2 Rewrite `scripts/test-runner.ts`: one `bun test --parallel=$KAWAI_TEST_WORKERS` over all non-tmux unit files, then the real-tmux files serially, with a temporary serial list for files that fail only in parallel — a real gate: every entry carries its reason, and the three green runs at the chosen N are the evidence that the remaining files belong in parallel. Keep `--skip-real-tmux` and the coverage path working. Verify that the full suite passes 3 times in a row locally and in CI, and that `KAWAI_TEST_WORKERS=1` passes with serial scheduling and per-file isolation. The preload is runner-only (`--preload`); bunfig.toml carries no test preload and a bare `bun test` keeps the shared-process mode. Each run root carries an owner marker; SIGINT/SIGTERM are bounded (forward to the child's whole process group, at most about 10 s, group SIGKILL, remove the root), a finished batch's leftovers are killed before the next batch or the root removal, and the startup sweep removes only dead owners' roots, or unmarked roots older than 24 h. Coverage runs as one invocation, with every excluded file listed and its reason.
- [x] 2.3 Measure peak memory and wall time for N = 1, 2, 4, 6, alone — peaks from the process-tree PSS sampler, with the memory.current baseline, memory.oom.group, and the distinct worker-pid count (which must equal N) recorded; counts above the CPU quota are not measured. Pick the largest N within the serial peak that also passes three runs beside two serial full suites with no test failing at the 20 s default or at a per-test budget from the timings report, stepping down otherwise. Retain the existing runner if none fits. Cap the default at the cgroup CPU quota (`cpu.max`, else `os.availableParallelism()`), locally and in CI, without raising it above the measured count. Verify the cap with a unit test for a quota below the reported CPU count. Document the number, the alone and loaded measurements, and the quota rule in AGENTS.md's Commands paragraph. Run `bun run test` once, because a test reads AGENTS.md.
- [x] 2.4 Delete the `ISOLATED_FILES`, `ISOLATED_CLIENT_FILES`, and `isolated/` handling once their files pass in the parallel step. Verify that each former entry passes 3 runs under different orderings (`--randomize` or seeds where Bun supports it).

## 3. Scheduling and the floor

- [x] 3.1 Write per-file timings to `<git-common-dir>/kawai-checks/timings.json` after full runs and pass it with `--timings`. Use a per-run snapshot and atomic writes with unique temporary names. Verify concurrent writers never expose partial JSON, and that a missing or malformed file runs unordered without failing.
- [x] 3.2 Split `chatSessionManager.test.ts` into files of at most 500 lines plus a shared harness module. Verify that the test count before and after is identical (compare the names from the JUnit report) and that no new file takes over 20 s.
- [x] 3.3 Move the title-tail test to fake timers or an injected clock. Verify that it finishes in under 0.5 s and still fails when the title-tail arming is removed (a mutation check).

## 4. Setup costs and tiers

- [x] 4.1 Profile `teamAssignmentStore`, `teamTaskService`, and `executionLandingMatrix` and record where per-test time goes.
- [x] 4.2 Where setup dominates, share it per file or use `schemaDb()`, keeping file-backed setup for migration and backup subjects. Verify that each touched file's test names and count are unchanged and that its time drops.
- [x] 4.3 Add the slow-tier selection option to the runner and the misplaced-file report (over 5 s outside the tier and not listed). Rename or list each file it reports. Verify that the option excludes every `*.integration.test.ts` and real-tmux file.

## 5. Integration check

- [x] 5.1 Compare a full run with the step 1.1 baseline: wall time, peak memory, and test count (identical). Record the result in the PR.

## Workflow follow-up

- Archive after `check-dedup` is archived, so the `dev-checks` main spec exists for these ADDED requirements.
