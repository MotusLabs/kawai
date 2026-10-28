# Proposal

## Why

Tool calls fail in ways nobody sees until someone reads transcripts by hand.
- A project using Kawai found, after the fact, that every coverage submission took 3 to 6 refusals, and that one model gave up (`coverage-tool-usability`).
- One deployment's chat-wire logs showed the same shape (an operational observation with illustrative counts, e.g. dozens of `Input validation error` refusals on busy `kawai-team` tools). No corpus is kept or cited; this is motivation, not a measurement claim.

Kawai already records each tool call as an observation (`src/server/metrics/observations/chatTracker.ts`). It keeps only a broad category (`shell`/`file`/`mcp`/`other`) and success or failure. It keeps no tool name and no failure reason, it exports nothing to Prometheus, and the Metrics tab does not show it. A tool whose schema or wording misleads agents therefore stays invisible, and nobody can show that a fix such as `coverage-tool-usability` worked.

## What Changes

- **Tool identity and failure class on every tool observation.** Each call gets a bounded identity: CLI built-ins and exact `kawai-team` members keep their names (same in both runtimes); other MCP names get opaque, once-assigned live slots (97th distinct name is `unknown`); ambiguous shapes (`mcp__dynamic__…`, repeated separators, collapsed agent tools) are `unknown` and never enter streaks. A failed result gets exactly one class from an ordered, output-anchored classifier (K0–K14: trusted denial first, then wrapper prefixes, tool-specific phrases, shell fallbacks). Text is classified, never kept.
- **Bounded, honest per-turn accounting.** Per live turn: at most 512 first-seen call ids (every admission reserves a tombstone; the first saturating call closes open streaks `unknown` once and stops further measurement), at most 64 first-seen approval-request records with terminal tombstones (pre-call denials included), at most 96 opaque foreign-name slots. All added state rides the tracker's existing per-event transaction and rolls back with it.
- **Conservative streaks with taint.** Consecutive failed results of one tool within a turn form a streak; a success closes it `recovered`, the turn's end `abandoned`, a restart or replacement `unknown` (a lower bound). A quarantined orphan result or an advanced recorder-failure counter closes every open streak `unknown` once, taints the turn, and forbids any later exact `recovered`/`abandoned` claim across the gap. Turn close persists coverage scalars (`toolCoverageVersion`, `toolFirstHistoryUnknown`, `toolStreakTainted`, `toolDenialIncomplete`) on the existing 90-day `turn_ended` fact; a missing or version-invalid carrier is `unrecorded`, never a false clean bill.
- **Closed-cohort first attempts.** The first ACTUAL call per (turn, team tool) and each streak's opening failure are owned separately. A call is first-attempt eligible only when its completion falls in the window and a valid same-snapshot `turn_ended` shows version 1 and no taint; tainted, legacy, missing-carrier, or unclosed turns are excluded as partial or unrecorded, never as successes or zeros.
- **Export behind an activation gate.** Three Prometheus families are reserved all-or-nothing (preflight + `INSERT OR IGNORE` reservations + first active marker in one transaction) within the existing series/family budgets; the fixed checkpoint `tool-export-v2` records `active`/`budget-unavailable`/`unknown` with reason and `availableSince`. Budget refusal writes only the unavailable status; already-admitted labels continue, nothing unadmitted is written or rendered, and all three families stop together. The renderer keeps omitting empty families; nothing fabricates zero samples or a diagnostic family.
- **Recovery that fails closed.** On process start each existing live-checkpoint row recovers in its own transaction after validating its core identity and state; a malformed, scope-mismatched, or state-unusable row is quarantined byte-unchanged (`tool-recovery-quarantine` counts only), its session is blocked from tracker admission until a separately authorized recovery policy resolves it, and the app keeps running.
- **Process metrics, drill-down, status.** A Tools family in process metrics (failure rate by tool × class, closed-cohort first-attempt success, abandoned streaks, mean failures before recovery) carries the bounded measurement status in both `team_metrics` projections. The drill-down lists every abandoned streak through at most 50 pages behind a stable cursor plus the five longest recovered, and reveal reports `not-found`/`archived`/`unreadable` instead of silently clearing.

## Capabilities

### New Capabilities
- `tool-call-metrics`: how tool calls are admitted and identified, how failures are classified, how failure streaks and first attempts are measured under taint, how recovery fails closed, and how all of it is recorded, activated for export, and drilled into.

### Modified Capabilities
- `team-process-metrics`: adds the Tools family, its drill-down, and the bounded measurement status to the Metrics tab and to `team_metrics`.

## Impact

- `src/server/metrics/observations/chatTracker.ts`: PC1 admission fences, bounded turn state (512/64/96), streak and taint transitions, coverage scalars at close.
- A new pure `toolCalls.ts` beside it: identity mapping, the K-classifier, and the streak reducer reference model.
- `recorder.ts` / `service.ts`: the recorder-failure watch, `health().toolMeasurement`, the `tool-recovery-quarantine` and `tool-export-v2` checkpoint keys, and the existing debounced notify on committed status changes.
- `store.ts`: retention for the `tool_streak` fact kind; no DDL (observations are kind-tagged JSON rows, and the coverage scalars ride `turn_ended`).
- `src/server/metrics/export/registry.ts`, `accumulator.ts`, `boundedLabels.ts`, `snapshot.ts`: definition version 2, all-or-nothing reservations, admission-gated adds and gauges.
- `metricsInputs.ts` (`loadMetricsInputs`), `src/shared/processMetrics.ts`, `metricsQuery.ts`, `computeMetrics.ts`: both checkpoint statuses in one consistent read, the Tools family, and the tool-only-origin load.
- Client: the Metrics tab renders the family and status, pages the drill-down, and `useRevealRow` reports explicit outcomes. Status pushes ride the existing `ChatConnections.publishMetrics` path and the service's debounced notify.
- `docs/operations/process-observability.md` and AGENTS.md's observability bullet.
- No database migration. Observations recorded before the deploy are `unrecorded`, never zero; export totals start at the deploy. Tool metrics establish neither Delivery source coverage nor usage continuity.
