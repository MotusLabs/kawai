# Design

## Context

Inventory on master `f52963d0` (static read): the foundation records task,
assignment, result, finding, acceptance (with actor/mechanism and first
acceptance identity), mail, limit, usage, turn and interval facts
(`src/server/metrics/observations/`); lead time is measured to the first
`done`, not to acceptance (`docs/architecture/metrics.md`); report window
roles are a table in `src/shared/processReports.ts:20-30`, enforced at
submission and described in `reportTools.ts:38`, tested by `reportTools.test.ts` › `window roles: 1d carries no proposals, 3d only reverts, 7d both`);
proposals are human-decided with replay keys (`metricsConnections.ts`); there
is no digest scheduler, experiment store, stage partition, or 9.6 export
family. Revision-control holds/pauses/checkpoints exist in
`src/server/plans/revisionControl/`; plan stall episodes in plan
supervision; the runtime package settles Codex turns in
`packages/agent-runtime/src/codex/session.ts` (`facts.finalLimit`, audit N6).

## Goals / Non-Goals

**Goals:** every remaining requirement of the original groups 5–8, 9.6, 10.

**Non-Goals:** automatic routing/compaction/interruption; agent decision
tools; changing foundation facts retroactively; implementing revision apply,
capacity retry, or delivery metrics (consumed when present).

## Decisions

### D1 — Acceptance cohorts (5.1)

Primary duration: task creation → first recorded acceptance, with mechanism
(review, creator, system landing). Done without acceptance is `missing
acceptance`, never zero. Existing lead-time metric ids are unchanged; new ids
are added.

### D2 — Task-time partition (5.2, Table P)

Stage boundaries from canonical facts (assignment, handoff, result, review,
hold/pause, acceptance). Each instant of a task's elapsed time belongs to
exactly one primary cause by priority: hold/pause > waiting on dependency >
review queued > review running > fix running > execution running > unknown.
Concurrent causes are kept as detail. Accumulated agent time may exceed
elapsed time and is shown separately.

### D3 — Decisions and interventions (6.1, Table H)

Commands `process-advice-decide` and `process-intervention-link` (human only,
WebSocket, `teamPath`-addressed, replay key) refuse cross-team ids, stale
assessment versions, and a reused key with a different payload. Accepting
advice dispatches and edits nothing.

### D4 — Report windows (6.2, Table W) — proposed behavior change

After approval, change and revert proposals are allowed in every window.
Prior decisions and implementation links stay intact. Until then today's rule
holds and its test stays the oracle.

### D5 — Digest scheduler (7.x, Table D)

Per team: time zone (IANA) and local time (default 09:00 UTC), validated. A
minute tick writes at most one digest per team per local date in one
transaction with its checkpoint; restart catches up only the latest due
date; an unchanged assessment set yields a "no change" digest without new
recommendation copies; generation needs no lead session or Prometheus.

### D6 — Experiments (8.x)

Definitions carry human scope, guardrails, stopping criteria and explicit
membership links; create/stop/complete never starts, switches, compacts or
interrupts a chat. Outcomes are observational; n < 10 is undetermined.

### D7 — Export 9.6

Adds provider-account quota (from the quota change's history, one series per
account alias, not per team), canonical incident, and stage/wait families,
and the blocked-work, open-age and quota gauges, under the foundation's
registry budgets.

### D8 — Adapters (10.1, 10.2)

10.1 consumes revision-control hold/pause/checkpoint facts and plan landing
acceptance; revision-apply facts are reported as an absent capability until
`plan-revision-apply` lands. 10.2 maps Codex turns from the Kawai adapter
over the package's session finalization; when `codex-capacity-retry` lands,
attempts fold into one logical turn and the adapter counts logical turns (an
integration agreement checked by a fixture, not a prerequisite).

## Acceptance oracles

Rows run through production composition (manager, stores, tool table, the
WebSocket handler) with fake clocks.

**Table P — primary cause of an instant.**

| id | active facts at the instant | → primary cause |
|----|-----------------------------|-----------------|
| P-1 | hold or pause (any other) | hold |
| P-2 | dependency wait, review queued | dependency |
| P-3 | review queued, no reviewer running | review-queued |
| P-4 | two reviewers running | review-running (counted once) |
| P-5 | fix and execution both running | fix |
| P-6 | execution only | execution |
| P-7 | none known | unknown (not zero) |

**Table W — report proposals after D4.**

| id | window | kind | today | → after approval |
|----|--------|------|-------|------------------|
| W-1 | 1d | change | refused | accepted |
| W-2 | 3d | change | refused | accepted |
| W-3 | 3d | revert | accepted | accepted |
| W-4 | 7d | change/revert | accepted | accepted |

**Table H — human commands.**

| id | command | → result |
|----|---------|----------|
| H1 | accept advice, fresh assessment | recorded; nothing dispatched or edited |
| H2 | same key, same payload | replayed, no second record |
| H3 | same key, other payload | refused |
| H4 | stale assessment version | refused naming the current version |
| H5 | intervention link to another team's record | refused |
| H6 | revised action after acceptance | needs a fresh decision; superseded one visible |

**Table D — digests (time zone `Europe/Berlin` and `UTC`).**

| id | situation | → digests |
|----|-----------|-----------|
| D1 | scheduled time passes | one for that local date |
| D2 | DST fall-back repeats 02:00–03:00 with schedule 02:30 | one for that date |
| D3 | DST spring-forward skips 02:30 | one, at the next valid minute |
| D4 | server down for three due dates | one, for the latest due date |
| D5 | no evidence change | one "no change" digest, no new recommendation copies |
| D6 | schedule edited after a digest | earlier digests unchanged |
| D7 | invalid zone, time, or cadence | refused, nothing stored |

**Table X — experiments.**

| id | input | → result |
|----|-------|----------|
| X-1 | create with members of another team | refused |
| X-2 | create/stop/complete | no chat started, switched, compacted, or interrupted |
| X-3 | 7 accepted tasks per arm | comparison undetermined |
| X-4 | missing compaction post size | cannot establish a measured optimum |

**Properties.**
- **PP1, partition is exact.** Generator: random interval sets per task
  (overlaps, ties, gaps). Property: the primary-cause durations sum to the
  elapsed time with no overlap, and match Table P per instant. Seed `0x9A27`,
  200 cases.
- **PP2, one digest per local date.** Generator: every day of one year in
  three zones with random restarts. Property: exactly one digest per team and
  local date that has passed its schedule. Seed `0xD16E`, 365 cases × zones
  (`propertyCases`).
- **PP3, decisions are idempotent.** Generator: seeded command sequences with
  replays, reorderings and a crash at each transaction boundary. Property:
  stored decisions equal the model of Table H. Seed `0xDEC1`, 200 cases.

## Production composition checkpoints

1. 5.1/5.2 on the real metrics reader: one task through assignment, review,
   hold and acceptance shows the Table P partition in `team_metrics` and the
   tab.
2. 7.2 with the real scheduler and a fake clock: D1 and D4.
Each names a wiring mutant that must fail.

## Affected existing workflows

Metrics tab and `team_metrics` (existing ids unchanged), report submit/list/
link and proposal decisions (`reportTools.test.ts`, `reportLinks.test.ts`,
`reportConnections.test.ts`), plan supervision alerts, notification sounds,
mailbox delivery, background-task status, foundation export snapshot.

## Scope map (original `process-observability`)

| Original | Here |
|---|---|
| Tasks 5.1–5.4, 6.1–6.4, 7.1–7.3, 8.1–8.4, 9.6, 10.1–10.4 | same numbers (tasks.md) |
| process-observations: Stage and execution state are independent (2); Parallel execution does not inflate task elapsed time (2) | ADDED |
| team-process-metrics: Acceptance time (2), Stage measurements (1), Unfinished work (1) | ADDED; plus "Report snapshots keep their definition version" (clause from "Observation definitions are shared across surfaces") |
| process-recommendations: optimize acceptance time (1), decisions and interventions (2), outcomes (1), experiments (1), daily digest (2) | ADDED; plus "Workflow records outlive observation detail" (clause from "History has bounded retention") |
| process-recommendations: Recommendations share the existing Metrics and report surfaces | MODIFIED back to its full original text (its scenario first lands in the quota change) |
| process-reports: RENAMED window roles (3 scenarios); assessments (1); preserve decisions (1); digests (1) | RENAMED + MODIFIED + ADDED |
| prometheus-export: Export distinguishes … gauges; Prometheus integration is optional | MODIFIED back to full original text (foundation archives the narrowed form) |

## Implementation contract

### Acceptance
- A1: First-acceptance cohorts, the Table P partition, unfinished work, and bottleneck rules appear in `team_metrics` and the Metrics tab, with existing metric ids unchanged and checkpoint 1 passing.
- A2: Human decisions and intervention links follow Table H and property PP3; accepting advice dispatches and edits nothing.
- A3: Report proposals follow Table W only after this change is approved and task 6.2 lands; until then the existing window-role test passes unchanged.
- A4: Digests follow Table D and property PP2 and are shown beside agent reports as typed system digests.
- A5: Experiments follow Table X; the 9.6 families and gauges are exported within registry budgets; adapters 10.1 and 10.2 record actual landed facts and report absent capabilities.
### Invariants
- I1: No experiment, decision, or digest starts, switches, compacts, or interrupts a chat.
- I2: Foundation facts and stored report snapshots are never rewritten.
- I3: A shared provider account is exported once, not once per team.
### Scope
- `src/server/metrics/**`
- `src/server/plans/revisionControl/**`
- `src/server/chat/provider/**`
- `src/server/team/mailboxTools.ts`
- `src/server/team/teamPrompt.ts`
- `src/server/dbSafety/migrations.ts`
- `src/server/db.ts`
- `src/shared/processMetrics.ts`
- `src/shared/processReports.ts`
- `src/shared/processRecommendations.ts`
- `src/shared/metricsMessages.ts`
- `src/client/components/team/metrics/**`
- `src/client/stores/metricsStore.ts`
- `src/server/__tests__/**`
- `src/client/__tests__/**`
- `tests/e2e/**`
- `docs/**`
- `openspec/changes/process-workflow-observability/**`
### Verification
- V1: Tables P, W, H, D, X are committed verbatim as table-driven tests, at least one per seam through production composition with its wiring mutant failing.
- V2: Properties PP1–PP3 run through `propertyCases` at their seeds; PP2 sweeps a year of days in `Europe/Berlin`, `America/New_York`, and `UTC`.
- V3: Citation preflight, `bun run check --full-properties` on the clean committed head under pinned Bun 1.4.3, `scripts/verify-result.ts`, `openspec validate process-workflow-observability --strict`, and the walkthrough (10.3) as a fixture-gated private CI browser spec (never `bun run test:e2e`, never live data).
### Excluded
- X1: No implementation of `plan-revision-apply`, `codex-capacity-retry`, or `delivery-outcome-metrics`; their facts are consumed only when landed.
- X2: No automatic routing, compaction, or agent decision tool.
- X3: No change to the quota collector or incident evaluator beyond reading their records.
