# Proposal

## Status

PROPOSED (2026-11-18), planning only, for plan `plan-2eb5f292` (draft). One
of three changes that partition `process-observability`; it owns that
change's task groups 3 (provider quota history and eligible alternatives) and
4 (first useful incident recommendations), with the original task numbers.

**F4 decision (proposed): collector first.** The main `chat-usage-limits`
spec already commits to background quota observation — "Eligible alternative
without a live chat", "Background provider configuration", "Unused
alternative stays observable", "No standalone reader"
(`openspec/specs/chat-usage-limits/spec.md`) — but master pulls quota only
through a started session's spawn (`ChatSessionManager.ts:3013-3014`,
`claimProviderUsagePull` at `:3225`) and stops the cadence without one. This
change implements that main text first (task 3.2) instead of weakening it. No
main scenario is deleted or rewritten.

## Why

When a provider hits a quota or a session exhausts its context, the lead must
choose between waiting and switching, but Kawai has no history of other
providers' headroom and no advice. The configured alternatives are polled
only while someone happens to chat on them, so the evidence for "switch now"
is usually missing exactly when it is needed.

## What Changes

- **Collector (3.2–3.4):** a shared quota reader service extracted from
  `ChatSessionManager.ts`, with live-session and configured-team-worker
  subscriptions, reference-counted per effective account configuration;
  bounded scheduling (one in flight, timeout, jitter, backoff, cleanup);
  durable quota observations with their own observation time and outcome
  (supported, unavailable, auth-refused, failed, unsupported). It reuses the
  existing quota parsers and launch credential resolution, and never starts
  an agent or makes a model request.
- **Frozen alternatives (3.5):** incident alternatives evaluated with the
  routing/staffing predicates and only the evidence available at the incident
  cutoff.
- **Incident advice (4.1–4.6):** stores for recommendations, immutable
  assessments and frozen evidence; a versioned quota/context evaluator with a
  switch-versus-wait comparison; coalesced evaluation after incident commits;
  attachment to canonical context-exhaustion and plan-stall episodes; read-only
  `process_recommendations_list`/`process_recommendation_get`; a recommendation
  list/detail in the Metrics view.
- Spec: ADDED `process-observations` quota and incident requirements and
  "Recommendation evidence outlives observation detail"; new capability
  `process-recommendations` with the incident requirements; ADDED
  `team-process-metrics` "Early advice does not waive evidence sufficiency";
  ADDED `chat-usage-limits` "Background quota observation is bounded and
  credential-safe". Main background scenarios are implemented, not restated.

## Capabilities

### New Capabilities

- `process-recommendations`: incident advice, assessments, and read-only
  access (later extended by `process-workflow-observability`).

### Modified Capabilities

- `process-observations`, `team-process-metrics`, `chat-usage-limits`.

## Impact

- Code (planned): a new `src/server/chat/quota/` (reader service,
  scheduler, subscriptions), `ChatSessionManager.ts` (delegation),
  `src/server/metrics/observations/` (quota facts), a new
  `src/server/metrics/recommendations/` (stores, evaluator, queue, tools),
  `src/server/team/capacityTools.ts` unchanged (read-only), Metrics client
  components, migrations under `src/server/`, `docs/recovery-matrix.md`,
  `docs/operations/process-observability.md`.
- Dependencies: `process-observability-foundation` archives first (specs);
  landed providers-and-workers usage/cooldown, `team_capacity`
  (`capacityTools.ts`), routing (`src/server/team/routing/router.ts`), the
  context-exhausted flag, and plan-supervision stall episodes are consumed as
  they are on master. `openrouter-provider` stays on its own pull (no
  background pull for it, its design D6).
- Migrations: numbered at landing; serialized with any other change adding
  one (team-workspace-redesign T3, relay credential store).
- Recovery: new matrix rows for the scheduler's startup and the evaluation
  queue's reconciliation.
