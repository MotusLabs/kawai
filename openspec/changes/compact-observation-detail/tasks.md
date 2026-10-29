# Tasks

## 1. Contract and store

- [ ] 1.1 In `src/shared/processObservations.ts`, add the `turn_ended` phase fields (`thinkingSeconds`, `requestingSeconds`, `preparingToolSeconds`, `runningToolsSeconds`, `respondingSeconds`, `retryingSeconds`, `otherPhaseSeconds`) and `unmatchedResolutions`, and export `isDurableObservationKey` (D1, D4). Verify: a table test of the predicate over every prefix (K1/K2 inputs), with the mutant "`source:` classified ephemeral" killed.
- [ ] 1.2 In `ObservationStore`:
  - remove the `teams` parameter and the `process_observation_teams` reads and writes, with `forTeam` filtering on `team_id`;
  - write ledger rows only for durable keys;
  - deduplicate other keys through `ON CONFLICT(source_key) DO NOTHING`;
  - remove `EPHEMERAL_KEY` from `prune`.

  Update `schema.ts` for fresh databases only through the migration. Verify: T3 rows K1 and K2 as a table test, including K1 after pruning and K2 while the row exists. Mutants: "ledger for every key" (no ledger growth assertion) and "no ledger for durable keys" (re-recorded after prune).
- [ ] 1.3 Add an enumeration test that collects every source-key template under `src/server/metrics/` and asserts each prefix is classified with a reason. Verify: the test fails for an added unclassified `foo:` template (mutant).

## 2. Tracker

- [ ] 2.1 Accumulate `phaseSeconds` in `LiveTurn` instead of writing `activity` rows, and write the totals and `unmatchedResolutions` on `turn_ended` (D1). Verify:
  - T2 rows P-a to P-e as a table test;
  - the "Turn with many phase changes" and "Restart mid-turn" scenarios;
  - property P1 (seed 20261029, 300 cases).

  Mutant: "drop the open phase at finish" (kills P-b).
- [ ] 2.2 Stop writing tool and request start rows, write one row at completion, count unmatched resolutions, and move the `chat:` and `compaction:` lookups to `process_observations.source_key` (D2–D4). Verify:
  - T1 rows E1–E9 as a table test, with E3, E7 and E8 also through the production `ChatSessionManager` composition;
  - the scenarios "One call, one row", "Call open at turn end", "Answered question", "Auto-approved tool" and "Duplicate chat event";
  - property P2 (seed 20261030, 300 cases).

  Mutants: "write the start row" (kills E1 and P2) and "store the orphan resolution" (kills E7).

## 3. Migration and compaction

- [ ] 3.1 Add migration 21 `compact-observation-detail` to `MIGRATIONS` (D5, D6), and update the migration list in `docs/architecture/database.md`. Verify: oracle O-M1 on a fixture database, and the "Upgrade with ten days of detail" scenario. Mutant: "delete every `tool` row" (kills the kept result rows).
- [ ] 3.2 Add `compactDatabase` in `src/server/dbSafety/compaction.ts`, called from `initDatabase` after `migrateSchema`, and update the startup-order comment. Add `PRAGMA incremental_vacuum` after each prune pass in the observation service (D7). Verify:
  - T4 rows C1–C3 as a table test (C3 with a failing `VACUUM` injected);
  - C2 through the real `initDatabase` on a file database (`auto_vacuum` 2, freelist 0, fewer pages);
  - a service test showing `page_count` falls after a prune pass;
  - the "Pruned space returns to the file" scenarios.

  Mutants: "skip incremental_vacuum" and "rethrow the VACUUM error".
- [ ] 3.3 Add recovery-matrix rows to `docs/recovery-matrix.md`: "Startup compaction fails or is interrupted", citing the C3 test by exact title. Verify: `bun run test src/server/__tests__/recoveryMatrix.test.ts` passes.

## 4. Docs and coordination

- [ ] 4.1 Update `docs/operations/process-observability.md` and the observability bullets in `docs/architecture/metrics.md` (per-turn phase totals, one row per call and request, unmatched counting, the durable ledger allowlist, compaction and incremental vacuum, the cutover). Verify: a read-through against D1–D7, and `bun run lint` passes.
- [ ] 4.2 Reword `openspec/changes/process-observability/specs/process-observations/spec.md` so "activity intervals" reads as per-turn activity totals. Verify: `openspec validate process-observability --strict` and `openspec validate compact-observation-detail --strict` both pass.

## 5. Integration check

- [ ] 5.1 Copy the live database to a scratch directory outside the repository, run `initDatabase` from this branch on the copy, and record:
  - the migration and compaction durations;
  - the file size and `dbstat` per table before and after;
  - that `process_export_totals` is identical.

  Then run `bun run check` on the clean committed tree. Verify: the measurements and the check pass are recorded in the result.

## Workflow follow-up

- After merge, watch one day of the live database: rows per day by kind, and the file and backup sizes after the first prune.
- Archive after `process-observability`'s delta wording is aligned.
