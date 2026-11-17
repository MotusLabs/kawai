# Design

## Context

`process-observability` delivered its foundation on 2026-10-18 (its
`implementation-notes.md` "Foundation delivery"): migrations 11 and 14, the
protected recorder and post-commit reconciliation
(`src/server/metrics/observations/recorder.ts`, `reconcile.ts`, `store.ts`),
managed turn/interval/context tracking (`chatTracker.ts`), 90-day facts and
usage with 14-day interval detail (`store.ts`, `src/server/chat/chatTurnUsageStore.ts`),
and the optional bearer-protected `GET /metrics`
(`src/server/metrics/export/route.ts`, `registry.ts`, `renderer.ts`,
`snapshot.ts`, `accumulator.ts`, `boundedLabels.ts`) behind
`KAWAI_METRICS_ENABLED`/`KAWAI_METRICS_TOKEN`. Operator documentation is
`docs/operations/process-observability.md`; recovery rows are in
`docs/recovery-matrix.md`. Later changes (`compact-observation-detail`, the
tool-metrics work in #405) built on it.

## Goals / Non-Goals

**Goals:** move exactly the landed, tested foundation behavior into the main
specs, each scenario tied to a literal test title.

**Non-Goals:** any production change; background quota observation (F4,
owned by `process-quota-history-and-incident-advice`); recommendations,
stage metrics, digests, experiments, or the 9.6 export families (owned by
`process-workflow-observability`).

## Decisions

### D1 — Narrow, never weaken

Where an original requirement mixes landed and unbuilt clauses, the landed
clauses are archived here and the rest move whole to the owning remainder,
which carries them as its own ADDED or MODIFIED requirement (design
"Clause map"). No main-spec scenario is removed or weakened; the main
`chat-usage-limits` background scenarios stay as they are.

### D2 — Closeout tests are evidence, not new behavior

A "candidate" scenario below has code but no test asserting its exact
outcome. The closeout adds that test against unchanged production code. If
it fails on the base, the scenario is not landed: the writer raises a
contract question, and the scenario moves to the owning remainder instead of
being fixed here.

### D3 — Archive order

`openrouter-provider` archives first, then this change, then the two
remainders (they MODIFY `prometheus-export` and `process-recommendations`
requirements that only exist after this archive and the quota change's).

## Closeout map

`M` = an existing literal test whose assertions observe the scenario's THEN
outcome, so the test fails when that outcome is absent (citation checked on
`f52963d0`; the asserted outcome is named). A name match or a neighbouring
assertion is not coverage. `C` = candidate: no current test asserts the
outcome; task 1.2 adds the named assertion through the production
composition shown, against unchanged production code. Paths are under
`src/server/__tests__/`.

| Scenario | Status | Evidence (`file` › `title`: asserted outcome) or planned test |
|---|---|---|
| process-observations › Observations cover managed work only › Task-less coordination | C | extend `processChatObservations.test.ts` (harness over `ProcessObservationService.chat`): a task-less lead turn's `turn_ended`/`tool` rows carry the team and chat session and `taskId: null`, and a task's measured execution read through `loadMetricsInputs` is unchanged by them. Today's test asserts only `taskId: null`. |
| — › External terminal activity | C | new test: an external Codex log parsed by `SessionManager` writes no `process_observations` row |
| Observation ingestion is idempotent and non-blocking › Duplicate completion | C | new test through `ProcessObservationService.chat`: the same `turn_completed` delivered twice yields one `turn_ended` row, one usage reference, and `agent_turn_duration_seconds` count 1 with an unchanged sum. The cited lifetime test replays only `kind='usage'`. |
| — › Recording fails | C | extend `processObservationReconcile.test.ts` › `post-commit acceptance and mailbox settlement survive recorder failure, recover once with identities` (it asserts acceptance proceeds and later recovery): while the recorder fails, no acceptance row with a zero or fabricated duration exists and `loadMetricsInputs` reports the missing measurement as a coverage gap |
| Primary completion is recorded result acceptance › Integration acceptance | C | new test beside `processObservationReconcile.test.ts` › `landing acceptance requires the system actor and the exact landed result rather than any landing on the task`, which seeds only `mechanism='direct'`: a `plan_change_landings` row with `mechanism='integration-branch'` accepted by the system actor ends the timer at that acceptance with mechanism `integration-landing` (`src/server/metrics/observations/reconcile.ts:56`) and no promotion or default-branch field. |
| — › Task reopened | C | extend `processObservationReconcile.test.ts` › `handoff and finding references survive replay, and reopen or repeated acceptance never recounts the first result` (it asserts one first acceptance and histogram count 1): after reopen, a second result's acceptance is recorded as a non-first acceptance with the first duration unchanged |
| Turn timing includes non-completing outcomes › Interrupted turn | C | new assertion beside `processChatObservations.test.ts` › `turn identity is pinned, task-less peer mail clears it, missing usage stays unknown` (it asserts `outcome: 'interrupted'`, `usageAvailable: false`): the interrupted turn after a tool call keeps a positive `durationSeconds` |
| Context and compaction are structured observations › Boundary without post size | M | `processChatObservations.test.ts` › `context deltas coalesce but thresholds, turn end and compaction boundaries remain exact`: a compaction with `postTokens: null` is stored as a `compaction` row with `postTokens: null`, not zero |
| — › Approximate threshold | M | same test: every `context` row from a window-only threshold has `approximate: true` |
| History has bounded retention and visible coverage › Interval detail ages out first | M | `processObservationStore.test.ts` › `interval detail prunes after 14 days while facts and usage keep 90 days`: after 15 days the `tool` row is pruned, `acceptance` remains, and `detail-retained-since` is now−14 d |
| — › Existing history | C | new test through `loadMetricsInputs`: a task with an accepted result and no interval rows reports its known facts and a stated missing stage/usage coverage, with no synthesized interval. The previously cited 75-day usage test is about usage retention. |
| Source availability is explicit during staged delivery › Independent foundation | M | `processMetricsExport.test.ts` › `snapshot is cached for five seconds and unavailable adapters emit availability without fabricated samples`: core token totals render while `provider-quota`, `canonical-stage` and `canonical-incident` report `source_available 0` and their families are absent |
| prometheus-export › Prometheus integration is optional › No Prometheus | C | extend `processMetricsExport.test.ts` › `disabled or invalid configuration keeps core recording working; unauthorized scrapes never read storage` (it asserts 404 for disabled configs but not the recording): with export unconfigured, the observation recorded while disabled exists in `process_observations` and a report read succeeds |
| — › Scraper unavailable | C | new test: no scrape for a period, recording continues and no outbound request is made |
| Export is a protected read-only scrape endpoint › Repeated scrape | C | new assertion: repeated authorized scrapes write no row and make no provider request |
| Export uses bounded labels and shared definitions › Many tasks | M | `processMetricsExport.test.ts` › `catalog churn and thousands of task/session identifiers cannot create unbounded labels`: 2,000 task/session turns produce one `agent_turn_duration_seconds` count series and no task or session label |
| — › Unknown quota | M | `processMetricsExport.test.ts` › `snapshot is cached for five seconds and unavailable adapters emit availability without fabricated samples`: `provider-quota` availability is 0 and no `provider_quota_used_ratio` gauge is rendered |
| Export distinguishes counters histograms and current gauges › Completion distribution | C | new test from a first acceptance through `ProcessObservationService` reconcile to `MetricsSnapshot`: `task_acceptance_duration_seconds` count 1, sum equal to creation→acceptance seconds, the matching bucket incremented, unchanged after a replay. The renderer test only checks HELP/TYPE/escaping. |
| Cumulative exports survive restart and pruning › Crash and replay | M | `processMetricsExport.test.ts` › `lifetime histogram and token totals survive restart, transaction rollback, replay and detail pruning`: a rolled-back accumulation leaves no totals, the replayed observation counts once (`input 42`, bucket 1), and a replay after restart returns `null` |
| — › Retention cleanup | M | `processObservationStore.test.ts` › `detail pruning retains source identity, checkpoints, live state and cumulative totals`: after a 91-day prune the `process_export_totals` count bucket keeps value 1 |
| Historical gaps remain explicit › Missed scrape interval | C | new test: totals after a simulated scrape gap equal uninterrupted totals |
| Supported metrics can be exported before dependent integrations › Quota adapter has not landed | M | `processMetricsExport.test.ts` › `snapshot is cached for five seconds and unavailable adapters emit availability without fabricated samples`: the snapshot the route serves carries core totals, `provider-quota` availability 0, and no quota gauge |
| chat-turn-usage › Usage rows are retained for 90 days › A killed session's usage | C | new assertion: killing a session leaves its usage rows |
| — › Restart | M | `chatTurnUsage.test.ts` › `a turn is recorded once; rows past 90 days are pruned at startup`: the earlier row `t-1` is still present after a fresh `ChatTurnUsageStore` startup |
| — › Extended history | M | `processObservationReconcile.test.ts` › `75-day usage survives retention while older rows prune in bounded batches and coverage stays partial`: the 75-day row survives and `loadMetricsInputs` usage horizon reaches it |
| — › Older pruned history cannot be restored | M | same test: pruned 91-day rows stay gone and the usage horizon stays later than now−90 d |
| team-process-metrics › Observation definitions are shared across surfaces › Different percentile methods | C | new `@reads: docs/operations/process-observability.md` test asserting the approximation statement |

12 mapped, 15 candidates; 27 scenarios. Each `M` row gets a `@covers`
annotation and a negative control that removes the named asserted outcome
and fails that assertion. Each `C` row's test is named for its scenario.

## Clause map (narrowed requirements)

| Original clause | Here | Moved to |
|---|---|---|
| History: "Recommendation evidence, decisions, interventions, digests … survive pruning" + "Detail pruned" | export totals and source identities survive | evidence: `process-quota-history-and-incident-advice` "Recommendation evidence outlives observation detail"; decisions/interventions/digests: `process-workflow-observability` "Workflow records outlive observation detail" |
| Export gauges: "blocked-work, open-age, quota" | queue and collection-health gauges | `process-workflow-observability` MODIFIED (task 9.6) |
| Prometheus optional: "recommendations … daily digests" | chats, tasks, collection, reports | `process-workflow-observability` MODIFIED |
| Definitions shared: "reports, recommendation evidence"; snapshot definition versions | Metrics view, tools, export | `process-workflow-observability` "Report snapshots keep their definition version" |

## Implementation contract

### Acceptance
- A1: Every scenario in "Closeout map" has a `@covers` annotation directly above a test whose literal title resolves; the 15 candidate rows gain tests asserting their named outcomes that pass against unchanged production code.
- A2: Each `M` row records one negative control that removes its named asserted outcome and fails that assertion, named in the result.
- A3: After `openrouter-provider` archives, this change syncs and archives with no main-spec scenario removed or weakened.
### Invariants
- I1: No production source changes; only tests, `@covers` annotations, docs under `docs/operations/`, and this change's artifacts.
- I2: No requirement or scenario that depends on background quota observation, recommendations, stage metrics, digests, or experiments is archived by this change.
### Scope
- `src/server/__tests__/**`
- `docs/operations/process-observability.md`
- `openspec/changes/process-observability-foundation/**`
### Verification
- V1: Citation preflight with zero unresolved literal titles; `scripts/__tests__/specCoverageGuard.test.ts` passes.
- V2: `bun run check --full-properties` on the clean committed head under pinned Bun 1.4.3 and `scripts/verify-result.ts`.
- V3: `openspec validate process-observability-foundation --strict` passes.
### Excluded
- X1: No background quota collector (F4); see `process-quota-history-and-incident-advice`.
- X2: No recommendation, stage, digest, experiment, or 9.6 export family work; see `process-workflow-observability`.
- X3: No tick or archive of `process-observability`.
