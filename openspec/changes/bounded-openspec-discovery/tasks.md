# Tasks

## 1. Baseline evidence

- [ ] 1.1 Before any code change, on the live instance with no OpenSpec edits for 10 minutes, record one-second samples of `pgrep -fc 'openspec list --json'` and `/sys/fs/cgroup/cpu.pressure` for 10 minutes, and the worktree count. Keep the raw log. Verify: the log holds 600 samples, and the result reports the peak, the mean, and the pressure range (the V5 "before" half).

## 2. Fingerprint (D1)

- [ ] 2.1 Commit FP1–FP15 verbatim as a table-driven test in `src/server/__tests__/openspecFingerprint.test.ts`, over temporary directories built with Write-style fixtures under `/tmp` (umask 022). Commit it failing first, with `fingerprintOpenSpecInputs` exported but not implemented. Verify: the test exists and fails.
- [ ] 2.2 Implement `src/server/workspace/openspecFingerprint.ts` as D1 describes, with a header comment listing what it reads and why `null` never matches. Verify V1: FP1–FP15 pass, and each mutant fails its row: size dropped (FP3), mtime dropped (FP2), root path dropped (FP11), `archive/` walked (FP8), root entries skipped (FP9). Keep each mutant's script and log.

## 3. Reuse decision and cache (D2)

- [ ] 3.1 Commit RD1–RD5 and DO1–DO7 verbatim as table-driven tests in `src/server/__tests__/openspecDiscoveryReuse.test.ts`, over `shouldRunOpenSpec` and `refreshRepositoryOpenSpec` with an injected runner, cache, fingerprint function, and clock. Commit them failing first. Verify: the tests exist and fail.
- [ ] 3.2 Add `src/server/workspace/openspecDiscoveryCache.ts` (`shouldRunOpenSpec` and the cache map) and thread an optional `{ cache, fingerprint, now }` through `refreshRepositoryOpenSpec`. Without a cache it behaves as before. Report `{ runs, reused }`. Verify V2: 3.1 passes, the existing discovery, merge, and registry tests pass unchanged (A5), and each mutant fails its row: the age ignored (RD5), a failed result kept (DO3/DO4), the post-run fingerprint stored (DO6).

## 4. Pool (D3)

- [ ] 4.1 Commit the PL1 property and the QT1 test in `src/server/__tests__/openspecPool.test.ts`, failing first. Verify: both fail before 4.2.
- [ ] 4.2 Add `src/server/workspace/openspecPool.ts` (FIFO, size 3, peak and run counters) and route `defaultDiscoveryApi`'s runner through one module-level pool. Verify V3: PL1 passes with 300 cases at seed `0x0a5e`, and both mutants fail it (size 4, a slot leaked on throw). QT1 passes, and the timer-at-submission mutant fails it.

## 5. Coordinator wiring and logging (D2, D4)

- [ ] 5.1 Give `WorkspaceCoordinator` its own `OpenSpecDiscoveryCache` and an injectable clock, pass both through `refreshOpenSpec`, drop entries for worktrees the pass no longer lists, and log `workspace_openspec_pass` at debug level with `runs`, `reused`, `worktrees`, `poolPeak`, and `durationMs`. Update the coordinator's header comment: coalescing caps passes, and the pool caps processes. Verify: `workspaceCoordinator.test.ts` passes, and a new test there asserts one log line per pass with the summed counters (A6).
- [ ] 5.2 Add the PC1 composition test, `src/server/__tests__/workspaceOpenspecComposition.integration.test.ts`, with the stub executable in `src/server/__tests__/fixtures/openspec-stub/`. It needs real Git worktrees, and every spawned git call uses `cleanGitEnv`. Verify V4: steps 1–4 pass, and both bypass mutants fail their step (pool bypassed, step 1; cache bypassed, step 2).

## 6. Docs, coverage, and live evidence

- [ ] 6.1 Add the `@covers: openspec-visibility › …` annotations for every scenario of the two new requirements above their tests. Verify: `scripts/__tests__/specCoverageGuard.test.ts` passes.
- [ ] 6.2 Add or update the workspace-discovery bullet in `docs/architecture/` (fingerprint reuse, the 10-minute limit, the pool of 3, the debug line). Add a `docs/recovery-matrix.md` row: the fault is an input missed by the fingerprint, the mechanism is the 10-minute reuse limit, and the test is RD5's title. Verify: `recoveryMatrix.test.ts` passes.
- [ ] 6.3 After the change ships in a release and the live instance runs it, repeat 1.1 for 10 minutes and collect the `workspace_openspec_pass` lines. Verify V5: the peak is 3 or less, and the result reports runs per 10 minutes and the median pass duration beside 1.1's figures, with both raw logs attached.
- [ ] 6.4 Run `bun run check` on the clean committed tree (V6). Map every oracle id (FP1–FP15, RD1–RD5, DO1–DO7, PL1, QT1, PC1) to its test title and killed mutant, and A1–A6, I1–I4, and V1–V6 to evidence. Verify: no id is unmapped.
