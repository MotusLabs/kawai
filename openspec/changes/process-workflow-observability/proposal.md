# Proposal

## Status

PROPOSED (2026-11-18), planning only, for plan `plan-2eb5f292` (draft). The
third change partitioning `process-observability`; it owns that change's task
groups 5 (acceptance and bottleneck measurements), 6 (human choices,
interventions, report compatibility), 7 (daily reassessment and digests), 8
(human-scoped experiments), task 9.6 (remaining export families), and group 10
(cross-change adapters and the end-to-end walkthrough), with their original
numbers. Every original requirement and scenario of those groups is here
(design "Scope map"); none is deferred by size.

**Report window roles are preserved until approved.** The RENAMED/MODIFIED
`process-reports` requirement "Report windows do not delay proposals" is a
proposed behavior change. Until the owner approves this change and task 6.2
lands, `process_report_submit` keeps today's window roles (1d no proposals, 3d
reverts only, 7d both; `reportTools.ts` description and its tests).

## Why

The foundation records what happened and the quota change advises during
incidents, but the team still cannot see where accepted work spends its time,
record what the human decided about advice, get a daily digest without a
running lead, or compare a deliberate model/compaction change. These are the
original change's main purpose ("optimize acceptance time with guardrails").

## What Changes

- **Acceptance and stages (5.x):** first-acceptance cohorts with token and
  quality guards; canonical stage/wait boundaries and a non-overlapping
  task-time partition; unfinished age/count beside completion; bottleneck
  rules (queue investigation, not faster-model advice, for holds).
- **Decisions and interventions (6.x):** team-bound idempotent human
  accept/reject/defer and explicit intervention links; group/memory advice
  routed through existing process proposals; proposals allowed in every
  report window (the proposed rename); frozen assessment references and
  definition versions in reports; Metrics UI for decisions and history.
- **Daily digests (7.x):** per-team schedule/time zone, a minute scheduler
  writing one typed system digest per local date, shown beside agent reports.
- **Experiments (8.x):** human-scoped definitions, observational outcomes,
  compaction suggestions over loaded thresholds, UI.
- **Export 9.6:** provider-account quota, canonical incident, and stage/wait
  families, plus the blocked-work, open-age and quota gauges.
- **Adapters and walkthrough (10.x):** plan stage/wait/stall/hold/revision and
  landing facts, Codex observation mapping, an isolated end-to-end
  walkthrough, final checks.

## Capabilities

### New Capabilities

None (extends `process-recommendations` from
`process-quota-history-and-incident-advice` and `prometheus-export` from
`process-observability-foundation`).

### Modified Capabilities

- `process-observations`, `team-process-metrics`, `process-recommendations`,
  `process-reports`, `prometheus-export`.

## Impact

- Code (planned): `src/server/metrics/` (cohorts, stages, partition,
  bottlenecks, decisions, digests, experiments, export families),
  `reportTools.ts`/`reportService.ts`, migrations through
  `src/server/dbSafety/migrations.ts`, Metrics client, team prompt and docs.
- Depends on: `process-observability-foundation` and
  `process-quota-history-and-incident-advice` archived (their requirements are
  MODIFIED here); landed revision-control holds/pauses
  (`src/server/plans/revisionControl/`); the runtime package's Codex session
  (`packages/agent-runtime/src/codex/session.ts`). Integration agreements
  (not prerequisites): `codex-capacity-retry` (logical turns), the proposed
  `plan-revision-apply` (revision facts absent until it lands),
  `delivery-outcome-metrics` (held; also adds export families).
