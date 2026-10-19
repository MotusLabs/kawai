# Tasks

## 1. Measure and prepare

- [ ] 1.1 Record the baseline: one serial full run's wall time, per-file timings, and peak memory (cgroup `memory.peak` or `memsample.sh`), saved in the design's Context or a note in `docs/`.
- [ ] 1.2 Check two Bun 1.4.3 behaviors in a scratch project and record the answers: whether a preload re-runs for every isolated file, including successive files under `--parallel=1`, and whether `--coverage` under `--parallel` writes one merged `lcov.info`.
- [ ] 1.3 Audit the tests that read the runner's `AGENTBOARD_DB_PATH`, `LOG_FILE`, `CLAUDE_CONFIG_DIR`, or `CODEX_HOME` without setting their own, and any fixed ports, and list them in the PR.

## 2. Parallel runner

- [ ] 2.1 Add per-file temporary roots for the four variables through a test preload beneath a parent-owned run root. Verify that concurrent files and sequential files on one worker get different paths, the preload runs before application imports, and all roots are cleaned after success and failure.
- [ ] 2.2 Rewrite `scripts/test-runner.ts`: one `bun test --parallel=$KAWAI_TEST_WORKERS` over all non-tmux unit files, then the real-tmux files serially, with a temporary serial list (each entry with its reason) for files that fail only in parallel. Keep `--skip-real-tmux` and the coverage path working. Verify that the full suite passes 3 times in a row locally and in CI, and that `KAWAI_TEST_WORKERS=1` passes with serial scheduling and per-file isolation.
- [ ] 2.3 Measure peak memory for N = 1, 2, 4, 6, 8, set the default to the largest N within the serial peak (retain the existing runner if none fits), and cap the CI default by available CPUs without raising it above the measured count, and document the number and the measurement in AGENTS.md's Commands paragraph. Run `bun run test` once, because a test reads AGENTS.md.
- [ ] 2.4 Delete the `ISOLATED_FILES`, `ISOLATED_CLIENT_FILES`, and `isolated/` handling once their files pass in the parallel step. Verify that each former entry passes 3 runs under different orderings (`--randomize` or seeds where Bun supports it).

## 3. Scheduling and the floor

- [ ] 3.1 Write per-file timings to `<git-common-dir>/kawai-checks/timings.json` after full runs and pass it with `--timings`. Use a per-run snapshot and atomic writes with unique temporary names. Verify concurrent writers never expose partial JSON, and that a missing or malformed file runs unordered without failing.
- [ ] 3.2 Split `chatSessionManager.test.ts` into files of at most 500 lines plus a shared harness module. Verify that the test count before and after is identical (compare the names from the JUnit report) and that no new file takes over 20 s.
- [ ] 3.3 Move the title-tail test to fake timers or an injected clock. Verify that it finishes in under 0.5 s and still fails when the title-tail arming is removed (a mutation check).

## 4. Setup costs and tiers

- [ ] 4.1 Profile `teamAssignmentStore`, `teamTaskService`, and `executionLandingMatrix` and record where per-test time goes.
- [ ] 4.2 Where setup dominates, share it per file or use `schemaDb()`, keeping file-backed setup for migration and backup subjects. Verify that each touched file's test names and count are unchanged and that its time drops.
- [ ] 4.3 Add the slow-tier selection option to the runner and the misplaced-file report (over 5 s outside the tier and not listed). Rename or list each file it reports. Verify that the option excludes every `*.integration.test.ts` and real-tmux file.

## 5. Integration check

- [ ] 5.1 Compare a full run with the step 1.1 baseline: wall time, peak memory, and test count (identical). Record the result in the PR.

## Workflow follow-up

- Archive after `check-dedup` is archived, so the `dev-checks` main spec exists for these ADDED requirements.
