# Design

## Context

For motivation, see proposal.md › Why.

Today's metrics pipeline works like this:
- `loadMetricsInputs` (`src/server/metrics/metricsQuery.ts`) reads SQLite inside one read transaction.
- `computeMetrics` derives every family purely, for the window and for the preceding window.
- `MetricsReader` caches one read per (team, window, slice) for 30 s.
- The Metrics tab, `team_metrics`, and report snapshots all share that reader.
- Definitions, guards, and the sample threshold are constants in `src/shared/processMetrics.ts`.

There is no git input and no push path to the attention queue. `WorkspaceRead.snapshot` (`src/server/team/workspaceRead.ts`) is synchronous and folds the `ATTENTION_SOURCES` over one `AttentionInput`.

Facts observed on the live repository on 2026-10-27:
- Every git read this design needs runs in under 30 ms: the full first-parent archive history, and 21 days of the commit graph (about 2,400 commits).
- 453 of 456 results from the last 14 days carry `commit_ref`. None has ever been accepted.
- 239 of 347 tasks name `openspec_change`, and every task has a parent.
- `FETCH_HEAD` was minutes old.
- `runGitAsync` (`src/server/git/gitCommand.ts`) is the existing read-only runner. Result checks already treat `refs/remotes/origin/HEAD` as the base "as last fetched".

## Goals / Non-Goals

**Goals:**
- Delivery facts become one derivation, consumed by metrics, rules, and the tab alike (oracle hazard "several readers disagreeing on derived state").
- Metric computation stays pure and synchronous. Git runs only in a refresh step outside the SQLite read.
- Agent reads become small enough to use.

**Non-Goals:**
- No delivery metric is sliceable. All are team-side.
- No per-PR identity from GitHub. Integrations are first-parent commits, read without `gh`.
- No history beyond the read horizon for result landing times.

## Decisions

### D1 — Facts come from three git reads, cached by head

`DeliveryFactsReader` (`src/server/metrics/delivery/gitReader.ts`) runs read-only git at the team's main checkout. Each call has a 10 s timeout:

1. `git log --format=%H %P %ct --since=<end − 98 d> refs/remotes/origin/HEAD` loads the commit graph inside the horizon. 98 days is the 12-week trend range plus one 7d window plus a week of slack for commits authored before they land. On this repository that is fewer than 15,000 commits, and 21 days measured 20 ms.
2. `git log --first-parent --diff-filter=A --name-only --format=@%H %ct refs/remotes/origin/HEAD -- 'openspec/changes/archive/*/proposal.md'` returns the archive arrivals over full history. In-flight state needs to know about changes that landed long ago.
3. `git rev-list --first-parent --count refs/remotes/origin/HEAD` gives the lifetime integration count for the export counter (D7).

The ref is resolved without a process: read the symbolic `refs/remotes/origin/HEAD` file, then the loose ref or `packed-refs`, as `repoFacts.ts` reads config as text. The fetch time is `FETCH_HEAD`'s mtime in the git common dir.

`DeliveryFactsCache` (`delivery/factsCache.ts`) holds one entry per team, keyed by (head sha, fetch mtime). The reload policy:
- A read that finds the ref unchanged returns the entry.
- A read that finds the ref changed returns the previous entry marked `refreshing` and starts one reload, single-flight per team.
- With no entry yet, delivery metrics are `unavailable: "reading default branch"`. The first reload then publishes a change.

Alternative considered: make `MetricsReader.read` async and run git inline. `WorkspaceRead.snapshot` and the attention fold are synchronous and push often, so every snapshot would wait on git. That was rejected.

### D2 — Landing is a pure walk over the loaded graph

`landingTimes(graph, firstParentChain)` (`delivery/landing.ts`, pure) walks the first-parent chain from oldest to newest. For each first-parent commit F, it does a breadth-first walk from F through parents and stops at commits already reached. Every newly reached commit is stamped with F's time.
- A commit inside the horizon that is not reached is not landed.
- A result commit outside the loaded graph is resolved once by `git merge-base --is-ancestor C <head>`, cached per (C, head). If contained, it reads `landed, time unknown`; otherwise it is not landed.
- A `commit_ref` that does not resolve, such as a short sha that is ambiguous or missing, reads unresolvable. It is excluded from `landed_result_share` and counted in its coverage note.

Change landings come from read 2. The directory `<date>-<name>` gives the name, and the first arrival wins.

### D3 — Facts enter the metrics as an input, not a query

`MetricsInputs` gains `delivery: DeliveryFacts | null`. `computeMetrics` stays pure and gains `deliveryObservations(ctx)` (`delivery/observations.ts`), which emits observations for:
- `changes_landed` and `integrations` (sum);
- `tokens_per_landed_change` (ratio: tokens as numerator, landed changes as denominator);
- `change_cycle_time_p50/p90`, `tasks_per_landed_change` (mean), and `review_rounds_per_landed_change` (mean);
- `landed_change_link_coverage`;
- `inflight_change_age_p50/p90`;
- `landed_result_share`, which is in the coverage family.

`metricsQuery` already loads tasks, status events, results, findings, and turn usage. Linked tasks are found by `openspec_change` or `plan_change` equal to the change name. Open-at-T for in-flight state comes from the status events already loaded. The load range for in-flight state is extended only for tasks linked to changes that have not landed. One extra query selects them by name, inside the same read transaction.

When `delivery` is null or `unavailable`, every delivery metric has `value: null`, `n: 0`, and a new optional `unavailable: string` on `MetricValue`. `ProcessMetrics` gains `delivery: { head, readAt, fetchedAt, stale, unavailable? }`.

`METRIC_FAMILIES` gains `delivery`, listed first. The guard of `lead_time_p50/p90` changes to `landed_result_share`, and `tokens_per_landed_change` is guarded by `reopen_rate`. Splitting a change to cut its cost shows up as rework.

The determinism requirement now holds per (team, window, slice, end, delivery head). Both surfaces read the same cache entry, so they still agree.

### D4 — Degradation rules are a constant table evaluated over one 7d read

`DEGRADATION_RULES` (`src/shared/degradationRules.ts`, pure) is evaluated by `evaluateDegradation(metrics7d)`. It returns nothing when `delivery` is stale or unavailable.

| id | fires when | sample floor |
|----|------------|--------------|
| `delivery-drop` | changes landed ≤ 0.6 × baseline, and integrations ≤ 0.7 × baseline, and tokens ≥ 0.8 × baseline | baseline changes landed ≥ 10 |
| `cost-per-change-rise` | tokens per landed change ≥ 2 × baseline, and `delivery-drop` does not fire | current changes landed ≥ 3, baseline ≥ 10 |
| `convergence-drift` | tasks per landed change ≥ 2 × baseline | n ≥ 5 on both sides, and linked coverage ≥ 0.5 on both sides |
| `inflight-aging` | in-flight age p90 ≥ 72 h, and ≥ 2 × baseline p90 | n ≥ 3 on both sides |

Against the week of 2026-10-20, `delivery-drop` fires on the proposal's figures.

`DegradationMonitor` (`src/server/metrics/delivery/degradationMonitor.ts`, one per manager) caches each team's outcome. It re-evaluates through the shared `MetricsReader`:
- when the facts cache publishes a new entry;
- when an entry is older than 10 minutes and a workspace subscription for the team is open (an unref'd timer);
- on a Metrics refresh.

The cached outcome is read synchronously by `WorkspaceRead.snapshot` through a new `AttentionInput.degradation`. When a team's fired set changes, the monitor calls the workspace connections' existing re-push.

`degradationItems` joins `ATTENTION_SOURCES` with kind `process-degradation`, owned by the human. Its link is `{ kind: 'metrics', id: '7d' }`, which is a new `AttentionLink` kind. The client opens `#/team/<key>/metrics/7d` for it.

Alternative considered: store fired episodes for one toast per episode. The item identity `process-degradation:<rule>` already gives one toast per client session while the rule holds. Storing episodes would add a table and recovery-matrix rows for little gain, so it was rejected.

### D5 — Compact reads are projections of the same computation

`compactMetrics(metrics, { ids?, drillCap = 50 })` (`src/shared/processMetrics.ts`, pure) projects a `ProcessMetrics` value:
- It drops `drill` and `breakdown` from every metric not in `ids`.
- It keeps `slices` only when a slice was asked.
- For the named metrics, it caps each drill list and adds `drillTotal: { tasks, messages }`.

`team_metrics` gains `metrics?: string[]`. An unknown id throws, like an unknown window, so the refusal has the same tool-error shape. The tool reads the full value from `MetricsReader` and projects it, so the numbers cannot diverge from the tab.

`process_reports_list` maps each report to its record without `snapshot`. `process_report_get` gains `full?: boolean`; without it, the stored snapshot passes through `compactMetrics`. Stored snapshots are never rewritten. Readers treat a missing metric id, or a missing `delivery` field, in an old snapshot as absent.

### D6 — Trends reuse the 7d computation at past ends

`computeMetrics` gains an explicit `end` (today it reads `inputs.end`). `readTrends(team, range)` (`src/server/metrics/trends.ts`) works in three steps:
1. It loads `MetricsInputs` once over `[now − (weeks + 1) × 7 d, now]`. `loadMetricsInputs` already takes `from`/`end`, and the extra week is the first point's baseline.
2. For each point end `now − k × 7 d` (k = 0…weeks−1), it calls `computeMetrics(inputs, '7d', null, end_k)` and `evaluateDegradation` on the result.
3. It projects every point through `compactMetrics`.

Delivery facts are time-parameterized already: a landing counts at `end_k` only when its time is no later than `end_k`. Staleness is today's, since a past point cannot be fresher than the facts that describe it.

The partial markers come from retention constants already defined:
- limit events: 15 days;
- completed-turn usage: 90 days (`chat_turn_usage` pruning).

A point whose window starts before a horizon gets `partial` on the affected metrics. A computation that skipped those rows would read silently lower.

`TrendsReader` caches one read per (team, range) for 5 minutes. A Metrics refresh and a new facts entry drop the cache. A 12-week read is 12 computations over one load. Task 9.3 measures it on a copy of the live database. If it takes more than 2 s, the fix is a longer cache, never different semantics.

Protocol:
- `process-metrics-trends-open { teamPath, range }` → `process-metrics-trends { teamId, range, points, delivery, computedAt }`, and `process-metrics-trends-close`, all in `CHAT_CONNECTION_TYPES`;
- the snapshot is re-sent on open, on refresh, and on the monitor's facts change;
- `process-metrics-open` gains an optional `end` (ISO), so choosing a point opens exactly that window. Without `end`, a read is unchanged.

Client: `MetricsTrends.tsx` draws SVG small multiples with no dependency, following the `dataviz` skill. There is one chart per metric with its family heading, a band for `insufficient` points, a mark for fired rules, and a `<table>` alternative per chart. `teamLocation.ts` parses `metrics/trends/<range>`; `trends` is not a window id, so the existing window parse keeps its meaning. The range and collapsed families are per-team `teamWorkspaceStore` state, as windows are today.

Alternative considered: store a daily snapshot and chart it. That adds a table, retention, and a second derivation that can drift from the live one (oracle hazard "several readers disagreeing"), so it was rejected. Recomputation is cheap here.

### D7 — The Prometheus export reads the same cache, recomputing totals

`MetricsSnapshot` (`src/server/metrics/export/snapshot.ts`) gains an optional `delivery` seam, `{ facts(teamId), degradation(teamId), linkedTasks(db, teamId) }`, wired by the manager. Inside its existing read transaction, each team with cached facts gets the following.

| family | type | value |
|--------|------|-------|
| `delivery_integrations_total` | counter | first-parent chain length of the head (`git rev-list --first-parent --count`, taken in D1's refresh, not at scrape) |
| `delivery_changes_landed_total` | counter | archive arrivals over full history (read 2) |
| `delivery_change_cycle_seconds` | histogram, `DURATION_BUCKETS` | each landed change with linked tasks, over full history |
| `delivery_change_tasks` | histogram, buckets 1, 2, 5, 10, 20, 50, 100, +Inf | same cohort |
| `delivery_change_review_rounds` | histogram, buckets 0, 1, 2, 5, 10, 20, 50, +Inf | same cohort |
| `delivery_inflight_changes`, `delivery_inflight_oldest_age_seconds` | gauge | now |
| `delivery_facts_available`, `delivery_facts_stale`, `delivery_fetch_age_seconds` | gauge | the cache entry |
| `degradation_rule_firing` | gauge, label `rule` | the monitor's cached outcome |

Labels are `team` (the existing persistent alias through `BoundedLabels`) and `rule`, whose values are enumerated from `DEGRADATION_RULES`.

The totals are recomputed from records that are never pruned: git history, and team tasks and findings, which have no pruning. So they need no `ExportAccumulator` row and survive restarts by construction. A history rewrite lowers them, and Prometheus treats that as a counter reset. The registry adds definitions only, so `DEFINITION_VERSION` stays 1, and no existing family changes.

Alternative considered: accumulate through `ExportAccumulator` like turn tokens. Those totals are kept because their source rows are pruned. Delivery sources are not pruned, and accumulating would add a second truth that could diverge from git, so it was rejected.

### Acceptance oracles

**Table L: result landing.** Rows are judged against `landingTimes` plus the containment fallback.

| id | commit position | horizon | → landing |
|----|-----------------|---------|-----------|
| L1 | is a first-parent commit F | inside | landed at F's time |
| L2 | reached only through F's second parent | inside | landed at F's time |
| L3 | reachable from F1 and from a later F2 | inside | landed at F1's time (the earliest) |
| L4 | not an ancestor of the head | inside | not landed |
| L5 | ancestor of the head, older than the horizon | outside | landed, time unknown |
| L6 | not an ancestor, older than the horizon | outside | not landed |
| L7 | `commit_ref` does not resolve | * | unresolvable, excluded with coverage note |

There are no unreachable combinations. Out-of-order committer times, where `--since` cuts the graph unevenly, fall to L5 or L6 through the containment fallback. P1 generates them.

**Table C: change landing.**

| id | archive history | → landing |
|----|-----------------|-----------|
| C1 | added by a merge commit | at the merge's time |
| C2 | added by a direct first-parent commit | at that commit's time |
| C3 | added twice (re-archived under a new date) | at the first arrival |
| C4 | added on an unmerged branch only | not landed |
| C5 | added, later deleted from master | landed at the arrival (history is not rewritten) |

**Table R: rules.** `*` means don't care. "fires" lists rule ids.

| id | facts | baseline landed | landed ratio | integ ratio | token ratio | cost ratio | → fires |
|----|-------|-----------------|--------------|-------------|-------------|------------|---------|
| R1 | stale | * | * | * | * | * | none; the tab shows the stale marker |
| R2 | unavailable | * | * | * | * | * | none |
| R3 | fresh | < 10 | ≤ 0.6 | ≤ 0.7 | ≥ 0.8 | * | none from the landing rules |
| R4 | fresh | ≥ 10 | ≤ 0.6 | ≤ 0.7 | ≥ 0.8 | * | `delivery-drop` only |
| R5 | fresh | ≥ 10 | ≤ 0.6 | ≤ 0.7 | < 0.8 | ≥ 2 | `cost-per-change-rise` if current landed ≥ 3, else none |
| R6 | fresh | ≥ 10 | ≤ 0.6 | > 0.7 | ≥ 0.8 | < 2 | none |
| R7 | fresh | ≥ 10 | > 0.6 | * | * | ≥ 2 | `cost-per-change-rise` |

`convergence-drift` and `inflight-aging` are independent of the columns above. Each gets its own two rows: at the floor and fires, and below the floor and does not.

**Table T: tool surface.** Every refusal uses the tool-error envelope that the existing unknown-window refusal uses (oracle hazard "refusals missing the success envelope").

| id | call | → result |
|----|------|----------|
| T1 | `team_metrics {window:'7d'}` | compact, < 32 KB on the seeded 300-task fixture, values equal to the tab's |
| T2 | `{window:'7d', metrics:['tasks_per_landed_change']}` | that metric carries ≤ 50 drill entries and `drillTotal`; the others are compact |
| T3 | `{window:'7d', metrics:['velocity']}` | refused, naming the known ids |
| T4 | `{window:'7d', slice:{kind:'group'}}` | slice rows present, no drill lists |
| T5 | `process_reports_list` | no `snapshot` key on any report |
| T6 | `process_report_get {full:true}` | snapshot byte-equal to the stored one |

**Properties.** All use a seeded `mulberry32`, defined in the test file the way the existing property tests define it (for example `checkRecords.test.ts`), and no new dependency.

- **P1, landing equals brute force.**
  - Generator: random DAGs of 30–200 commits with 1–3 parents, a random first-parent chain, and shuffled committer times.
  - Seam: `landingTimes`.
  - Property: each commit's stamp equals the minimum time over chain commits whose ancestor closure contains it.
  - Seed 0xDE11, 500 cases.
- **P2, the compact form is a projection.**
  - Generator: random `MetricsInputs` built over the existing `metricsSeed.ts` helpers.
  - Property: for every metric, `compactMetrics(m)` keeps `value`, `n`, `baseline`, `insufficient`, and `unavailable` equal to `m`'s.
  - Seed 0xC0DE, 300 cases.
- **P3, the rules are monotone in delivery.**
  - Holding the token and integration figures and the samples fixed, lowering the current changes landed never turns `delivery-drop` from firing to not firing.
  - Seed 0xD0D0, 500 cases.

- **P4, a trend point is a past read.**
  - Generator: random `MetricsInputs` spanning 13 weeks with random delivery facts.
  - Property: for every k, point k of `readTrends` equals `computeMetrics` at `end_k` over a load made for that end, projected compactly. Values, `n`, baselines, flags, and fired rules all match.
  - Seed 0x7E4D, 100 cases.

**Table E: export.** Each row is a scrape against a fixture team.

| id | endpoint | facts | rule | → delivery series |
|----|----------|-------|------|-------------------|
| E1 | disabled | * | * | none (the route is unregistered, as today) |
| E2 | enabled | none yet | * | `delivery_facts_available` 0 only |
| E3 | enabled | fresh | not firing | all families; `degradation_rule_firing` 0 per rule |
| E4 | enabled | fresh | `delivery-drop` firing | its gauge 1, the others 0 |
| E5 | enabled | stale | * | all families, `delivery_facts_stale` 1, every rule gauge 0 |
| E6 | enabled | fresh, then restart, nothing landed | * | counters and histogram buckets equal before and after |
| E7 | enabled | fresh, 90 landed changes | * | one histogram series per team alias; no change name in any label |

A spawn spy asserts that no scrape runs git, for E2–E7.

**Table TR: trends surface.**

| id | request | → result |
|----|---------|----------|
| TR1 | range `4w` | 4 points, newest ending at the read |
| TR2 | range `6w` | refused, naming 4w, 8w, 12w, with the same error envelope as an unknown window |
| TR3 | unknown `teamPath` | `unknown-team`, no data |
| TR4 | point window starts 40 days back | `limit_tax_hours` partial at that point |
| TR5 | `process-metrics-open` with `end` | the window ending at `end`; values equal TR1's matching point |
| TR6 | `process-metrics-open` without `end` | unchanged from today |

**Production composition (M1).** One test builds the manager as production does, with a temporary git repository (`cleanGitEnv`) whose origin carries 12 archives in the baseline week and 2 in the current week, plus token rows. It asserts that the workspace snapshot lists `process-degradation:delivery-drop`. Its mutant removes the source from `ATTENTION_SOURCES`. A second test enables the export through the production server wiring and asserts row E4. Its mutant leaves the `delivery` seam unwired.

## Risks / Trade-offs

- **[Archives are lumpy: a change lands its code across many PRs and archives once]** → `delivery-drop` also requires integrations to fall, and its baseline floor is 10. Integrations are reported beside changes landed.
- **[Goodhart: changes get split to raise changes landed]** → tokens per landed change and the convergence metrics travel with it, its guard is reopen rate, and rules detect rather than target.
- **[A team that never fetches is never alerted]** → the tab shows the stale marker with the fetch age, and the unavailable reason names `git remote set-head origin --auto` when the ref is unset. Kawai does not fetch: that is a write to the repository's refs, and agents fetch routinely.
- **[Linked-task coverage is partial (69% here)]** → convergence carries its coverage metric, and `convergence-drift` requires coverage of at least 0.5 on both sides.
- **[Rule thresholds are guesses]** → they are constants in one table, calibrated in task 9.2 against this repository's last six weeks before merge. Moving one is a reviewed code change, never configuration.
- **[A 12-week trend repeats the computation 12 times]** → it runs over one load, is cached 5 minutes per range, and is never computed on a workspace push. Task 9.3 measures it on a copy of the live database.
- **[Past trend points change when records change after the fact, for example a late result or a reopened task]** → this is intended: a point is the read you would make now for that end, as P4 states. The view says "recomputed at <time>".
- **[Old report snapshots lack the delivery family and show lead time's new guard as absent]** → readers render absent, and the guard is read from definitions as today.

## Migration Plan

There is no schema migration and no stored state. Deploying adds the family, the rules, the compact tool forms, the Trends view, and the export families. The export families appear only where `KAWAI_METRICS_ENABLED` is already set. Rolling back is a revert: no data was written that older code would misread. Reports frozen after the change carry the delivery family in their snapshot JSON, and older readers ignore unknown metric ids.

## Open Questions

- The exact threshold values in the D4 table may move during calibration (task 9.2). The specs' scenarios use the 2026-10-20 figures, which any calibrated value must still fire on.
