# Proposal

## Status

PROPOSED (2026-11-18), planning only, for owner approval through plan
`plan-2eb5f292` (draft). It is the fresh metrics/report/drill remainder of
`bounded-metrics-and-task-get`, re-derived on master `f52963d0`. That change's
artifacts, its held branch `land/bounded-metrics-and-task-get-20261105`
(`8011e25e`), result `result-d18090f6`, and tasks `931742d5`, `49405e3d`, and
`0f818563` stay exactly as they are; nothing here cancels, adopts, ticks, or
archives them. design.md "Scope inventory" maps every requirement, scenario,
and task of the original change to this change, to landed work, or to an
owner-held row, and states how the original is reconciled after this lands.

## Why

`team_metrics` is already bounded: PR #405 (`d00f64e3`) added `detail:
compact | full`, with a compact default under 32 KB that marks shortened lists
(`src/server/metrics/metricsTools.ts:19,48-53`,
`metricsProjection.ts:3-25`). The main spec does not say so: "Agents read
metrics through a read-only tool" (`openspec/specs/team-process-metrics/spec.md:170`)
still promises the tab's whole value. Three gaps remain:

- **No agent drill.** A compact list keeps 50 entries and a total. The rest is
  reachable only through `detail: full` (775 KB for a 7d read on the
  2026-11-03 team) or the human-only Tools pager (`toolDrill.ts`,
  `metricsConnections.ts:127-137`), which serves `toolStreaks` only.
- **Report tools are unbounded.** `process_reports_list` returns ten frozen
  snapshots (2.65 MB measured), `process_report_get` one (803 KB), and
  `process_report_submit` echoes it (`reportTools.ts:56-71`).
- **No end-keyed read.** `MetricsReader.read` always reads at now
  (`computeMetrics.ts:104-113`), so a later page cannot be computed for the
  window the agent first saw.

The `task_get` half of the original change is delivered (PR #396 and the
archived `bounded-task-reads`, PR #419; main `team-tasks`). This change does
not touch it.

## What Changes

- **Spec catch-up (no behavior change):** the MODIFIED "Agents read metrics
  through a read-only tool" states the landed `detail` argument, the 32 KB
  compact bound, its truncation markers, lossless `full`, and the
  measurement status in both details.
- **New `team_metrics_drill` agent tool:** one paging API for every drill list
  an agent can see shortened: `tasks` and `messages` of every metric, and
  `toolStreaks` of the tool metrics, from a live window (at a fixed window end)
  or a stored report (the frozen snapshot). Cursors bind team, source, window
  end, metric, list, page size, and for tool streaks the existing high-water
  mark (D2). Live tool-streak pages reuse `readToolDrill`, so the human pager
  and the agent drill agree.
- **`MetricsReader.readAt(team, window, slice, end)`**, cached by end (D3);
  `read()` and its `fresh` bypass keep their behavior.
- **BREAKING (agent tool output):** `process_reports_list` drops snapshots;
  `process_report_get` returns the compact snapshot unless `detail: full`;
  `process_report_submit` echoes a compact snapshot. Stored snapshots and the
  human's report path are unchanged.
- **Proposed retirement (needs owner approval):** the original change's inline
  `metrics: [...]` expansion of `team_metrics` (its D1/D4 and requirement "The
  agent tool expands named metrics") is withdrawn. The landed compact
  projection plus one drill API cover the same need without a second result
  shape. No code implements the expansion today, so nothing is removed.

**Not changed:** the Metrics tab and its WebSocket reads, the human Tools
pager message (`process-tool-drill-page`), stored records, metric definitions
and values, `detail: full`, and every `task_get` behavior.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `team-process-metrics`: the agent read states `detail` and its bound; a new
  agent drill API pages every drill list; the tab stays whole.
- `process-reports`: the list drops snapshots; get and submit return compact
  snapshots, with `detail: full` on get, paged through the drill API.

## Impact

- Code (planned): `src/server/metrics/metricsTools.ts` (drill schema, handler,
  description), `computeMetrics.ts` (`readAt`), a new
  `src/server/metrics/metricsDrill.ts` (cursor codec and paging),
  `toolDrill.ts` (an end-parameterized first page, no behavior change for the
  tab), `reportTools.ts` (agent projections), `src/shared/processMetrics.ts`
  (page types), `src/server/team/teamPrompt.ts` (tool note if present), and
  the metrics bullet in `docs/architecture/metrics.md`.
- Tests (planned): `metricsTools.test.ts`, `reportTools.test.ts`, a new
  `metricsDrill.test.ts`, and `toolDrillPaging.test.ts` (unchanged rows must
  stay green).
- Running Codex threads keep the catalogue they started with: they see the
  compact report output at once but `team_metrics_drill` only in fresh
  threads.
- **Dependency for a held change:** `delivery-outcome-metrics` (human pause,
  task `c0493930`) names `bounded-metrics-and-task-get` as the provider of its
  compact projection (that change's D10). Its artifacts are held and are not
  edited here. design.md D7 records the mapping to this change's names for the
  owner, to apply only if the owner resumes that lane.
