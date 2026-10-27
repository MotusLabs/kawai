# Tasks

## 1. Delivery facts from git

- [ ] 1.1 Add `src/server/metrics/delivery/landing.ts` with the pure `landingTimes` walk (D2) and the change-landing parse (read 2's output to name → first arrival). Commit Tables L (L1–L4) and C (C1–C5) verbatim as table-driven tests, plus property P1 (seed 0xDE11, 500 cases). Verify: `bun run test src/server/__tests__/deliveryLanding.test.ts` passes. Mutants to kill: stamping with the latest rather than the earliest first-parent time (L3, P1); following only first parents (L2); the last archive arrival winning (C3).
- [ ] 1.2 Add `delivery/gitReader.ts`, which covers:
  - resolving the ref as text (symbolic `refs/remotes/origin/HEAD`, then the loose ref or `packed-refs`);
  - the `FETCH_HEAD` mtime;
  - the three reads of D1 (the 98-day graph, the archive arrivals, the first-parent count), with 10 s timeouts over `runGitAsync`;
  - the per-(commit, head) `merge-base --is-ancestor` fallback for L5–L7.

  Tests build a temporary repository with `cleanGitEnv` (merge and squash integrations, an unmerged branch, an archive added twice, an unset `origin/HEAD`). Verify: the reader test passes, rows L5–L7 and "no default branch" are asserted, and a spy on the spawn asserts no argument list contains `fetch`, `push`, `update-ref`, or `remote update` (spec "No fetch"). Mutant to kill: dropping the fallback, so L5 reads not landed.
- [ ] 1.3 Add `delivery/factsCache.ts`: one entry per team keyed by (head, fetch mtime), single-flight reload, `refreshing` while it runs, `stale` beyond 24 h of fetch age or when the fetch time is unknown, and a change listener. Verify: unit tests with a fake reader and clock cover the first read (unavailable "reading default branch"), an unchanged head (no reload), a moved head (previous entry plus one reload under two concurrent reads), and the stale boundary at exactly 24 h. Mutant to kill: re-reading on every call, caught by a reload counter.

## 2. Delivery metrics family

- [ ] 2.1 Extend `src/shared/processMetrics.ts` (D3):
  - add the `delivery` family, listed first, and the eleven new ids;
  - add the `unavailable` field on `MetricValue` and `delivery` on `ProcessMetrics`;
  - change `lead_time_*`'s guard to `landed_result_share`;
  - set `tokens_per_landed_change`'s guard to `reopen_rate`.

  Grep for exact-list assertions over `METRIC_IDS` and `METRIC_FAMILIES` in other test files first, and update them in the same commit. Verify: `bun run typecheck` and the existing metrics tests pass.
- [ ] 2.2 Add `delivery/observations.ts` and wire it into `computeMetrics`. Extend `metricsQuery.ts` with the one in-transaction query for tasks linked to changes that have not landed. Verify: a test per spec scenario of `delivery-outcomes` (busy week, follow-up chains, unlinked change, post-archive follow-up, low linkage, stuck change, plain directory team) and of `team-process-metrics` (done but not merged, acceptance is independent) passes, with values computed from `metricsSeed.ts` fixtures. Mutants to kill: counting tasks created after the landing; letting an unavailable source read 0 instead of no data.
- [ ] 2.3 Pass facts from `DeliveryFactsCache` into `MetricsReader` reads. Verify: a test asserts the tab read and a tool read at the same moment carry the same `delivery.head` and identical values (spec "Same values as the tab").
- [ ] 2.4 Render the delivery family in the Metrics tab (`src/client/components/team/metrics/`): the stale marker with fetch age, the unavailable reason in place of the value, and absent metrics in old report snapshots shown as absent. Verify: component tests for stale, unavailable, and an old snapshot pass, and a `dev-browser` screenshot of the tab on the development fixture shows the family.
- [ ] 2.5 Update the process-metrics bullet in `AGENTS.md`: the delivery family, the facts source and freshness, and the guard change. Verify: the `@reads` guard test passes, and the bullet names `landed_result_share` and `refs/remotes/origin/HEAD`.

## 3. Compact agent reads

- [ ] 3.1 Add `compactMetrics` (D5) and use it in `team_metrics` with the new `metrics` argument. Commit Table T rows T1–T4 as table-driven tests, plus property P2 (seed 0xC0DE, 300 cases). Verify: `bun run test src/server/__tests__/metricsTools.test.ts` passes, and T1 asserts the serialized size is under 32 KB on a 300-task seed. Mutants to kill: rounding or dropping `baseline` in the projection (P2); the drill cap not applied (T2); an unknown id ignored instead of refused (T3).
- [ ] 3.2 Make `process_reports_list` omit `snapshot`, and add `full` to `process_report_get`. Commit rows T5–T6. Verify: the report tool tests pass, and T6 compares bytes with the stored row. Mutant to kill: the compact path writing back to the store, caught by a stored-row hash taken before and after.
- [ ] 3.3 Update both tools' descriptions and the `AGENTS.md` metrics and report bullets. Verify: the description strings name `metrics` and `full`, and the tool-table test stays green.

## 4. Degradation rules and the attention item

- [ ] 4.1 Add `src/shared/degradationRules.ts` with the D4 table and `evaluateDegradation`. Commit Table R (R1–R7, plus two rows each for `convergence-drift` and `inflight-aging`) as table-driven tests, plus property P3 (seed 0xD0D0, 500 cases). Verify: the rules test passes. Mutants to kill: the stale check removed (R1); the token condition removed (R6 becomes R4-like, and the "quiet week" scenario fires); `cost-per-change-rise` not suppressed by `delivery-drop` (R4 fires two rules).
- [ ] 4.2 Add `delivery/degradationMonitor.ts`. It re-evaluates on a facts change, on a 10-minute unref'd timer while a workspace subscription is open, and on a Metrics refresh; it re-pushes the workspace when the fired set changes; and it is stopped at shutdown. Verify: fake-clock tests for each trigger, plus a test that no timer stays armed with no subscription.
- [ ] 4.3 Add the `process-degradation` attention kind, the `metrics` link kind, and `degradationItems` in `ATTENTION_SOURCES`. On the client, open `#/team/<key>/metrics/7d` from the item. Verify:
  - the `team-workspace` delta scenarios pass as tests (one item, recovery clears it, one toast across pushes and a reconnect, stale raises nothing);
  - the M1 production-composition test from design.md lists `process-degradation:delivery-drop`, and its mutant (the source removed from `ATTENTION_SOURCES`) fails it.
- [ ] 4.4 Add the attention kind to the attention bullet of `AGENTS.md`. Verify: the bullet names the kind, its owner, and its link.

## 5. Structural guard

- [ ] 5.1 Extend the structural test that holds execution, landing, dispatch, staffing, and routing modules free of outbound-store imports, so that it also holds them free of `metrics/delivery/` and `degradationRules` imports (spec "Delivery and alerts never drive work"). Verify: the test passes, and a deliberate import in a routing module fails it.

## 6. Trends: computation and protocol

- [ ] 6.1 Give `computeMetrics` an explicit `end`, and add `src/server/metrics/trends.ts` (`readTrends`, `TrendsReader` with a 5-minute cache per (team, range), dropped on refresh and on a new facts entry) per D6, with the retention-based `partial` markers. Verify: property P4 (seed 0x7E4D, 100 cases) and rows TR1, TR2, and TR4 pass, plus the spec scenarios "A point is a past read" and "Rule marks". Mutants to kill: counting landings after `end_k` (P4); omitting the limit-event partial (TR4).
- [ ] 6.2 Add `process-metrics-trends-open`/`close` → `process-metrics-trends`, and the optional `end` on `process-metrics-open`, in `metricsConnections.ts`, `src/shared/` message types, and `CHAT_CONNECTION_TYPES`. Re-send on open, refresh, and a facts change. Verify: rows TR3, TR5, and TR6 pass as connection tests, and a test asserts both new types are in `CHAT_CONNECTION_TYPES`. Mutant to kill: dropping `end`, so TR5 returns the current window.

## 7. Trends: Metrics tab view

- [ ] 7.1 Parse `metrics/trends/<range>` in `teamLocation.ts`, falling back to 12w with a notice on an unknown range, and keep the range per team in `teamWorkspaceStore`. Verify: location tests for reload (spec "Location restored"), an unknown range, and the existing `metrics/<window>/<report>` forms unchanged.
- [ ] 7.2 Add `MetricsTrends.tsx`. Load the `dataviz` skill before writing chart code. It draws SVG small multiples grouped by family, with insufficient-point bands, fired-rule marks, the stale marker, and a `<table>` alternative per chart. Choosing a point navigates to that window through `end`. Controls disable while disconnected. Verify: component tests for the spec scenarios "Open a point" and "Keyboard and screen reader", and `dev-browser` screenshots at 4w and 12w on the development fixture, in light and dark, attached to the result.
- [ ] 7.3 Document the Trends view in the `AGENTS.md` process-metrics bullet. Verify: the bullet names the route, the ranges, and that points are past 7d reads.

## 8. Prometheus export of delivery metrics

- [ ] 8.1 Add the D7 families to `export/registry.ts`, and the `delivery` seam to `MetricsSnapshot`, wired by the manager. Commit Table E rows E1–E7 as table-driven tests, with a spawn spy asserting that no scrape runs git. Verify: the export tests pass, and the existing registry snapshot test shows only additions. Mutants to kill: an accumulator-backed counter, which double-counts after the restart in E6; a change name used as a label (E7); a stale entry left firing a rule gauge (E5).
- [ ] 8.2 Add the M1 export test from design.md through the production server wiring. Verify: it asserts E4, and its mutant (seam unwired) fails it.
- [ ] 8.3 Document the delivery families and the tokens-per-landed-change query in `docs/operations/process-observability.md` › Optional Prometheus endpoint. Verify: the documented PromQL parses with the families' exact names.

## 9. Integration checks

- [ ] 9.1 Run `bun run check` on the clean committed tree. Verify: it records a pass.
- [ ] 9.2 Calibrate against this repository using the 12w Trends read over a copy of the live database (`cp` to `/tmp` first): its points ending 2026-09-29 through 10-27 are the five calibration windows. Record each point's delivery values and fired rules in the task journal. Verify: `delivery-drop` fires at the point ending 10-27; any other firing is explained in the journal; and any threshold moved by the calibration still fires on the spec scenarios' figures.
- [ ] 9.3 Measure a 12w `readTrends` on a copy of the live database. Verify: the duration is recorded in the task journal; above 2 s, the cache is lengthened per D6 and the measurement repeated.

## Workflow follow-up

- Archive the change after review, and confirm that `openspec/specs/delivery-outcomes/spec.md` is created with its Purpose.
- Coordinate with `process-observability`: its acceptance-time metrics may consume `landed_result_share` as an acceptance mechanism. Record that in its design rather than here.
