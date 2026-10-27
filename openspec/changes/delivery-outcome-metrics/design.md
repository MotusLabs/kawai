# Design

## Context

For motivation, see proposal.md › Why. Its figures and the per-repository counts that follow were supplied by the original author and are unverified: no live database, backup, or timing was read for this design, and none may be until a separate authorization (D9).

Today's metrics pipeline works like this:
- `loadMetricsInputs` (`src/server/metrics/metricsQuery.ts`) reads SQLite inside one read transaction. Its cohorts come from in-range events (first `done`, status events, results, findings), and its projections carry no `openspec_change`, `plan_change`, or `commit_ref`.
- `computeMetrics` derives every family purely, for the window and for the preceding window, at `inputs.end`.
- `MetricsReader` caches one read per (team, window, slice) for 30 s, always ending at the read time.
- The Metrics tab, `team_metrics`, and report snapshots all share that reader.
- Definitions, guards, and the sample threshold are constants in `src/shared/processMetrics.ts`. `tokens_total` is a sum whose `n` is the usage rows: with no rows it reads value 0 with `n` 0, and `docs/operations/process-observability.md` states that missing usage is excluded rather than zero.

There is no git input and no push path to the attention queue. `WorkspaceRead.snapshot` (`src/server/team/workspaceRead.ts`) is synchronous and folds the `ATTENTION_SOURCES` over one `AttentionInput`. `WorkspaceConnections` owns the workspace subscriptions and coalesces `publish(teamId)`.

Git: `runGitAsync` (`src/server/git/gitCommand.ts`) is the read-only runner. It kills a call at its timeout and resolves it as a non-success with a null exit code, and it clips a successful stdout at `maxOutputBytes` (1 MiB by default) without saying so. Result checks already treat `refs/remotes/origin/HEAD` as the base "as last fetched".

Export: `registerMetricsRoute(app, service, env)` (`src/server/metrics/export/route.ts`) constructs its own `MetricsSnapshot`. `bootstrap.ts` calls it with `chatSessionManager.observations`. `agent_tokens_total` carries the turn dimensions plus `kind`.

## Goals / Non-Goals

**Goals:**
- Delivery facts become one derivation from one pinned head, consumed by metrics, rules, the tab, and the export alike (oracle hazard "several readers disagreeing on derived state").
- Metric computation stays pure and synchronous. Git runs only in a refresh step outside the SQLite read.
- A fact Kawai cannot establish reads unavailable or unknown, never 0, never landed.
- Agent reads become small enough to use.

**Non-Goals:**
- No delivery metric is sliceable. All are team-side.
- No per-PR identity from GitHub. Integrations are first-parent commits, read without `gh`.
- No claim about when an observer learned a fact. Committer time is a proxy for arrival, and a trend point is a recomputation (D6).
- No change to `process-observability`'s contracts, its acceptance cohorts, or its pending integrations (D8).

## Decisions

### D1 — Facts come from one pinned head, read whole

**Head.** `DeliveryFactsReader` (`src/server/metrics/delivery/gitReader.ts`) resolves the head H without a process, reading text under the team's git common directory, as `repoFacts.ts` reads config:
- `refs/remotes/origin/HEAD` holds either `ref: <name>` or a hex object id (40 or 64 digits).
- A symbolic name is followed for at most 5 hops. Each hop reads the loose ref file first, then `packed-refs` (comment lines and `^` peel lines skipped). A loose ref wins over a packed one.
- A missing `refs/remotes/origin/HEAD` gives `unavailable: no-default-branch`, whose text names `git remote set-head origin --auto`. A directory with no git common directory gives the same reason and spawns nothing.
- Malformed content, a sixth hop, a loop, or a name found neither loose nor packed gives `unavailable: default-branch-unreadable`.
- A `shallow` file in the common directory gives `unavailable: history-incomplete:shallow` without spawning git.

**Reads.** Every git call names the literal object id H, never a ref, so a fetch during a refresh cannot mix heads. Each runs at the main checkout through `runGitAsync` with `cleanGitEnv`, `git --no-replace-objects -c log.showSignature=false`, a 10 s timeout, and `maxOutputBytes = DELIVERY_READ_BOUND` (64 MiB). There are two reads:
1. **Graph.** `git log --format=%H %ct %P H` loads H's whole history. There is no `--since` and no horizon: `--since` stops a walk at an old-dated commit and would hide newer ancestors behind it.
2. **Archives.** `git log --first-parent --no-renames --diff-filter=A --name-only --format=@%H H -- 'openspec/changes/archive/*/proposal.md'`. `--first-parent` implies first-parent diffs for merges. `--no-renames` makes an archive done by `git mv` read as an addition whatever `diff.renames` says.

The lifetime integration count is the first-parent chain length derived from read 1, so it is pinned with the rest. No `rev-list --count` and no `merge-base` runs.

**Completeness (Table F).** A read is accepted only when:
- it exits 0;
- its stdout is shorter than `DELIVERY_READ_BOUND`, so a clipped output is never read as history;
- every row parses;
- read 1's first row is H, and every parent it names is itself a row. Truncation always drops some commit whose children remain, so this closure check detects any lost tail and any missing object;
- every `@<sha>` of read 2 lies on read 1's first-parent chain, and every path matches the archive pattern.

Any other outcome fails the refresh with a named reason. A non-zero exit, a null exit (timeout or kill), and a spawn failure are all failures; none means "not contained". A history past the bound is `history-exceeds-bound`, never a partial answer. Raising the bound is a reviewed constant change.

**Commit refs** resolve against read 1 alone, with no process:
- a full object id is landed when it is in H's graph and not landed otherwise;
- a hex prefix of 7–39 digits that matches exactly one graph commit is that commit, and one that matches none is not landed (it cannot be in H);
- more than one match, or anything else, is unresolvable. It is excluded from `landed_result_share` and counted in its coverage note.

Alternative considered: keep a 98-day `--since` graph with a `merge-base --is-ancestor` fallback. It loses in-window integrations behind old-dated commits, adds an exit-code ambiguity (exit 1 = not an ancestor, other non-zero = error), and reports "landed, time unknown", which cannot answer "landed by T". The whole graph is bounded by the closure check and the byte bound instead. Its size and time on any real repository are Unknown until measured under D9.

### D2 — Facts generations, single-flight, and freshness

`DeliveryFactsCache` (`delivery/factsCache.ts`) holds per team at most one **accepted generation**: an id (a per-process counter), H, the fetch stamp (`FETCH_HEAD`'s mtime and size in the common directory, or none), the read time, and the facts. Consumers never see a half-built generation. Table G gives every transition. In short:
- `check(team)` is synchronous: it resolves H and stats `FETCH_HEAD`, with no process.
- When the accepted generation has the same H and the same stamp, `check` serves it unchanged.
- When only the stamp differs, `check` publishes a new generation id over the same facts, with no git, so a same-head fetch refreshes freshness.
- When H differs, `check` serves the old generation marked `behind` and starts one flight for the new H. A flight for another H already running records the newest H as pending, and nothing else spawns.
- On completion the ref is resolved again. A flight whose H is no longer the ref's is obsolete: it is discarded and the pending or current H is flown next. Only a completion that matches the ref is accepted.
- A failed flight keeps the previous generation, marked `refresh-failed` with the reason, or reads unavailable with the reason when there is none. Retries back off 30 s, 2 min, then 10 min, capped. The facts are never patched with partial results.
- `stop()` discards every later completion.

**Freshness** is computed at each read against the current time, never stored: `stale` when the stamp is missing or older than 24 h. A generation is **current** when its H equals the ref resolved by the same `check` and it is not stale. Rules (D4) and the export's rule gauges (D7) use only current generations. The Metrics tab shows a non-current generation's values with its marker (`stale`, `behind`, `refresh-failed`, with the fetch age).

**Derived caches** key on the generation id: `MetricsReader` on (team, window, slice, end, generation), `TrendsReader` on (team, range, generation), and the monitor's outcome records the generation it evaluated. A new generation makes every older entry unreachable, so no explicit invalidation path exists to forget.

The cache is memory only. A restart starts cold (G2), and nothing is persisted or recovered.

Alternative considered: make `MetricsReader.read` async and run git inline. `WorkspaceRead.snapshot` and the attention fold are synchronous and push often, so every snapshot would wait on git. That was rejected.

### D3 — Landing is a pure walk by first-parent position

`landingPositions(graph, H)` (`delivery/landing.ts`, pure) derives the first-parent chain F₁…Fₙ from H (oldest first). For k = 1…n, a breadth-first walk from Fₖ through all parents stops at commits already reached and stamps each newly reached commit with **position k**. A commit is landed exactly when it has a position. Its landing carries:
- `at = ct(Fₖ)`, the committer time of its position, as a timestamp proxy. It is never a minimum over other chain commits' times;
- `bound = max(ct(F₁…Fₖ))`, the latest committer time at or before its position.

**Landed by T** has three answers:
- `bound ≤ T` → landed by T;
- `at ≤ T < bound` → unknown at T. Fₖ is backdated relative to an earlier position, so its time cannot order it against T;
- `T < at` → not landed by T.

A landing in window [T − 7 d, T) means landed by T with `at ≥ T − 7 d`. Unknown landings are excluded from every count and value at T and listed in the delivery coverage note (D3a). An integration is Fₖ itself, with the same three answers.

**Change landings** come from read 2. The directory `<date>-<name>` gives the name, and its first chain position (the oldest `@<sha>`) wins, with that position's `at` and `bound`.

### D3a — Facts enter the metrics as an input, with complete linked history

`MetricsInputs` gains `delivery: DeliveryView | null`, where the view holds the accepted generation's landings, chain, and freshness at the read. `computeMetrics` stays pure and gains `deliveryObservations(ctx)` (`delivery/observations.ts`), which emits:
- `changes_landed` and `integrations` (sum);
- `tokens_per_landed_change` (ratio: `tokens_total` as numerator, changes landed as denominator, `n` = changes landed);
- `change_cycle_time_p50/p90`, `tasks_per_landed_change` (mean), and `review_rounds_per_landed_change` (mean);
- `landed_change_link_coverage`;
- `inflight_change_age_p50/p90`;
- `landed_result_share`, which is in the coverage family.

**Linked history.** `loadMetricsInputs` gains one phase inside its existing read transaction. It loads every team task whose `openspec_change` or `plan_change` is set and that was created before the read's end, whatever its events, with all of its status events, its results with `commit_ref`, and its findings. `MetricTask` gains `openspecChange` and `planChange`, and `MetricResult` gains `commitRef`. This covers:
- an old task with no event in either window whose change lands now;
- a change landed today that was in flight at the baseline's end;
- every end of a trend range.

These tasks feed only the delivery observations. The existing families keep their cohorts unchanged.

**Status at T** is the `to_status` of the task's latest status event at or before T, else `open` from its creation. A task created after T does not exist at T. A status that comes from a backfilled row (`from_status` null), or a T before the team's first recorded status event, makes the derived in-flight values approximate.

**Rules per metric:**
- A change is **linked** to a landing when at least one task naming it was created before the landing's `at`.
- Tasks per landed change counts those tasks.
- Review rounds per landed change counts findings created before `at` on those tasks' results.
- Cycle time runs from the first such task's creation to `at`.
- A change is **in flight at T** when it is not landed by T (an unknown landing is excluded, not in flight) and one of its tasks is open, active, or blocked at T. Its age runs from its first task's creation.
- `landed_result_share`, for the tasks first done in the window that have a result, takes each task's newest result created before T. The share counts the commits landed by T among those that are known: unresolvable and unknown-at-T commits are excluded, and the coverage note counts them.

**Unavailable.** When `delivery` is null or unavailable, every delivery metric has `value: null`, `n: 0`, and a new optional `unavailable: string` on `MetricValue`. `ProcessMetrics` gains `delivery: { head, generation, readAt, fetchedAt, state, reason?, unknownAtEnd, unresolvable }`, where `state` is `current | stale | behind | refresh-failed | unavailable`.

**Input completeness per end (Table K).** The existing usage horizon is computed as `end − 90 d`, which equals the pruning horizon only when the read ends now. For any end T it becomes `max(now − 90 d, first recorded turn)`, and the read at `end = now` keeps its exact current value. A metric is `partial` at T when either side's inputs reach before their horizon:
- token metrics, when T − 14 d precedes the usage horizon;
- limit tax, when T − 14 d − 24 h precedes `now − 15 d`.

The flags apply to the window and the baseline alike, and both are kept by every projection (D5).

`METRIC_FAMILIES` gains `delivery`, listed first. The guard of `lead_time_p50/p90` changes to `landed_result_share`. `tokens_per_landed_change` is guarded by `reopen_rate`, so splitting a change to cut its cost shows up as rework. No existing metric's definition changes.

The determinism requirement now holds per (team, window, slice, end, generation). Both surfaces read the same generation through the same reader, so they still agree.

### D4 — Degradation rules are a constant table of total predicates

`DEGRADATION_RULES` (`src/shared/degradationRules.ts`, pure) is evaluated by `evaluateDegradation(metrics7d)`. Each rule returns exactly one of:
- `fires` with its evidence (current and baseline values);
- `holds-not`;
- `not-evaluable` with the first failing input condition.

Every rule is `not-evaluable: facts` unless the generation is current. Only `fires` raises anything. "Tokens complete" means `tokens_total` is not partial on either side. A rule never reads a missing usage record as 0.

| id | inputs required, else `not-evaluable` | fires when |
|----|----------------------------------------|------------|
| `delivery-drop` | baseline changes landed ≥ 10; baseline integrations ≥ 1; tokens complete; baseline tokens > 0 | current changes ≤ 0.6 × baseline, and current integrations ≤ 0.7 × baseline, and current tokens ≥ 0.8 × baseline |
| `cost-per-change-rise` | current changes landed ≥ 3; baseline ≥ 10; tokens complete; baseline tokens > 0 | current tokens per landed change ≥ 2 × baseline, and `delivery-drop` is not `fires` (`holds-not` or `not-evaluable`) |
| `convergence-drift` | linked landed changes ≥ 5 on both sides; link coverage ≥ 0.5 on both sides | current tasks per landed change ≥ 2 × baseline |
| `inflight-aging` | in-flight changes ≥ 3 on both sides; neither side approximate; baseline p90 > 0 | current p90 ≥ 72 h, and ≥ 2 × baseline p90 |

The thresholds are constants. Moving one is a reviewed code change, never configuration, and never done to make a chosen historical window fire (D9).

`DeliveryRuntime` (`src/server/metrics/delivery/runtime.ts`) is one per manager. It owns the facts cache and the `DegradationMonitor` (`delivery/degradationMonitor.ts`) and is the one lifecycle owner of delivery refresh:
- The manager starts it after boot, as it starts the supervision monitor, and stops it at shutdown. Stopping clears every timer and discards later completions.
- `bootstrap.ts` passes it to `registerMetricsRoute(app, observations, env, delivery)`. When the route reports itself enabled, bootstrap calls `delivery.enableExport()`.
- **Export enabled:** an unref'd 60 s timer runs `check` for every registered team and re-evaluates the rules, independent of any browser, subscription, or tool call. Registered teams are the distinct team ids of `team_tasks` and of non-killed chat sessions, each resolved to its main checkout. The first pass runs at start.
- **Export disabled:** the same timer is armed only while the team has at least one subscriber. `WorkspaceConnections` open, close, and disconnect, and the metrics and trends subscriptions, report reference counts to the runtime. At zero subscribers the timer is cleared.
- Re-evaluation also runs on a generation change and on a Metrics refresh.

**Publication.** The monitor keeps, per team, its outcome: the generation id, the evaluation time, every rule's result, and an evidence fingerprint (rule results plus their evidence values). It calls `WorkspaceConnections.publish(teamId)` whenever the fingerprint changes, not only when the fired ids change. It also schedules one evaluation at the moment the current generation would cross the 24 h stale bound.

**Gating.** Every synchronous consumer reads the outcome through `delivery.outcome(team, now)`. That returns rule results only when the outcome's generation is the accepted one, that generation is current at `now`, and the evaluation is at most two timer intervals old. Otherwise it returns "not current" with the reason. So a stale or obsolete outcome never keeps an item or a gauge alive.

`degradationItems` joins `ATTENTION_SOURCES` with kind `process-degradation`, owned by the human. It is fed by a new `AttentionInput.degradation`. Its link is `{ kind: 'metrics', id: '7d' }`, a new `AttentionLink` kind, which the client opens as `#/team/<key>/metrics/7d`.

Alternative considered: store fired episodes for one toast per episode. The item identity `process-degradation:<rule>` already gives one toast per client session while the rule holds. Storing episodes would add a table and recovery-matrix rows for little gain, so it was rejected.

### D5 — Compact reads are projections of the same computation

`compactMetrics(metrics, { ids?, drillCap = 50 })` (`src/shared/processMetrics.ts`, pure) projects a `ProcessMetrics` value:
- It drops `drill` and `breakdown` from every metric not in `ids`.
- It keeps `slices` only when a slice was asked.
- For the named metrics, it caps each drill list and adds `drillTotal: { tasks, messages }`.
- It keeps every value, `n`, baseline, and flag (`insufficient`, `partial`, `approximate`, `unavailable`, the guard) and the whole `delivery` header.

`team_metrics` gains `metrics?: string[]`. An unknown id throws, like an unknown window, so the refusal has the same tool-error shape. The tool reads the full value from `MetricsReader` and projects it, so the numbers cannot diverge from the tab. Its default becomes compact. Metric ids, values, and their meanings are unchanged, and the full form stays available per metric through `metrics`.

`process_reports_list` maps each report to its record without `snapshot`. `process_report_get` gains `full?: boolean`; without it, the stored snapshot passes through `compactMetrics`. Stored snapshots are never rewritten. Readers treat a missing metric id, or a missing `delivery` field, in an old snapshot as absent.

### D6 — Trends recompute the 7d read at past ends

`computeMetrics` gains an explicit `end` (today it reads `inputs.end`). `readTrends(team, range)` (`src/server/metrics/trends.ts`) works in four steps:
1. It takes the current accepted generation once.
2. It loads `MetricsInputs` once over `[now − (weeks + 1) × 7 d, now]` with that generation's view. `loadMetricsInputs` already takes `from`/`end`, and the extra week is the first point's baseline.
3. For each point end `end_k = now − k × 7 d` (k = 0…weeks−1), it calls `computeMetrics(inputs, '7d', null, end_k)` and `evaluateDegradation` on the result.
4. It projects every point through `compactMetrics`.

Landings count at `end_k` by D3's three-answer rule. A point is what today's records and today's generation say about that end. It is **not** what anyone could have read then: a late fetch, a history rewrite, a backdated commit, or a late result changes past points, and the view says "recomputed at <time> from <head>". Freshness and staleness are today's.

`TrendsReader` caches one read per (team, range, generation) for 5 minutes, and a Metrics refresh drops it. A 12-week read is 12 computations over one load. Its time on a real database is Unknown. Task 9.2 measures it on the deterministic fixture only, and a slow result is fixed with a longer cache, never different semantics.

**Protocol:**
- `process-metrics-trends-open { teamPath, range }` → `process-metrics-trends { teamId, range, points, delivery, computedAt }`, and `process-metrics-trends-close`, all in `CHAT_CONNECTION_TYPES`.
- The snapshot is re-sent on open, on refresh, and on a generation change.
- `process-metrics-open` gains an optional `end` (ISO), so choosing a point opens exactly that window. The connection keeps the subscription's `end`: refreshes and generation re-sends read at that `end`, and a new `process-metrics-open` replaces it. Without `end`, a read is unchanged.

**Client:** `MetricsTrends.tsx` draws SVG small multiples with no dependency. There is one chart per metric with its family heading, a band for `insufficient` and `partial` points, a mark for fired rules, and a `<table>` alternative per chart. `teamLocation.ts` parses `metrics/trends/<range>`; `trends` is not a window id, so the existing window parse keeps its meaning. The range and collapsed families are per-team `teamWorkspaceStore` state, as windows are today. The `dataviz` and `dev-browser` capabilities this view's verification names are prerequisites (D9).

Alternative considered: store a daily snapshot and chart it. That adds a table, retention, and a second derivation that can drift from the live one (oracle hazard "several readers disagreeing"), so it was rejected. The stored snapshot would also only record what one server observed, which this view does not claim.

### D7 — The Prometheus export reads the same generation, recomputing totals

`registerMetricsRoute` gains an optional fourth parameter, the `DeliveryRuntime`, which it passes to `MetricsSnapshot` as a seam `{ view(teamId, now), outcome(teamId, now) }`. The seam is synchronous and never runs git. Inside the snapshot's existing read transaction, each registered team gets:

| family | type | value |
|--------|------|-------|
| `delivery_facts_available` | gauge | 1 with an accepted generation, else 0 |
| `delivery_integrations_total` | counter | the generation's first-parent chain length |
| `delivery_changes_landed_total` | counter | the generation's change landings over full history |
| `delivery_change_cycle_seconds` | histogram, `DURATION_BUCKETS` | each landed change with linked tasks, over full history |
| `delivery_change_tasks` | histogram, buckets 1, 2, 5, 10, 20, 50, 100, +Inf | same cohort |
| `delivery_change_review_rounds` | histogram, buckets 0, 1, 2, 5, 10, 20, 50, +Inf | same cohort |
| `delivery_inflight_changes`, `delivery_inflight_oldest_age_seconds` | gauge | now |
| `delivery_facts_stale`, `delivery_fetch_age_seconds` | gauge | the generation at the scrape |
| `delivery_rules_current` | gauge | 1 when `outcome` is current, else 0 |
| `degradation_rule_firing` | gauge, label `rule` | 1 for a rule that `fires` in a current outcome, else 0 |

With no accepted generation, the team exports only `delivery_facts_available 0`. The linked-task histograms read team tasks and findings inside the snapshot's transaction.

Labels are `team` (the existing persistent alias through `BoundedLabels`) and `rule`, whose values are enumerated from `DEGRADATION_RULES`. No change name, branch, commit, path, or task id is ever a label.

The totals are recomputed from records that are never pruned: git history, and team tasks and findings, which have no pruning. So they need no `ExportAccumulator` row and survive restarts by construction, once the first post-restart generation is accepted. A history rewrite lowers them, and Prometheus treats that as a counter reset. The registry adds definitions only, so `DEFINITION_VERSION` stays 1, and no existing family changes.

**The PromQL ratio is approximate.** `sum by (team) (increase(kawai_agent_tokens_total[7d])) / sum by (team) (increase(kawai_delivery_changes_landed_total[7d]))` sums every token kind and turn dimension per team. It divides increases as observed at scrape time:
- tokens advance when turns are reconciled;
- landings advance when a fetch is discovered, all at once after warm-up or after a late fetch;
- a rewrite reads as a reset;
- tokens have the observation coverage limits of `process-observability`.

So it approximates, and does not equal, the read-time `tokens_per_landed_change`, which uses committer-time windows. Exact historical windows stay Kawai's own read.

Alternative considered: accumulate through `ExportAccumulator` like turn tokens. Those totals are kept because their source rows are pruned. Delivery sources are not pruned, and accumulating would add a second truth that could diverge from git, so it was rejected.

### D8 — Delivery is evidence, never a decision input or acceptance

Delivery facts, metrics, and rule results are outcome and guard evidence only:
- No dispatch, routing, staffing, execution, landing, or acceptance path reads them, directly or through another module.
- Landing never accepts a result.
- A landed commit is not a first durable acceptance fact for `process-observability`, whose acceptance cohorts and mechanisms stay as that change defines them.

The boundary is checked behaviorally (Table N) at the real composition seams. The import guard is a second, supplementary check.

### D9 — Validation uses deterministic fixtures; real data needs its own authorization

Thresholds and behavior are validated only on sanitized deterministic fixtures:
- a temporary git repository built with `cleanGitEnv`, with fixed committer times;
- `metricsSeed.ts` rows with fixed UTC instants;
- a declared schema version and fixed read ends (`2026-10-27T00:00:00Z` and the four weeks before it), passed as `now`, never taken from the clock.

The calibration cases (Table CAL) are declared in the test before its thresholds are read, and they are separate from the spec scenarios, so neither is tuned to the other. No step copies or reads the live database, its WAL or journal, or a backup. Any check on real data needs a separate explicit authorization and would use the existing consistent, integrity-checked, private backup procedure (`docs/operations/database-backups.md`), with private rows, paths, and credentials kept out of journals and results. This design prescribes none. The original author's historical counts, latencies, and sizes stay Unknown until such a check runs.

UI verification names two capabilities that are not guaranteed to exist in an implementing session: the `dev-browser` skill (screenshots, per AGENTS.md) and the `dataviz` skill (chart conventions). Their availability is a prerequisite of tasks 2.4 and 7.2. When either is missing, the implementer stops that verification and asks the Lead for a separately reviewed alternative. Neither is installed, and their evidence is never substituted. Backend tasks do not depend on them.

### Acceptance oracles

**Table H: head resolution.** Seam: `resolveHead(commonDir)`.

| id | common dir state | → outcome |
|----|------------------|-----------|
| H1 | no git common directory | unavailable `no-default-branch`, no process |
| H2 | `refs/remotes/origin/HEAD` missing | unavailable `no-default-branch`, naming `git remote set-head origin --auto` |
| H3 | symbolic → loose ref | H = the loose ref's id |
| H4 | symbolic → packed only (with a `^` peel line after it) | H = the packed id, peel line ignored |
| H5 | symbolic → loose and packed differ | H = the loose id |
| H6 | the file holds a hex id | H = that id |
| H7 | malformed text, a loop, a sixth hop, or a target found nowhere | unavailable `default-branch-unreadable` |
| H8 | `shallow` file present | unavailable `history-incomplete:shallow`, no process |

**Table F: read completeness.** Seam: `DeliveryFactsReader.read(H)` with a stub runner that checks its arguments: the literal H, `--no-replace-objects`, `--no-renames`, no ref name, and no `fetch`, `push`, `update-ref`, or `remote`.

| id | runner outcome | → read |
|----|----------------|--------|
| F1 | exit 0, rows close under parents, first row H, archives on the chain | accepted |
| F2 | exit non-zero | failed `git-failed:<code>` |
| F3 | exit null (timeout or kill) | failed `git-timeout` |
| F4 | spawn failure | failed `git-unavailable` |
| F5 | stdout length = `DELIVERY_READ_BOUND` (clipped) | failed `history-exceeds-bound` |
| F6 | a row does not parse | failed `history-malformed` |
| F7 | first row is not H | failed `history-malformed` |
| F8 | a named parent has no row (a dropped tail) | failed `history-incomplete` |
| F9 | an archive `@<sha>` not on the chain, or a stray path | failed `archive-malformed` |

**Table G: facts generations.** Seam: `DeliveryFactsCache` with a fake reader, ref, stamp, and clock. Axes: accepted generation (none | A at H_a), resolved ref (unreadable | H_a | H′ ≠ H_a), flight (none | running for H_f), backoff (inactive | active), event.

| id | accepted | ref | flight | backoff | event | → result |
|----|----------|-----|--------|---------|-------|----------|
| G1 | * | unreadable | * | * | check | not current with the reason: A served `refresh-failed`, or unavailable; no new flight; pending unchanged |
| G2 | none | H′ | none | inactive | check | unavailable `reading default branch`; one flight for H′ |
| G3 | * | hex id = H_f | running | inactive | check | no second flight |
| G4 | * | hex id ≠ H_f | running | inactive | check | pending := that id; no second flight |
| G5 | A | H_a, same stamp | none | * | check | A served current; no git |
| G6 | A | H_a, new stamp | none | * | check | new generation id, same facts, new freshness; no git |
| G7 | A | H′ | none | inactive | check | A served `behind`; one flight for H′ |
| G8 | A or none | H′ | none | active | check | served `refresh-failed` (or unavailable); no flight before the retry time |
| G9 | * | re-resolved = H_f | running | inactive | success | accepted as a new generation; failures cleared; listeners told |
| G10 | * | re-resolved ≠ H_f (or unreadable) | running | inactive | success | discarded as obsolete; one flight for the re-resolved id, else the pending id, when either is a hex id |
| G11 | A or none | * | running | inactive | failure | A kept `refresh-failed` with reason, or unavailable; backoff 30 s → 2 min → 10 min |
| G12 | * | * | * | * | stop, then any completion | nothing accepted or published |

Unreachable: "running" with backoff active (a flight only starts once the retry time has passed); a success at H_f with no flight (completions come only from flights). **Completeness claim:** every combination of the five axes matches exactly one row or one unreachable claim. The completeness test expands the axes over the table. The model-based test runs Table G as the reference model under seeded sequences of {move ref, touch `FETCH_HEAD`, check, complete ok, complete fail, advance clock, stop}, seed 0x6E4E, 300 sequences of 40 commands. After each command, every accepted generation's facts must equal the facts computed offline for its own H (no mixed heads).

**Table L: result landing.** Seam: `landingPositions` plus the commit-ref resolution. Ft is a first-parent commit with committer time t.

| id | graph | T | → landing |
|----|-------|---|-----------|
| L1 | C is the first-parent commit F₂ | * | position 2, `at` = ct(F₂) |
| L2 | C reached only through F₂'s second parent | * | position 2 |
| L3 | C reachable from F₁ (t 100) and from F₂ (t 90) | * | position 1, `at` 100, never 90 |
| L4 | C not in H's graph | * | not landed |
| L5a | F₁ t 100, F₂ t 50 brings X through its second parent, F₃ t 200 | 40 | X not landed by T |
| L5b | same | 75 | X unknown at T: excluded, counted in coverage |
| L5c | same | 150 | X landed by T |
| L6 | F₁ t 1000, F₂ t 10 (old-dated), F₃ t 1100 brings X (ct 1050) through its second parent | 1200 | X landed at position 3 (no `--since` cut) |
| L7 | `commit_ref` is not hex, or a prefix matching two graph commits | * | unresolvable, excluded, counted in coverage |
| L8 | a 7-digit prefix matching exactly one graph commit; another matching none | * | that commit's landing; not landed |

**Table C: change landing.** Seam: `changeLandings` over read 2 with a real temporary repository.

| id | archive history | → landing |
|----|-----------------|-----------|
| C1 | added by a merge commit | at the merge's position |
| C2 | added by a direct first-parent commit | at that commit's position |
| C3 | added twice (re-archived under a new date) | at the first arrival |
| C4 | added on an unmerged branch only | not landed |
| C5 | added, later deleted from master | landed at the arrival (history is not rewritten) |
| C6 | archived by `git mv` from `changes/<name>/`, with `diff.renames=true` | landed at that position |

**Table K: inputs at an end.** Seam: `loadMetricsInputs` plus `computeMetrics(…, end)` over `metricsSeed.ts` rows and fixture facts, `now` fixed.

| id | records | → result |
|----|---------|----------|
| K1 | linked task created and done 30 days before both windows, no later event; its change lands in the window | counted in tasks per landed change and cycle time |
| K2 | change landed at `now − 1 d`, its task active at `now − 7 d` | in flight at the baseline's end, with its age |
| K3 | 12w trend, oldest point: window starts 84 d back, baseline 91 d back | token metrics partial at that point |
| K4 | limit tax at an end whose baseline precedes `now − 15 d` | partial |
| K5 | point before the team's first record | value null, `n` 0 (no data) |
| K6 | the task's status at T comes from a backfilled row | in-flight age approximate |
| K7 | linked task created after the landing | not counted (post-archive follow-up) |
| K8 | read at `end = now` | every pre-existing metric identical to the base read |

**Table R: rules.** Seam: `evaluateDegradation`. "cur/base" are the 7d window and its baseline. Every row not shown for a rule is covered by its table's input conditions, which are checked in the order listed.

*R-DD, `delivery-drop`:*

| id | facts | base changes | base integ | tokens | base tokens | changes cur/base | integ cur/base | tokens cur/base | → result |
|----|-------|--------------|------------|--------|-------------|------------------|----------------|-----------------|----------|
| DD1 | stale, behind, or unavailable | * | * | * | * | * | * | * | not-evaluable `facts` |
| DD2 | current | 9 | * | * | * | * | * | * | not-evaluable `floor` |
| DD3 | current | 10 | 0 | * | * | * | * | * | not-evaluable `no integration baseline` |
| DD4 | current | 10 | ≥ 1 | partial either side | * | * | * | * | not-evaluable `tokens incomplete` |
| DD5 | current | 40 | 146 | complete | 0 (no rows) | 6/40 | 59/146 | 0/0 | not-evaluable `no baseline usage` |
| DD6 | current | 10 | 10 | complete | > 0 | 6/10 | 7/10 | 0.8 | fires |
| DD7 | current | 10 | 10 | complete | > 0 | 7/10 | 7/10 | 1.0 | holds-not |
| DD8 | current | 10 | 10 | complete | > 0 | 6/10 | 8/10 | 1.0 | holds-not |
| DD9 | current | 10 | 10 | complete | > 0 | 6/10 | 7/10 | 0.79 | holds-not |
| DD10 | current | 10 | 10 | complete | > 0 | 6/10 | 7/10 | 0 (current rows complete, none) | holds-not |

*R-CR, `cost-per-change-rise` (cost = tokens per landed change):*

| id | facts | cur changes | base changes | tokens | base tokens | cost cur/base | `delivery-drop` | → result |
|----|-------|-------------|--------------|--------|-------------|---------------|-----------------|----------|
| CR1 | not current | * | * | * | * | * | * | not-evaluable `facts` |
| CR2 | current | 2 | ≥ 10 | * | * | * | * | not-evaluable `floor` |
| CR3 | current | ≥ 3 | 9 | * | * | * | * | not-evaluable `floor` |
| CR4 | current | ≥ 3 | ≥ 10 | partial | * | * | * | not-evaluable `tokens incomplete` |
| CR5 | current | ≥ 3 | ≥ 10 | complete | 0 | * | * | not-evaluable `no baseline usage` |
| CR6 | current | 3 | 10 | complete | > 0 | 2.0 | holds-not (integrations ratio > 0.7) | fires |
| CR7 | current | 3 | 10 | complete | > 0 | 2.0 | not-evaluable (base integrations 0) | fires |
| CR8 | current | 3 | 10 | complete | > 0 | 2.0 | fires | holds-not (subsumed) |
| CR9 | current | 3 | 10 | complete | > 0 | 1.99 | * | holds-not |

*R-CD, `convergence-drift`:* base tasks per landed change ≥ 1 by construction (a linked change has a task), so a zero denominator is unreachable.

| id | facts | linked cur / base | coverage cur / base | tasks cur/base | → result |
|----|-------|-------------------|---------------------|----------------|----------|
| CD1 | not current | * | * | * | not-evaluable `facts` |
| CD2 | current | 4 / ≥ 5 | * | * | not-evaluable `floor` |
| CD3 | current | ≥ 5 / 4 | * | * | not-evaluable `floor` |
| CD4 | current | ≥ 5 / ≥ 5 | 0.49 on either side | * | not-evaluable `coverage` |
| CD5 | current | 5 / 5 | 0.5 / 0.5 | 2.0 | fires |
| CD6 | current | 5 / 5 | 0.5 / 0.5 | 1.99 | holds-not |

*R-IA, `inflight-aging`:*

| id | facts | n cur / base | approximate | base p90 | cur p90 | → result |
|----|-------|--------------|-------------|----------|---------|----------|
| IA1 | not current | * | * | * | * | not-evaluable `facts` |
| IA2 | current | 2 / ≥ 3, or ≥ 3 / 2 | * | * | * | not-evaluable `floor` |
| IA3 | current | ≥ 3 / ≥ 3 | either side | * | * | not-evaluable `approximate` |
| IA4 | current | ≥ 3 / ≥ 3 | no | 0 | * | not-evaluable `no baseline age` |
| IA5 | current | 3 / 3 | no | 36 h | 72 h | fires |
| IA6 | current | 3 / 3 | no | 30 h | 71 h | holds-not |
| IA7 | current | 3 / 3 | no | 38 h | 72 h | holds-not (ratio < 2) |

**Table T: tool surface.** Every refusal uses the tool-error envelope that the existing unknown-window refusal uses (oracle hazard "refusals missing the success envelope").

| id | call | → result |
|----|------|----------|
| T1 | `team_metrics {window:'7d'}` | compact, < 32 KB on the seeded 300-task fixture, values equal to the tab's |
| T2 | `{window:'7d', metrics:['tasks_per_landed_change']}` | that metric carries ≤ 50 drill entries and `drillTotal`; the others are compact |
| T3 | `{window:'7d', metrics:['velocity']}` | refused, naming the known ids |
| T4 | `{window:'7d', slice:{kind:'group'}}` | slice rows present, no drill lists |
| T5 | `process_reports_list` | no `snapshot` key on any report |
| T6 | `process_report_get {full:true}` | snapshot byte-equal to the stored one |
| T7 | compact read of a metric that is partial, approximate, or unavailable | the flag and `unavailable` reason present |

**Table TR: trends surface.** Same envelope rule as Table T.

| id | request | → result |
|----|---------|----------|
| TR1 | range `4w` | 4 points, newest ending at the read |
| TR2 | range `6w` | refused, naming 4w, 8w, 12w, with the same error envelope as an unknown window |
| TR3 | unknown `teamPath` | `unknown-team`, no data |
| TR4 | point whose baseline starts 40 days back | `limit_tax_hours` partial at that point |
| TR5 | `process-metrics-open` with `end`, then a refresh | the window ending at `end` both times; values equal TR1's matching point |
| TR6 | `process-metrics-open` without `end` | unchanged from today |

**Table W: attention.** Seam: the production `WorkspaceRead.snapshot` with the runtime's `outcome`, fake clock.

| id | outcome | → queue |
|----|---------|---------|
| W1 | current, `delivery-drop` fires | one human item `process-degradation:delivery-drop` naming 6 vs 40 and both token totals |
| W2 | next evaluation `holds-not` | item gone, counts drop by one, one publish |
| W3 | same rule fires with new current values | one publish; same identity; the cause shows the new values |
| W4 | fires, then 24 h pass since the fetch with no other event | the scheduled evaluation publishes; no item |
| W5 | `not-evaluable` | no item |
| W6 | outcome of an older generation, or older than two intervals | no item |

**Table E: export.** Each row is a scrape through the production `registerMetricsRoute` against a fixture team. A spawn spy asserts that no scrape runs git.

| id | endpoint | state | → delivery series |
|----|----------|-------|-------------------|
| E1 | disabled | * | none, and no delivery timer armed without a subscriber |
| E2 | enabled | cold start, no generation yet, no browser or tool call | `delivery_facts_available` 0 only; the background pass starts at boot |
| E3 | enabled | current, all rules `holds-not` | every family; `degradation_rule_firing` 0 per rule; `delivery_rules_current` 1 |
| E4 | enabled | current, `delivery-drop` fires | its gauge 1, the others 0 |
| E5 | enabled | stale | families, `delivery_facts_stale` 1, every rule gauge 0, `delivery_rules_current` 0 |
| E6 | enabled | restart, then the first background generation is accepted, nothing landed | counters and histogram buckets equal before and after; between restart and acceptance, E2 |
| E7 | enabled | 90 landed changes | one histogram series per team alias; no change name in any label |
| E8 | enabled | every workspace subscription closed or disconnected, then the rule's inputs change | the background pass updates the gauge within one interval |
| E9 | enabled | outcome older than two intervals (timer stalled) | every rule gauge 0, `delivery_rules_current` 0 |

**Table N: noninterference.** Seam: the production manager composition with a fixture team. The same dispatch, routing, staffing, execution-tick, and acceptance inputs are run under four delivery states: unavailable, current and `delivery-drop` firing, stale, and current with different landings.

| id | check | → result |
|----|-------|----------|
| N1 | dispatcher pass, routing decision log, staffing preview, the execution fixture's tick effects, and Accept result outcomes under each state | identical across the four |
| N2 | mutant: the dispatcher receives `MetricsReader` through an injected dependency and skips a dispatch when `delivery.state` is stale | N1 fails |
| N3 | supplementary import guard: the outbound-isolation modules import nothing from `metrics/delivery/`, `degradationRules`, or `MetricsReader` | no offenders, file list non-empty |

**Table CAL: calibration cases.** Seam: `readTrends` over the D9 fixture at fixed `now = 2026-10-27T00:00:00Z`. The cases are declared before the thresholds are read.

| id | fixture week | → rules at that point |
|----|--------------|-----------------------|
| CAL1 | landings 6 vs 40, integrations 59 vs 146, tokens 7.1 B vs 4.0 B | `delivery-drop` only |
| CAL2 | landings 6 vs 40, tokens down 30% | none |
| CAL3 | landings 20 vs 20, integrations steady, cost 2.2× | `cost-per-change-rise` only |
| CAL4 | the week with no usage rows | no token rule fires (`not-evaluable`) |

**Properties.** All use a seeded `mulberry32`, defined in the test file the way the existing property tests define it (for example `checkRecords.test.ts`), and no new dependency.

- **P1, landing position equals brute force.**
  - Generator: random DAGs of 30–200 commits with 1–3 parents, a random first-parent chain, and committer times shuffled independently of position.
  - Seam: `landingPositions`.
  - Property: each commit's position is the smallest k whose ancestor closure of Fₖ contains it, its `at` is ct(Fₖ), and its `bound` is the maximum ct over F₁…Fₖ.
  - Seed 0xDE11, 500 cases.
- **P2, the compact form is a projection.**
  - Generator: random `MetricsInputs` built over the existing `metricsSeed.ts` helpers.
  - Property: for every metric, `compactMetrics(m)` keeps `value`, `n`, `baseline`, every flag, and `unavailable` equal to `m`'s.
  - Seed 0xC0DE, 300 cases.
- **P3, the rules are monotone in delivery.**
  - Holding the token and integration figures and the input conditions fixed, lowering the current changes landed never turns `delivery-drop` from `fires` to `holds-not`.
  - Seed 0xD0D0, 500 cases.
- **P4, a trend point is the read at its end.**
  - Generator: random `MetricsInputs` spanning 13 weeks with random fixture facts, one generation.
  - Property: for every k, point k of `readTrends` equals `computeMetrics` at `end_k` over a load made for that end with the same generation and the same `now`, projected compactly. Values, `n`, baselines, flags, and rule results all match.
  - Seed 0x7E4D, 100 cases.
- **P5, generations never mix heads.** This is Table G's model-based test (seed 0x6E4E).

**Production composition (M1).** One test builds the manager and `bootstrap`'s route registration as production does, with export enabled and no browser connection. It uses a temporary git repository (`cleanGitEnv`) whose origin carries 12 archives in the baseline week and 2 in the current week, plus token rows. It asserts that the background pass alone makes a scrape show E4, and that a workspace snapshot lists `process-degradation:delivery-drop`. There are three mutants: the source removed from `ATTENTION_SOURCES`; bootstrap not passing the runtime to the route; and `enableExport` not called. Each fails the test.

## Risks / Trade-offs

- **[Archives are lumpy: a change lands its code across many PRs and archives once]** → `delivery-drop` also requires integrations to fall, and its baseline floor is 10. Integrations are reported beside changes landed.
- **[Goodhart: changes get split to raise changes landed]** → tokens per landed change and the convergence metrics travel with it, its guard is reopen rate, and rules detect rather than target.
- **[Committer time is not arrival time]** → landings are ordered by first-parent position, the proxy's limits are stated, and backdated positions read unknown at the ends they cannot order.
- **[A team that never fetches is never alerted]** → the tab shows the stale marker with the fetch age, and rules are `not-evaluable` while stale. Kawai does not fetch: that is a write to the repository's refs, and agents fetch routinely.
- **[Whole-history reads grow with the repository]** → the byte bound and closure check make an oversized or truncated history unavailable, never partial. The cost on a real repository is Unknown until measured under D9.
- **[Linked-task coverage is partial]** → convergence carries its coverage metric, and `convergence-drift` requires coverage of at least 0.5 on both sides.
- **[Rule thresholds are judgement]** → they are constants in one table, validated on the declared fixture cases (Table CAL). Moving one is a reviewed code change, never configuration, and never tuned to make a named historical window fire.
- **[A 12-week trend repeats the computation 12 times]** → it runs over one load, is cached 5 minutes per (range, generation), and is never computed on a workspace push.
- **[Past trend points change after the fact: a late fetch, result, rewrite, or reopened task]** → this is intended and stated: a point is today's read for that end (P4), not what was known then. The view says "recomputed at <time> from <head>".
- **[The PromQL ratio drifts from the read-time ratio]** → it is documented as an observed-increase approximation (D7).
- **[Old report snapshots lack the delivery family and show lead time's new guard as absent]** → readers render absent, and the guard is read from definitions as today.

## Migration Plan

There is no schema migration and no stored state. Deploying adds the family, the rules, the compact tool forms, the Trends view, and the export families. The export families and the background refresh appear only where `KAWAI_METRICS_ENABLED` is already set. Rolling back is a revert: no data was written that older code would misread. Reports frozen after the change carry the delivery family in their snapshot JSON, and older readers ignore unknown metric ids.
