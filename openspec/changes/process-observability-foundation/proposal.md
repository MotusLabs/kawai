# Proposal

## Status

PROPOSED (2026-11-18), planning only, for plan `plan-2eb5f292` (draft). One
of three changes that partition `process-observability` (see that change's
"Partition status"). This one is a **closeout** of behavior already on
master: the observation foundation (tasks 1.1–1.5, 2.1–2.4) and the optional
Prometheus export (9.1–9.5), delivered 2026-10-18 and ticked in
`process-observability`. It claims nothing that is not mapped to code and a
test (design "Closeout map"); a mapped scenario whose closeout test fails
moves out of this change by a contract question, never by weakening it.

It does **not** complete background quota observation (finding F4). The main
`chat-usage-limits` spec already promises it and no collector exists
(`ChatSessionManager.ts:3225` pulls only for started sessions);
`process-quota-history-and-incident-advice` owns that collector.

## Why

The foundation has run on master for a month but its requirements are only in
an unarchived change whose other 31 tasks are unbuilt, so the main specs do
not describe the observation store, retention, or `/metrics`. Archiving the
landed part, with each scenario tied to a test, gives later changes a real
baseline to modify.

## What Changes

- Specs only describe landed behavior, re-derived from `process-observability`:
  - `process-observations` (main exists since `compact-observation-detail`):
    seven ADDED requirements, one narrowed to landed clauses ("History has
    bounded retention and visible coverage" without the recommendation-evidence
    clause and its "Detail pruned" scenario, which move to
    `process-quota-history-and-incident-advice`).
  - `prometheus-export` (new capability): seven requirements; "Export
    distinguishes counters histograms and current gauges" is narrowed to the
    gauges that exist (queue, collection health). The quota, blocked-work and
    open-age gauges stay with task 9.6 in `process-workflow-observability`.
  - `chat-turn-usage`: the 60 → 90 day rename and retention text.
  - `team-process-metrics`: "Observation definitions are shared across
    surfaces", narrowed to the Metrics view, tools and export (report
    snapshot versions move to `process-workflow-observability`).
- Planned work is test-only and docs: `@covers` annotations with literal
  titles for 12 scenarios whose existing tests assert their outcomes, 15 new
  closeout tests or assertions (design "Closeout map"), then sync and archive.

## Capabilities

### New Capabilities

- `prometheus-export`: optional, protected, bounded cumulative export.

### Modified Capabilities

- `process-observations`, `chat-turn-usage`, `team-process-metrics`.

## Impact

- Code: none expected. Closeout tests may be added under `src/server/__tests__/`.
- Archive order (proposed): `openrouter-provider` first (both touch
  `chat-usage-limits` history; this change carries no `chat-usage-limits`
  delta), then this change, then `process-quota-history-and-incident-advice`
  and `process-workflow-observability`, which MODIFY requirements this change
  adds.
- `openspec/coverage.json` does not exempt this change, so every ADDED and
  MODIFIED scenario needs a `@covers` annotation at archive.
