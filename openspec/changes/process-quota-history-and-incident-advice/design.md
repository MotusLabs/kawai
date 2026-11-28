# Design

## Context

Inventory on master `f52963d0` (static read):

| Path | Today |
|---|---|
| `src/server/chat/ChatSessionManager.ts:454-458` | per-provider usage profiles, timers, and cadence (`providerUsageRefreshMs`) |
| `src/server/chat/ChatSessionManager.ts:3013-3014,3225-3270` | a spawn claims the provider pull (`claimProviderUsagePull`); quota-endpoint and OpenRouter own-endpoint pulls run for started sessions only |
| `src/server/chat/ChatSessionManager.ts:3389-3395` (audit G2) | the cadence refresh stops when no live session remains |
| `src/server/chat/usageLimits.ts`, `zaiUsage.ts`, `openRouterUsage.ts` | `UsageLimitStore` (latest report per provider, empty after restart) and strict parsers |
| `src/server/team/capacityTools.ts` | read-only `team_capacity` over routing state |
| `src/server/team/routing/router.ts` | routing cooldown and worker choice |
| `src/server/metrics/observations/` | foundation store, recorder, reconcile, retention (90 d facts, 14 d detail) |
| `src/server/chat/contextExhaustedMigration.ts`, `src/server/db.ts` | the context-exhausted session flag |
| `src/server/plans/decisions/`, plan supervision | stall episodes and attention links |

No standalone background collector, quota history table, recommendation
store, or recommendation tool exists in `src` or `packages`.

## Goals / Non-Goals

**Goals:** implement main's background quota observation; durable quota
history with honest freshness; incident alternatives frozen at the cutoff;
first deterministic incident advice visible to the human and readable by
agents.

**Non-Goals:** automatic routing, switching, compaction or interruption;
agent approve/apply tools; stage/acceptance metrics, decisions and
interventions, digests, experiments, the 9.6 export families
(`process-workflow-observability`); an OpenRouter background reader; any
change to `team_capacity`'s read-only contract.

## Decisions

### D1 — One reader service, two subscription kinds (original D5)

Extract quota polling from `ChatSessionManager.ts` into
`src/server/chat/quota/QuotaReaderService.ts`. Subscriptions: a started
non-archived session (as today), and a configured team worker (a registered
team's group files list the profile, resolved under the provider catalog and
the team's project context). Both are reference-counted per effective account
configuration key `(provider, origin, credential identity hash in memory)`; a
timer exists while the count is positive. The manager keeps publishing pulled
reports to `UsageLimitStore` exactly as now, so session behavior is unchanged
(regression rows in Table S).

### D2 — Scheduler (Table S)

Ten-minute cadence, poll once at startup and on configuration change for
standalone readers, one request in flight per key, ten-second timeout, jitter
of ±10% of the cadence, backoff 1, 2, 4, … up to 30 minutes after consecutive
failures, reset on success. Shutdown cancels timers and discards in-flight
results. Agent-only readers (host-login SDK pulls) are observed only while a
session runs; with only a worker reason they record `unsupported` once per
configuration and never launch anything.

### D3 — Quota observations and staleness (Table F)

Each observation stores provider, account alias, window, percent, reset,
observation time and its basis (provider time or receipt time), outcome, and
the subscription reason. A status-only push updates status provenance, not
window age. Headroom evidence is valid only if fresh (≤ 10 min), its reset has
not passed, no later failure or limit for the same key exists, and it
describes the routed provider's account, not an unrelated host login.

### D4 — Frozen alternatives (Table E)

At an incident cutoff (a final limit event or a context-exhausted flag), the
evaluator snapshots the candidate workers of the affected group with the
routing predicates as they stood: cooldown (`cooldownFor`), hard selectors,
review restrictions, caps, writer occupancy, and Table F evidence available at
or before the cutoff. Later observations create a new assessment; they never
rewrite the frozen one.

### D5 — Advice records

Migrations add `process_recommendations` (stable identity per episode and
kind), `process_assessments` (immutable, versioned by evaluator version and
evidence hash), and frozen evidence summaries. A material-change check (same
evidence hash) suppresses duplicates. Evaluation runs off a coalescing queue
after incident commits and quota/reset updates, targeting publication within
five seconds; evaluator failure records a health gap and leaves work running.
At startup, episodes with no assessment for the current evaluator version are
enqueued once (recovery-matrix row). A quota episode is a team's chain of final
limits of one provider, oldest first: an event joins while the episode's own
cooldown (the latest reset of its members, else one hour after the event) is
still ahead of it, and otherwise opens a new episode; events at one instant
keep their commit order. The episode's first `resolved` version closes it, and
that version's append transaction also writes the closure witness
(`process_episode_members`). The witness is the opaque ids of the limit events
the episode held at that instant, read in the transaction before the version
is written, in episode order. The version and its witness commit together or
not at all. A limit committed before the closing drain at the same millisecond
is a member. One committed after it is not yet a row, so it opens its own
episode. Both orders are kept without comparing timestamps. Witnessed events
are grouped into their closed episode first, and only the rest chain, so each
final limit belongs to one episode only. A closed episode admits nothing, and
startup skips it before reading any cooldown: another team's later limit may
keep the profile cooling, but it never reopens the episode or promotes a
consumed member. A pruned anchor (15-day limit retention) is stood in for by
what its recommendation froze: its id, cutoff, profile, window and reset. Its
surviving members therefore keep their episode, live and in the witness. A
resolution recorded without a witness (a database written before witnesses)
closes its episode at its `created_at`. Its order is unknown, so an event at
that instant counts as after it, and such an episode keyed by a pruned anchor
cannot hold its survivors. Prior versions are never rewritten. The episode is
in force at a time while some member's own end is ahead of it and that
member's profile cooldown, as the router saw it at that time, still runs
(members can hold different model-scoped windows, so neither the first nor the
newest member decides); after its recorded resolution it is never in force.
"As the router saw it" is `LimitEventStore.cooldownAt` (I5): read-only, the
router's rule over the events recorded by that time, with a credit event
ending early only on the readings taken by then and only when this process
recorded it, so every assessment, first or later, reads the cooldown at its
own cutoff. The live join, the episode's open state, its members and startup
reconstruction (only the newest episode, when open and in force) all use this
partition.

### D6 — Surfaces

Advice attaches to the existing context-exhaustion episode and plan-stall
attention links (no second alert), plus a deduplicated standalone quota entry.
Read-only `process_recommendations_list {limit?}` and
`process_recommendation_get {id}` are team-bound; no agent tool approves or
applies. The Metrics view gains a list/detail with alternatives, freshness,
constraints and uncertainty, working without Prometheus.

## Acceptance oracles

All rows run through the production `QuotaReaderService` wired by the
manager, with an injected fetch and fake clock (no network); advice rows run
through the production queue and stores. Blind second reading required
before code (state machine with recovery): task 0.1.

**Table S — scheduler per account key.** Reasons: `none`, `session`,
`worker`, `both`. Reader: `standalone`, `agent-only`.

| id | reasons | reader | in flight | event | → requests / state |
|----|---------|--------|-----------|-------|---------------------|
| S1 | none→worker | standalone | no | subscribe | one request now; timer armed |
| S2 | worker | standalone | no | tick | one request; next at cadence ± jitter |
| S3 | worker | standalone | yes | tick | no new request |
| S4 | worker | standalone | yes | timeout (10 s) | request abandoned; failure counted; backoff |
| S5 | worker | standalone | no | 3rd consecutive failure | next delay 4 min (bounded at 30) |
| S6 | worker | standalone | no | success after failures | backoff reset; windows replaced only if newer |
| S7 | worker→none | standalone | * | unsubscribe | timer removed; no further request |
| S8 | both→session | standalone | * | worker removed | cadence continues (session reason) |
| S9 | worker | agent-only | no | subscribe | no request; one `unsupported` observation; no agent launched |
| S10 | session | agent-only | * | spawn pull | today's spawn pull unchanged |
| S11 | * | * | yes | shutdown | timer cancelled; in-flight result discarded, nothing published |
| S12 | worker | standalone | no | restart | `UsageLimitStore` empty; one startup poll; history rows intact |
| S13 | worker (two teams, one key) | standalone | no | tick | one request; both teams' histories get it |
| S14 | worker | standalone | * | config change of credential | old key unsubscribed, new key polled once |

Completeness (decision-ed5e5e77): reasons × reader × in-flight × event is
4 × 2 × 2 × 11 = 176 combinations, every one in exactly one class of
`quotaReaderTableSCompleteness.test.ts`: a row above, a bound rule (B1–B6,
the B3 drain, P1) through a stated equivalence, or unreachable with its
reason; each reachable class names its tests. Axes are pre-event, except
that for the two settlement events the in-flight axis is the settled state
(as S5/S6 record it); a settlement with another request current is a late
answer to an abandoned attempt and is dropped (S4, P1). `unsubscribe` and
`worker removed` both remove the key's worker reason; the pre-event reasons
tell S7 from S8. A repeated subscribe on an armed key adds the team (S13);
a subscribe during the B3 drain joins its request. B3 drains and B4 shutdown
hold with no new request; B6 serves a worker only from a same-key session.
Agent-only keys keep S9/S10 and record lifecycle changes. Unreachable: an
agent-only request in flight, a tick or settlement of one, a timeout with
nothing in flight, removing an absent worker reason, a restart with a
request in flight (100 reachable, 76 unreachable).

**Table F — headroom evidence.** Output: may the value establish routed
headroom?

| id | age | reset passed | later failure/limit | account | → evidence |
|----|-----|--------------|---------------------|---------|------------|
| F1 | ≤ 10 min | no | no | routed provider | yes |
| F2 | > 10 min | * | * | * | no (stale) |
| F3 | * | yes | * | * | no |
| F4 | * | * | yes | * | no |
| F5 | * | * | * | unrelated host login | no |
| F6 | status-only push, windows 20 min old | no | no | routed | no (window age kept) |

**Table E — frozen alternatives at a cutoff.**

| id | candidate state at cutoff | → alternative |
|----|---------------------------|---------------|
| E1 | eligible worker, F1 evidence, not cooling | listed with its evidence |
| E2 | same account as the limited provider (shared window) | excluded: shared window |
| E3 | cooling per `cooldownFor` | excluded: cooling |
| E4 | hard selector or review restriction forbids | excluded naming it |
| E5 | cap reached or writer slot occupied (writer required) | excluded naming it |
| E6 | eligible, evidence F2–F5 | listed with unknown headroom; no numeric saving |
| E7 | evidence arrives after the cutoff | not in this assessment; a new assessment cites it |
| E8 | context exhaustion incident | never treated as account exhaustion |

**Table R — advice records.**

| id | input | → result |
|----|-------|----------|
| R1 | first quota incident, no baseline | provisional advice with sample flag, unknown savings |
| R2 | same evidence re-evaluated | no new assessment (material-change check) |
| R3 | new quota observation after the cutoff | new assessment version; old one unchanged |
| R4 | evaluator throws | health gap recorded; managed work continues |
| R5 | crash after incident commit, before evaluation | startup enqueues it once; one assessment |
| R6 | restart during a plan stall | advice attached to the existing stall episode; no duplicate alert |
| R7 | `process_recommendation_get` of another team's id | refused as unknown |
| R8 | agent tool list | no approve/apply/decide tool exists |
| R9 | observation behind an assessment pruned | evidence summary readable; link states expired |

**Properties.**
- **P1, one request per key.** Generator: seeded sequences of subscribe,
  unsubscribe, tick, response, timeout, config change, restart, shutdown over
  1–4 teams and 1–3 account keys. Seams: the production service with an
  injected fetch and fake clock. Property: at no instant are two requests in
  flight for one key; after the last unsubscribe no request starts; after
  shutdown nothing is published. Seed `0x51A7`, 200 cases (`propertyCases`).
- **P2, no stale headroom.** Generator: random observation histories and
  cutoffs. Property: every listed alternative's headroom satisfies Table F
  row F1 at the cutoff. Seed `0xF4E5`, 200 cases.
- **P3, assessments are append-only.** Generator: seeded incident/observation
  sequences with replays and a crash at each transaction boundary. Property:
  stored assessments are never updated; the latest per recommendation equals
  a fresh evaluation of the final evidence. Seed `0xA55E`, 200 cases.
- **P4, credential hygiene.** For every row of Tables S and F, no stored row
  or log line contains the fake credential or the response body (fake tokens
  built at runtime).

## Production composition checkpoint

First path: the manager-built `QuotaReaderService` with one configured team
worker on a quota-serving provider and no session, an injected fetch, and a
fake clock — S1, S2 and the main scenario "Eligible alternative without a live
chat" observable in quota history — plus S11 at shutdown. A mutant that leaves
the worker subscription unwired must fail it. Advice work starts after it.

## Affected existing workflows

Every `chatSessionManager.provider-usage-*.test.ts`, OpenRouter pulls, the
usage bar, `team_capacity`, routing cooldown, the context-exhausted flow, plan
supervision alerts, foundation retention, and the export snapshot. Their
existing tests stay green.

## Dependencies and risks

- **F4 ownership:** task 3.2 is the first slice; the foundation does not claim
  it, and `openrouter-provider` archives its restatement of main without
  claiming it.
- **Runtime finalizer:** context incidents come from Kawai's
  context-exhausted flag set from the package's turn finalization; this change
  consumes the flag, not package internals.
- **Account identity:** host-login identity may be unknown; Table F row F5
  keeps it from granting headroom.
- **Polling cost:** bounded by D2 and reference counting.

## Implementation contract

### Acceptance
- A1: A configured team worker on a quota-serving provider with no live session is polled through a standalone reader, and main scenarios "Eligible alternative without a live chat", "Background provider configuration", "Unused alternative stays observable", and "No standalone reader" pass through the production service.
- A2: Table S rows S1–S14 and property P1 pass; the existing provider-usage session tests are unchanged and green.
- A3: Quota observations follow Table F rows F1–F6 and property P2.
- A4: Incident alternatives follow Table E rows E1–E8, and advice records follow Table R rows R1–R9 and property P3.
- A5: `process_recommendations_list` and `process_recommendation_get` are registered read-only, team-bound tools, and the Metrics view shows the list and detail for a fixture quota incident without Prometheus.
### Invariants
- I1: No background observation starts an agent, makes a model request, or changes a login.
- I2: No credential, response body, or credential-bearing error is persisted or logged (property P4).
- I3: A stored assessment is never rewritten; later evidence creates a new version.
- I4: `team_capacity` stays read-only and fetch-free.
### Scope
- `src/server/chat/quota/**`
- `src/server/chat/ChatSessionManager.ts`
- `src/server/chat/usageLimits.ts`
- `src/server/metrics/observations/**`
- `src/server/metrics/recommendations/**`
- `src/server/metrics/metricsConnections.ts`
- `src/server/metrics/export/**`
- `src/server/team/mailboxTools.ts`
- `src/server/team/teamPrompt.ts`
- `src/server/db.ts`
- `src/server/dbSafety/migrations.ts`
- `src/shared/processRecommendations.ts`
- `src/shared/metricsMessages.ts`
- `src/client/components/team/metrics/**`
- `src/client/stores/metricsStore.ts`
- `src/server/__tests__/**`
- `src/client/__tests__/**`
- `docs/recovery-matrix.md`
- `docs/operations/process-observability.md`
- `docs/architecture/metrics.md`
- `openspec/changes/process-quota-history-and-incident-advice/**`
### Verification
- V1: Tables S, F, E, R are committed verbatim as table-driven tests, with Table S's completeness test expanding the axes over rows and unreachable claims, and at least one row per seam through the production composition with its wiring mutant shown failing.
- V2: Properties P1–P3 run through `propertyCases` at their declared seeds and 200 cases; P4 runs over every Table S and F row.
- V3: The blind second reading of Tables S and F is committed (inputs-only commit, other-family outputs, resolved diff) before production code.
- V4: Citation preflight, `bun run check --full-properties` on the clean committed head under pinned Bun 1.4.3, `scripts/verify-result.ts`, `openspec validate process-quota-history-and-incident-advice --strict`, and the private CI fixture browser step for the Metrics list (never `bun run test:e2e`).
- V5: `docs/recovery-matrix.md` gains rows for the scheduler startup and the evaluation-queue reconciliation, and `recoveryMatrix.test.ts` passes.
### Excluded
- X1: No stage, acceptance, decision, intervention, digest, experiment, or 9.6 export family work.
- X2: No OpenRouter background reader and no change to its pull cadence.
- X3: No automatic routing, switching, compaction, or agent approval tool.
- X4: No live provider calls from tests; injected fetch only.
