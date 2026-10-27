# Proposal

## Why

In the week of 2026-10-20, Kawai's process metrics all reported improvement: 227 done tasks against 104, task lead time p50 1.5 h against 4.0 h, fix iterations 1.07 against 2.13. Over the same week, master took 59 first-parent merges against 146, OpenSpec archives fell from 40 to 6, and completed-turn tokens rose from 4.0 B to 7.1 B (about 4.5× the tokens per merge). Nothing told the owner. There were three causes:

1. The metrics count team tasks, not delivered work. Review, advisory, and follow-up tasks inflate the cohort. A develop-review-follow-up loop that spans many short tasks reads as faster work, and `fix_iterations` cannot see it because it counts results within one task.
2. The lead-time guard, `accepted_result_share`, has read 0 in every window ever recorded: no result has ever been accepted. A guard that is always zero cannot move.
3. Metrics are only computed when someone reads them, and no path raises them to the human. The one prose warning (in the 10-26 7d report) stayed inside the report. Agents also struggle to read them: `team_metrics` returns about 1 MB and `process_reports_list` about 2 MB.

## What Changes

- **Delivery facts.** Kawai reads the team's default branch as last fetched (`refs/remotes/origin/HEAD`) with read-only git:
  - first-parent integrations, with their times;
  - OpenSpec changes landed, meaning their archive directory arrived on the default branch, with the time of arrival;
  - for each result commit, whether and when it landed.

  Kawai never fetches. Facts older than the fetch freshness bound are marked stale.
- **A `delivery` metric family** over the existing windows and baselines:
  - changes landed and integrations per window;
  - tokens per landed change;
  - per landed change: cycle time from the first linked task to landing, linked tasks, and review rounds;
  - the age of in-flight changes;
  - how many landed changes have linked tasks, so convergence numbers show their own coverage.
- **A guard that can actually move.** `landed_result_share` is the share of done tasks whose newest result's commit landed on the default branch. It replaces `accepted_result_share` as task lead time's guard. `accepted_result_share` stays a coverage metric with an unchanged definition. Accepting a result remains a separate act; landing never accepts a result.
- **Degradation alerts.** A fixed, constant table of rules compares the 7d window with its baseline. Example: changes landed fell by 40% or more while tokens did not fall. While a rule holds, it raises one `process-degradation` attention item, owned by the human and naming its evidence, which links to the Metrics tab. When delivery facts are stale, the rules are suppressed and the item states that instead. Nothing is stored: rules are evaluated at read time like the metrics.
- **Compact agent reads.** `team_metrics` returns a compact metric set by default: no drill lists or breakdowns. Asking for named metrics returns their drill lists, breakdowns, and slices, with each drill list capped and its total stated. `process_reports_list` returns reports without their frozen snapshots; `process_report_get` returns one report and its snapshot in the same compact form unless the full form is asked for. The Metrics tab keeps the full read.

- **A Trends view.** The Metrics tab gains Trends: every metric as a series of 7d windows over the last 4, 8, or 12 weeks. Each point is exactly the 7d read made at that point's end, and points where a degradation rule fired are marked. Opening a point shows that window. The view is computed at read time like the metrics. It answers "when did this start?", which a single window against its baseline cannot.
- **Delivery metrics for Prometheus.** When the existing optional `/metrics` endpoint is enabled, it also exports:
  - cumulative counters of integrations and landed changes;
  - histograms of change cycle time, tasks, and review rounds per landed change;
  - gauges for in-flight changes, fetch age and staleness, and each degradation rule's firing state.

  Token totals are already exported, so tokens per landed change is a query over the two counters.

Non-goals:
- deploying Prometheus or Grafana;
- adding a charting dependency;
- fetching from origin;
- accepting results automatically;
- notifying agents or sending mail about degradation;
- changing the definition of any existing metric;
- recommendations or the daily digest, which belong to `process-observability`;
- making any metric or alert an input to dispatch, routing, staffing, or execution.

## Capabilities

### New Capabilities

- `delivery-outcomes`: delivery facts read from the default branch (integrations, landed OpenSpec changes, landed result commits) and their freshness, the `delivery` metric family with per-change convergence and in-flight age, the fixed degradation rules evaluated over them, and their export to the optional Prometheus endpoint. The export requirements live here rather than in `prometheus-export`, which `process-observability` introduces and has not archived.

### Modified Capabilities

- `team-process-metrics`: task lead time's guard becomes `landed_result_share`; `team_metrics` returns a compact form by default with drill-down for named metrics; and the Metrics tab gains a Trends view of 7d windows over 4–12 weeks.
- `process-reports`: `process_reports_list` omits frozen snapshots, and `process_report_get` returns a compact snapshot unless asked for the full one. The Metrics tab is unchanged.
- `team-workspace`: the attention queue lists `process-degradation` items, linked to the Metrics tab.

## Impact

- **Server:**
  - a new `src/server/metrics/delivery/` module: a git reader over `runGitAsync`, a pure landing walk, a facts cache keyed by the default-branch head, and degradation rules;
  - `computeMetrics.ts` and `metricsQuery.ts` take delivery facts as input;
  - `metricsTools.ts` and `reportTools.ts` gain the compact forms;
  - `workspaceRead.ts` gains an attention source.
- **Shared:**
  - `src/shared/processMetrics.ts` gains the `delivery` family, new metric ids, the changed guard, and the compact types;
  - `src/shared/teamWorkspace.ts` gains the `process-degradation` kind and a `metrics` link kind.
- **Export:** `src/server/metrics/export/registry.ts` and `snapshot.ts` gain the delivery families. Adding families leaves the existing ones unchanged.
- **Protocol:** additive `process-metrics-trends-open`/`close` messages answered by `process-metrics-trends`, all in `CHAT_CONNECTION_TYPES`.
- **Client:**
  - the Metrics tab renders the new family and its staleness marker;
  - a Trends sub-view at `#/team/<key>/metrics/trends/<range>`, drawn as SVG small multiples with no chart library;
  - the attention queue opens the `metrics` link.
- **Data:** no migration and no new table. Facts are derived from git and held in memory. Report snapshots frozen before this change keep their stored shape, and readers treat the new metrics as absent there.
- **Coordination:** `process-observability` plans acceptance-time metrics. Results are never accepted here, so those metrics would read no data. `landed_result_share` and the landing facts give that change an acceptance mechanism it can consume, and neither change redefines the other's metrics.
