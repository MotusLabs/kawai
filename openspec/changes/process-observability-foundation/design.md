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

`M` = mapped to an existing literal test (citation checked on `f52963d0`);
`C` = candidate, closeout test planned (task 1.2). Paths are under
`src/server/__tests__/`.

| Scenario | Status | Evidence (`file` › `title`) |
|---|---|---|
| process-observations › Observations cover managed work only › Task-less coordination | M | `processChatObservations.test.ts` › `turn identity is pinned, task-less peer mail clears it, missing usage stays unknown` |
| — › External terminal activity | C | new test: an external Codex log is parsed by `SessionManager` and no observation row is written |
| Observation ingestion is idempotent and non-blocking › Duplicate completion | M | `processMetricsExport.test.ts` › `lifetime histogram and token totals survive restart, transaction rollback, replay and detail pruning` |
| — › Recording fails | M | `processObservationReconcile.test.ts` › `post-commit acceptance and mailbox settlement survive recorder failure, recover once with identities` |
| Primary completion is recorded result acceptance › Integration acceptance | M | `processObservationReconcile.test.ts` › `landing acceptance requires the system actor and the exact landed result rather than any landing on the task` |
| — › Task reopened | M | `processObservationReconcile.test.ts` › `handoff and finding references survive replay, and reopen or repeated acceptance never recounts the first result` |
| Turn timing includes non-completing outcomes › Interrupted turn | C | new assertion: interrupted turn keeps known interval time and labels final usage unavailable (beside `chatTurnUsage.test.ts` › `the start is pinned at turn start; an interrupted turn writes nothing; an unpinned completion falls back`) |
| Context and compaction are structured observations › Boundary without post size | C | new assertion beside `processChatObservations.test.ts` › `repeated SDK compaction identities count once across callbacks and restart` |
| — › Approximate threshold | M | `processChatObservations.test.ts` › `context deltas coalesce but thresholds, turn end and compaction boundaries remain exact` |
| History has bounded retention and visible coverage › Interval detail ages out first | M | `processObservationStore.test.ts` › `interval detail prunes after 14 days while facts and usage keep 90 days` |
| — › Existing history | M | `processObservationReconcile.test.ts` › `75-day usage survives retention while older rows prune in bounded batches and coverage stays partial` |
| Source availability is explicit during staged delivery › Independent foundation | M | `processMetricsExport.test.ts` › `snapshot is cached for five seconds and unavailable adapters emit availability without fabricated samples` |
| prometheus-export › Prometheus integration is optional › No Prometheus | M | `processMetricsExport.test.ts` › `disabled or invalid configuration keeps core recording working; unauthorized scrapes never read storage` |
| — › Scraper unavailable | C | new test: no scrape for a period, recording continues and no outbound request is made |
| Export is a protected read-only scrape endpoint › Repeated scrape | C | new assertion: repeated authorized scrapes write no row and make no provider request |
| Export uses bounded labels and shared definitions › Many tasks | M | `processMetricsExport.test.ts` › `catalog churn and thousands of task/session identifiers cannot create unbounded labels` |
| — › Unknown quota | M | `processMetricsExport.test.ts` › `snapshot is cached for five seconds and unavailable adapters emit availability without fabricated samples` |
| Export distinguishes counters histograms and current gauges › Completion distribution | M | `processMetricsExport.test.ts` › `renderer escapes labels and produces HELP, TYPE, cumulative buckets, count and sum` |
| Cumulative exports survive restart and pruning › Crash and replay | M | `processMetricsExport.test.ts` › `lifetime histogram and token totals survive restart, transaction rollback, replay and detail pruning` |
| — › Retention cleanup | M | `processObservationStore.test.ts` › `detail pruning retains source identity, checkpoints, live state and cumulative totals` |
| Historical gaps remain explicit › Missed scrape interval | C | new test: totals after a simulated scrape gap equal uninterrupted totals |
| Supported metrics can be exported before dependent integrations › Quota adapter has not landed | M | `processMetricsExport.test.ts` › `snapshot is cached for five seconds and unavailable adapters emit availability without fabricated samples` |
| chat-turn-usage › Usage rows are retained for 90 days › A killed session's usage | C | new assertion: killing a session leaves its usage rows |
| — › Restart | M | `chatTurnUsage.test.ts` › `a turn is recorded once; rows past 90 days are pruned at startup` |
| — › Extended history | M | `processObservationReconcile.test.ts` › `75-day usage survives retention while older rows prune in bounded batches and coverage stays partial` |
| — › Older pruned history cannot be restored | M | `processObservationReconcile.test.ts` › `75-day usage survives retention while older rows prune in bounded batches and coverage stays partial` |
| team-process-metrics › Observation definitions are shared across surfaces › Different percentile methods | C | new `@reads: docs/operations/process-observability.md` test asserting the approximation statement |

19 mapped, 8 candidates; 27 scenarios. Each `M` row still gets a `@covers`
annotation and must show that removing the guarded behavior fails it
(task 1.1 records one negative control per test file).

## Clause map (narrowed requirements)

| Original clause | Here | Moved to |
|---|---|---|
| History: "Recommendation evidence, decisions, interventions, digests … survive pruning" + "Detail pruned" | export totals and source identities survive | evidence: `process-quota-history-and-incident-advice` "Recommendation evidence outlives observation detail"; decisions/interventions/digests: `process-workflow-observability` "Workflow records outlive observation detail" |
| Export gauges: "blocked-work, open-age, quota" | queue and collection-health gauges | `process-workflow-observability` MODIFIED (task 9.6) |
| Prometheus optional: "recommendations … daily digests" | chats, tasks, collection, reports | `process-workflow-observability` MODIFIED |
| Definitions shared: "reports, recommendation evidence"; snapshot definition versions | Metrics view, tools, export | `process-workflow-observability` "Report snapshots keep their definition version" |

## Implementation contract

### Acceptance
- A1: Every scenario in "Closeout map" has a `@covers` annotation directly above a test whose literal title resolves; the 8 candidate rows gain tests that pass against unchanged production code.
- A2: Each mapped test file records one negative control (the guarded behavior removed or the base checked) whose failing assertion is named in the result.
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
