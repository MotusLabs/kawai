# Tasks

Planned work only; nothing below is implemented. Existing tests named here
(`metricsTools.test.ts`, `reportTools.test.ts`, `toolDrillPaging.test.ts`,
`metricsConnections.test.ts`, `reportConnections.test.ts`) exist on master
`f52963d0`; `metricsDrill.test.ts` is new.

## 1. End-keyed reads and the drill core

- [x] 1.1 Add `MetricsReader.readAt(team, window, slice, end)` keyed by end, make `read()` delegate on a miss, keep the latest-read cache and `fresh` bypass, and evict both caches (D3). Commit rows T9a, T9, T10 as literal tests in `metricsTools.test.ts`. Verify: they pass; mutant "cache key without `end`" fails T9/T10; mutant "`fresh` served from cache" fails T9a.
- [x] 1.2 Add `src/server/metrics/metricsDrill.ts`: cursor codec (D2, strict decode, unknown-field refusal, team binding) and the live `tasks`/`messages` pager over `readAt`. Commit T5, T11 (messages part), T12, T14, T17 and property P1 for live lists (seed `0xD811`, 300 cases). Verify: `bun run test src/server/__tests__/metricsDrill.test.ts`; mutants "`after` compared with `>=`" (P1), "limit check off by one" (T11), "cursor team trusted" (T14) fail.
- [x] 1.3 Give `readToolDrill` an explicit first-page end (the human pager passes now, unchanged) and route live `toolStreaks` drills through it. Commit T15 and T11 (tool-streak part). Verify: `toolDrillPaging.test.ts` unchanged and green; mutant "agent tool-streak page read at now" fails T15.

## 2. Agent tools

- [x] 2.1 Register `team_metrics_drill` in `metricsTools.ts` and the team tool table (checkpoint: one production path, D-section "Production composition checkpoint"). Commit T2, T3, T4 through `teamToolTable` under both runtime registrations, and T1, T1a, T1b for the landed `detail` behavior. Verify: mutant "handler not registered" fails T2; mutant "compact values differ from full" fails T1.
- [x] 2.2 Route `process_reports_list` (no snapshot), `process_report_get` (`detail`), and `process_report_submit` (compact echo) through handler projections (D4), and report sources in the drill (including `reachable` for tool streaks). Commit T6, T7, T8, T13, T16, T18 and P4. Verify: `reportTools.test.ts`, `reportConnections.test.ts`, and `metricsConnections.test.ts` pass; mutants "projection in `ProcessReportService.list`" (T6/T18), "projection written to the stored row" (P4), "report tool streaks padded to total" (T16) fail.
- [x] 2.3 Add property P2 (seed `0xC0DE`, 300 cases) over `metricsSeed.ts` inputs, including the drill-union clause. Verify: mutants "baseline rounded", "input sorted in place", "cap before total" fail P2.
- [x] 2.4 Update the `team_metrics`, `team_metrics_drill`, and report tool descriptions, the team prompt note if it names metrics reads, and `docs/architecture/metrics.md` (D5). Verify: the description strings name `detail`, `team_metrics_drill`, and `limit`; the `@reads` guard and tool-table test pass.

## 3. Integration and closeout

- [x] 3.1 On the clean committed head: citation preflight with zero unresolved literal titles, `bun run check --full-properties` using the Bun version declared by `.bun-version` at that commit, `scripts/verify-result.ts`, and `openspec validate bounded-metrics-reads --strict`. Record the T1/T7 fixture sizes. Map every oracle id (T1–T18 with lettered rows, P1, P2, P4) to its literal test title and killed mutant in the result.
- [x] 3.2 Owner-gated, optional: measure the four agent reads on a copy of the live database only with the owner's explicit consent; otherwise record "not measured" (no fabricated figures).
- [x] 3.3 At archive: add `@covers` annotations for every ADDED and MODIFIED scenario (this change is not in `openspec/coverage.json`'s `exempt` list), then sync and archive. Reconciliation of `bounded-metrics-and-task-get` and its held lineage is an owner decision (design "Scope inventory"), not part of this task.

## Landed evidence (archive reconciliation, 2026-11-25)

All ten items were implemented on plan execution `task-12a3f50b`
(revision r2#3784653671b0) across six review rounds and landed by PR #460,
merged 2026-11-25 09:06:29 UTC as
`ba955e3ea7274d5c2697b3bd1eccf1e2ad3fe23f` (parents `50e61cb9` master and
`27e2eab0` base update). The accepted result is `result-c8101605` at
`26b7af18`; the round-6 cross-model review `findings-a09e4e07` passed there
with all P1 findings resolved; GitHub run 45579740829 passed changes, ci, and
e2e at the merge.

Item 3.1 evidence, on the clean committed head `26b7af18` under Bun 1.4.5
(the `.bun-version` pin there): `bun run check --full-properties` exited 0
(11,986 pass / 0 fail; pass recorded `9068aa9fa4c3`); `openspec validate
bounded-metrics-reads --strict` was valid; `bun scripts/verify-result.ts
--commit 26b7af18 --coverage <map>` exited 1 solely from peer-branch
conflicts (30 compared, 15 skipped), with commit identity, HEAD, clean tree,
the recorded Bun 1.4.5 certificate, and origin merge passing and all 57
cited literal titles ran-passed. Unverified limitations kept visible: the
properties' `table` seam is unwitnessed (P2 keeps its own no-mutation
check); the a/g/b/d integration files needed the runner's single retry
during that full check; no browser/e2e and no live-data run.

Item 3.2: not measured. The owner-gated optional live measurement was not
performed, per the approved scope; no figures are fabricated.

Item 3.3: all 23 ADDED and MODIFIED scenario `@covers` annotations are
landed (6 + 7 + 1 in `team-process-metrics`, 6 + 3 in `process-reports`) and
checked by `scripts/__tests__/specCoverageGuard.test.ts`; the inline sync
into both main specs and this archive move are this change's archive
commits.
