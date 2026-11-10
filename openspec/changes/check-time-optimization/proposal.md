# Proposal

## Why

A full `bun run check` takes about 17 minutes: 849 test files, about 3,270 s of test work on 4 workers (the runner's timings record, 2026-11-10). On 2026-11-10, three of four full checks failed, each on one test. Two were real-tmux tests that failed for timing reasons, not behavior: `throttled-reconnect` on its wall-clock ratio and `output-coalescing` on a 10 s `terminal-ready` deadline, both under a load average of about 36 on 6 CPUs; a third run failed on a property case that hit the 20 s per-test timeout (`executionDiagnosisProperties`). A failure records nothing, so each one cost a full rerun, and one blocked a dev's commit for half an hour. Every push needs a recorded full pass, so check time and check flakiness are paid by every result the team lands.

## What Changes

- Real-tmux files run only when a change affects them. Each declares the paths it exercises in an `@exercises` header, and a guard test checks the headers. A full check runs a real-tmux file when the working tree's diff from its merge-base with `origin/master` touches those paths or a shared trigger: the Bun pin, the manifest and lockfile, the runner, the server entry points, or the test's own helpers. Otherwise the record lists the file as skipped, unaffected. Over the last month most server changes were in `chat/`, `team/`, and `plans/`, which no real-tmux file exercises.
- A scheduled GitHub Actions workflow runs every real-tmux file on master nightly and opens or updates an issue on failure. That catches drift no diff shows, such as a tmux or Bun upgrade. Per-PR CI stays unchanged.
- The two load-sensitive real-tmux tests assert facts the machine's speed cannot change. `throttled-reconnect` keeps its byte-ratio assertion (the throttled proxy turns bytes into time) and reports wall-clock times as diagnostics only. `output-coalescing` keeps its ordering assertions and waits for `terminal-ready` and the markers with liveness deadlines bounded by the test timeout instead of 10 s.
- A real-tmux file that fails no longer stops the remaining real-tmux files. After the serial batch, the runner reruns each failed selected real-tmux file once, alone. When at most two failed and every rerun passes, the unit step passes. The record names each retried file and its first-attempt failures. A main-batch failure, a third failed real-tmux file, or a failed rerun fails the run as today.
- Property, matrix, and model tests with a declared case count of 50 or more read their count through one helper. Local and hook runs execute the first quarter of the same seeded cases; CI (`CI=true`) and `bun run check --full-properties` execute the declared count. Test titles keep the declared count, so coverage citations stay valid. The record states which case profile ran.
- The runner migrates one template database per run, and test files copy it instead of migrating a fresh database (0.6–1.2 s and four 1.2 MB pre-migration backups each, measured 2026-11-10). Migration and backup tests keep migrating for real. Production `initDatabase` is unchanged.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `dev-checks`: adds the affected-only real-tmux selection with its `@exercises` declarations and the nightly full run, the real-tmux retry and its record fields, the load-independence rule for timing tests, the local case profile with its CI and `--full-properties` override, and the template test database.

## Impact

- `scripts/test-runner.ts`, `scripts/runPlan.ts`, `scripts/planBatches.ts`, `scripts/lib/checkRun.ts`, `scripts/lib/junitReports.ts`, `scripts/check.ts`, `src/server/checks/` (record fields), `scripts/test-preload.ts`.
- `src/server/__tests__/throttled-reconnect.integration.test.ts`, `output-coalescing.integration.test.ts`.
- A new test-support module for case counts and the template database; the 6 test files with a declared `CASES`/`SEQUENCES` constant of 50 or more; the server test files that migrate a fresh database per test, heaviest first.
- `scripts/affected-tests.ts` or a sibling for the `@exercises` selection, the 7 real-tmux test files' headers, a new `.github/workflows/nightly-real-tmux.yml`.
- `AGENTS.md` Commands paragraph (selection, `--all-real-tmux`, retry, case profile, `--full-properties`).
- No production code path or dependency changes. Per-PR CI keeps `test:ci` (`--skip-real-tmux`), so the selection and retry affect local runs only. The one new workflow is the scheduled nightly run.
- Non-goals: raising the worker count, changing per-PR CI, quarantining tests, and changing the pre-migration backup rule of `database-safety`.
