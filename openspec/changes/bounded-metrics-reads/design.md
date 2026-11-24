# Design

## Context

Current inventory on master `f52963d0` (static read; nothing run):

| Path | What it does today |
|---|---|
| `src/server/metrics/metricsTools.ts:16-22,47-54` | `team_metrics {window, detail?: compact\|full, slice?}`; refuses an unknown window or slice; `full` returns `reader.read(...)`, otherwise `compactMetrics(...)` |
| `src/server/metrics/metricsProjection.ts:3-29` | `compactMetrics`: `structuredClone`, caps every `tasks`/`messages`/`breakdown`/`slices`/`entries` array at 50 in computed order, records `<key>Total`, sets `projectionTruncated`, then pops the largest list until the JSON is under 32,000 bytes; throws when metadata alone exceeds it |
| `src/server/metrics/computeMetrics.ts:43-59,104-114` | every `MetricValue.drill` holds all task/message refs; `MetricsReader.read(team, window, slice, {fresh?})` caches 30 s per `[team, window, slice]` at now; `readMetrics(db, ..., end)` already takes an end |
| `src/server/metrics/toolMetrics.ts:100-102` | `tool_abandoned_streaks` keeps 50 inline entries plus `total` and the five longest recovered streaks |
| `src/server/metrics/toolDrill.ts` | `readToolDrill(db, team, window, slice, pageSize 1–50, cursor, now)`: cursor binds team, slice, window, window end, page size, high-water `seq`, last `(closedAt, seq)`; mismatch and malformed cursors throw |
| `src/server/metrics/metricsConnections.ts:127-137` | the human's `process-tool-drill-page` WebSocket message, the only caller of `toolDrill` |
| `src/server/metrics/reportTools.ts:56-76` | list returns `ReportList` with every snapshot; get returns one whole; submit returns the stored report whole |
| `src/server/metrics/reportRead.ts:65` | `readReport` overlays the live `toolMeasurement` on the stored snapshot |
| `src/server/metrics/reportService.ts:97-112,158-175` | submit freezes `reader.read(..., {fresh: true})`; `list`/`report` serve both the human and the tools |
| `src/server/__tests__/metricsTools.test.ts` | caller team, refusals, registration, and `compact and full use the same status while compact bounds large drills without mutating cached numerics` |
| `src/server/__tests__/toolDrillPaging.test.ts` | W12 paging and refusals of the human pager |

Every `kawai-team` tool result is one `JSON.stringify` of the handler's value
through `teamToolTable`; both runtimes register from that table.

## Goals / Non-Goals

**Goals:** every agent metrics and report read is bounded by default; every
drill entry an agent cannot see in a compact read is reachable by paging;
agent numbers stay identical to the tab's.

**Non-Goals:** changing the Metrics tab, its WebSocket messages, or the human
Tools pager; rewriting stored snapshots; changing metric definitions; any
`task_get` work (delivered by PR #396 and `bounded-task-reads`); bounding
`breakdown`/`slices` rows by paging (they stay reachable through
`detail: full`, X2); a response cap in `teamToolTable`.

## Decisions

### D1 — Keep the landed compact projection; specify it

`compactMetrics` and `detail` stay as landed. The MODIFIED requirement states
what they already do: under 32 KB, every value/`n`/baseline/flag kept, each
shortened list marked by `<key>Total`, `projectionTruncated` on the read, and
`full` lossless. Compaction never mutates the cached value (the landed test
already checks this). *Alternative not taken:* the original change's D1
(id-sorted lists, `drill.total`/`drill.next` in place of the `Total` keys).
It would change a landed agent output for no reader that needs it.

### D2 — One drill API: `team_metrics_drill`

Arguments: either a first-page request
`{ window, slice?, end?, metric, list, limit? }` or
`{ report_id, metric, list, limit? }`, or a continuation `{ cursor }` alone.
`list` is `tasks | messages | toolStreaks`; `limit` is an integer 1–200
(default 100) for `tasks`/`messages` and 1–50 (default 50) for `toolStreaks`,
matching the human pager. `end`, when given, must be an ISO instant no later
than now; agents pass the compact read's `periodEnd`. A request carrying both
a cursor and any other argument is refused ("a cursor carries its request").

Cursor: base64url JSON, versioned,
`{ v: 1, team, src: {kind:'live', window, slice, end} | {kind:'report', reportId}, metric, list, limit, after, tool? }`.
`after` is the last id returned (tasks and messages, code-unit id order).
For a live `toolStreaks` list, `tool` is the `readToolDrill` cursor itself,
so the high-water mark and `(closedAt, seq)` order are the human pager's.
Decoding validates every field and refuses any unknown field, as `toolDrill`
does. The cursor's `team` must equal the caller's team (refused as a team
mismatch, never read for the caller instead): the session decides the team,
and a cursor cannot widen it.

Page: `{ metric, list, total, entries, next, source: {kind, window, end} | {kind, reportId} }`.

Sources:
- live `tasks`/`messages`: `reader.readAt(team, window, slice, end)`, the
  metric's list sorted by id, entries with `id > after`, at most `limit`;
- live `toolStreaks`: `readToolDrill(db, team, window, slice, limit, tool, end)`
  (its first page reads at `end`, not at now);
- report: the stored snapshot of `reportId` for the caller's team; its
  `toolStreaks` list holds only the stored inline entries, so the page carries
  `reachable` (stored entry count) beside `total` and never invents the rest.

Refusals (tool-error envelope, naming what is allowed): unknown window,
slice, metric, or list; `toolStreaks` on a metric without tool streaks;
`limit` out of range; `end` malformed or in the future; malformed cursor; team
mismatch; limit changed under a cursor; unknown or foreign report
(`Unknown report: <id>`). Every refusal returns no entries.

*Alternative considered:* a `cursor` on `team_metrics` and on
`process_report_get` (one result shape per tool would become two).
*Alternative considered:* routing agents to the WebSocket pager (not an agent
transport, and tool streaks only).

### D3 — Reads at a fixed end are cached by end

`MetricsReader.readAt(team, window, slice, end)` caches by
`[team, window, slice, end]` for 30 s and evicts expired entries; `read()`
keeps its `[team, window, slice]` latest-read cache, delegates to
`readAt(..., now)` on a miss, returns the cached value with its original
`periodEnd` on a hit, and keeps `fresh` bypassing both caches (report
submission relies on it). A fixed end is not a frozen snapshot: backfills,
mutable task history, or retention can change a live list, so exactly-once
paging assumes unchanged source records; reports give a frozen walk.

### D4 — Report tools project in the handlers

- `process_reports_list` maps each report to `Omit<ProcessReport,'snapshot'>`;
  freshness and proposals are unchanged.
- `process_report_get { report_id, detail? }`: compact by default,
  `readReport`'s value (stored snapshot plus live status) with `full`.
- `process_report_submit` returns the stored report through `compactMetrics`.

`ProcessReportService.list`/`report` are unchanged, so the tab still gets
whole snapshots. *Alternative not taken:* the original change's "no `full`
flag" for reports; `detail` mirrors the landed `team_metrics` interface and
keeps every stored number reachable to agents in one call when they opt in.

### D5 — Descriptions say what is compact and how to page

`team_metrics`' description names `detail`, `projectionTruncated`, the
`<key>Total` markers, and `team_metrics_drill`; the report descriptions name
compact snapshots and `detail`. The metrics bullet in
`docs/architecture/metrics.md` follows.

### D6 — Proposed retirement of inline expansion

Requirement "The agent tool expands named metrics" and the `metrics` argument
of the original change are withdrawn in favor of D1 and D2. This is a
proposed contract choice for the owner's plan approval; until approved, the
original change's text stands as an unimplemented proposal.

### D7 — Held `delivery-outcome-metrics` mapping (not applied)

That change's D5/D10 extends "the projection of `bounded-metrics-and-task-get`"
with `evidence`, `unavailable`, and a `delivery` header, and adds a generation
identity to live cursors. If the owner resumes it, its artifacts would map:
`compactMetrics` → this D1 projection (extended, not replaced); "live cursor"
→ D2's `src.kind: 'live'` cursor (the generation becomes an additional
validated field, refused when stale); `readAt` → D3; its MODIFIED blocks of
"Agents read metrics..." and "Reports are listed..." re-derive from the text
this change archives. Nothing in its held artifacts is edited by this change.

## Risks / Trade-offs

- **[Breaking report output for running agents]** → field names stay; only
  `snapshot` disappears from the list and shrinks in get/submit; `detail:
  full` restores it. Reverting the code restores the old output; no stored
  data changes.
- **[Live pages recompute]** → the end-keyed cache shares one computation for
  30 s of a walk; a 2,595-entry list takes 13 pages at limit 200.
- **[Id order is not meaningful]** → the first page is a stable sample, and
  the total states how many exist.
- **[Report tool streaks are partial]** → stored snapshots keep 50 inline
  entries; the page states `reachable` beside `total`.

## Acceptance oracles

Every refusal uses the tool-error envelope of the unknown-window refusal
(hazard "refusals missing the success envelope"). Each row runs through
`teamToolTable` as production composes it, under both runtimes' registration
(hazard M1), on a seeded 300-task 7d fixture whose `mail_share` list holds
2,595 messages and whose window holds 120 abandoned tool streaks.

**Table T (retargeted from the original Table T).**

| id | call | → result |
|----|------|----------|
| T1 | `team_metrics {window:'7d'}` | serialized < 32,000 bytes; every value, `n`, baseline, flag equals a `full` read in the same cache period; `mail_share.drill.messages` ≤ 50 with `messagesTotal` 2,595; `projectionTruncated` true |
| T1a | same with `detail:'full'` | deep-equal to the tab's read of the same key (drill, breakdown, slices) |
| T1b | compact and full while export is budget-unavailable | both carry `toolMeasurement.export.state` `budget-unavailable` |
| T2 | drill `{window:'7d', end: T1.periodEnd, metric:'mail_share', list:'messages', limit:200}` walked to a null cursor | 13 pages; concatenation = sorted 2,595 ids once; every page total 2,595 |
| T3 | drill `metric:'velocity'`; `list:'toolStreaks'` on `mail_share`; `list:'breakdown'` | refused naming `METRIC_IDS`; refused naming the metrics with tool streaks; refused naming the three lists |
| T4 | drill with `slice:{kind:'group'}` | page entries equal the sliced read's list; refusal for `slice.kind:'x'` names the kinds |
| T5 | drill on a metric with 12 task refs | 12 entries, total 12, `next` null |
| T6 | `process_reports_list {limit:10}` | no `snapshot` key; ids, summaries, proposals, freshness equal the human list's |
| T7 | `process_report_get {report_id}` on a 7d report; then `detail:'full'` | compact snapshot < 32,000 bytes with values equal to the stored ones; full equals `readReport`'s value |
| T8 | `process_report_submit` (7d) | returned snapshot compact; stored row whole with 6,998 message refs |
| T9a | two `team_metrics` reads 1 s apart, then a `fresh` report submission (fake clock) | both reads share one `periodEnd`; the submission reads at now, bypassing both caches |
| T9 | two drills whose `end` differ by 31 s (fake clock) | each page equals `readAt` at its own end |
| T10 | page 2 read 1 h after page 1 (fake clock, records unchanged) | page equals the read at the cursor's `end`, not at now |
| T11 | `limit` 0, 201, 1.5 on `messages`; 51 on `toolStreaks` | refused naming 1–200; refused naming 1–50 |
| T12 | cursor not base64url; `v:2`; an unknown field; missing `after`; cursor plus any first-page argument; an unknown tool argument; a live tool-streak cursor whose end differs from its inner cursor's | refused as invalid cursor, "a cursor carries its request", or an unrecognized key (one row each) |
| T13 | `report_id` of another team, or unknown | refused `Unknown report: <id>` |
| T14 | a live cursor used from a session of another team | refused as a team mismatch; no entries |
| T15 | live `toolStreaks` walk while three later streaks commit | pages and total equal the first page's high-water mark; entries equal the human pager's for the same end and page size |
| T16 | report `toolStreaks` on a snapshot with total 120, 50 stored | entries are the 50 stored, `total` 120, `reachable` 50, then `next` null |
| T17 | `end` later than now, or not an ISO instant (out-of-range fields included) | refused naming `end`; an ISO instant with `Z` or an offset, with or without a fraction, reads at that instant |
| T18 | the human's `process-tool-drill-page` and report connection after agent walks | unchanged responses (connection tests stay green) |

Unreachable: a report cursor with a `slice` (the cursor schema has no slice
for reports, so decoding refuses it as an unknown field — T12).

**Properties.**
- **P1, paging is exactly-once.** Generator: drill lists of 0–3,000 unique
  ids and limits 1–200 (tool streaks: 0–300 streaks, limits 1–50). Seams: the
  production `team_metrics_drill` handler through `teamToolTable`, over a live
  source at a fixed fake clock, a stored report, and the tool-streak source.
  Property: following `next` from the first page until null returns the
  sorted list exactly once and every page states the same total. Seed
  `0xD811`, 300 cases (`propertyCases`).
- **P2, the compact form is a projection.** Generator: `MetricsInputs` from
  `metricsSeed.ts`. Property: for every metric, compact keeps `value`, `n`,
  `baseline`, and every flag equal to the full read's; each kept list is a
  prefix of the full list and its `<key>Total` equals the full length; the
  input is deep-equal before and after (no mutation); the union of D2 pages
  equals the full list sorted by id. Seed `0xC0DE`, 300 cases.
- **P4, stored records are unchanged by reads.** For every read-only row of
  Table T, a hash of the stored report rows and observation rows before and
  after the call is equal; for T8, the new report holds the whole snapshot
  and existing rows are unchanged.

**Mutants each row must kill** (listed in tasks.md): a cache key without
`end` (T9, T10); the cursor's team trusted (T14); `after` compared with `>=`
(P1); the limit check off by one (T11); compaction writing back to the cache
or the stored row (P2, P4); `list` changed in `ProcessReportService` rather
than the handler (T6 with T18); the agent tool-streak path reading at now
instead of `end` (T15); report tool streaks padded to `total` (T16).

## Production composition checkpoint

The first checkpoint is one real path: `team_metrics_drill` registered in
`teamToolTable`, called through the Claude and Codex registrations against a
manager-built `MetricsReader`, returning page 1 and page 2 of `mail_share`
messages at a fixed end, plus the T14 refusal. A mutant that leaves the
handler unregistered, or drops the metrics services from the manager's
composition, must fail it (`metricsDrillManager.integration.test.ts`).
Report and tool-streak sources expand after that checkpoint.

## Affected existing workflows

The Metrics tab (`metricsConnections.test.ts`, `reportConnections.test.ts`),
the human Tools pager (`toolDrillPaging.test.ts`), report submission and
linking (`reportTools.test.ts`, `reportLinks.test.ts`), the export status push
(`processMetricsExport.test.ts`), and the team tool table tests. All stay
green unchanged.

## Scope inventory (original `bounded-metrics-and-task-get`)

Every original item maps to exactly one row. "BMR" = this change.

| Original item | Disposition |
|---|---|
| Req "Agents read metrics through a read-only tool" (MODIFIED) and its 5 scenarios | BMR MODIFIED: "Lead reads its team", "Unknown window", "Same values as the tab" kept; "Flags survive compaction" → "Compact marks shortened lists" + P2; "Sliced compact read" → T4 and "Full detail is lossless" |
| Req "The agent tool expands named metrics": "Expand one metric" | proposed retirement (D6); need served by "Paging a message list to the end" |
| — "Short list needs no cursor" | BMR "Short list ends on its first page" |
| — "Unknown metric id" | BMR "Unknown metric or list" |
| Req "Drill lists are paged by cursor": "Paging to the end", "Live pages keep their window end", "Malformed cursor", "Limit out of range", "Another team's report" | BMR "Agents page metric drill lists": same five, the middle two as "Cursor bound to its request" (T11, T12) |
| Req "The Metrics tab reads metrics whole" | BMR same requirement |
| Req "Agents read report snapshots compactly" (5 scenarios) | BMR same requirement; "Expanding a metric of a report" → "Paging a report drill list" |
| Req "Reports are listed with their freshness" (MODIFIED, 3) | BMR MODIFIED, same three scenarios |
| Task 0.1 | landed (ticked; `bounded-task-list` #358) |
| Tasks 1.1, 1.2 | BMR 1.1, 1.2 |
| Tasks 2.1, 2.2, 2.3 | BMR 2.1–2.3 |
| Tasks 3.1–3.6 | landed outside: PR #396 (3.3) and `bounded-task-reads` PR #419 (archived `775787a2`); boxes stay as recorded |
| Task 4.1 | historical (ticked in the proposal PR); its edit of the held `delivery-outcome-metrics` stays; D7 maps the new names |
| Task 5.1 | BMR 3.1 (deterministic sizes); the live-DB copy measurement is owner-gated (BMR 3.2) |
| D1–D4, D10, Table T, P1, P2, P4 (Table T part) | retargeted here (D1–D7, Table T, P1, P2, P4) |
| D5–D9, Table G, P3, P5, P4 (task part) | landed outside (main `team-tasks`) |

**Reconciliation of the original after BMR lands (owner decisions, not
automatic):** the Lead proposes, and only the owner decides, whether
`bounded-metrics-and-task-get` is retired as superseded and how its held
lineage (`8011e25e`, `result-d18090f6`, tasks `931742d5`, `49405e3d`,
`0f818563`) is closed. No agent cancels, archives, or ticks it.

## Implementation contract

### Acceptance
- A1: `team_metrics` keeps `detail: compact | full` as landed; Table T rows T1, T1a, and T1b pass through `teamToolTable` under both runtime registrations.
- A2: `team_metrics_drill` pages `tasks`, `messages`, and `toolStreaks` from live and report sources with cursors bound to team, source, end, metric, list, limit, and the tool-streak high-water mark; rows T2–T5, T9–T17 and property P1 pass.
- A3: `MetricsReader.readAt` caches by end while `read()` keeps its latest-read cache and `fresh` bypass; rows T9a, T9, and T10 pass.
- A4: `process_reports_list` returns no snapshots, `process_report_get` returns a compact snapshot unless `detail: full`, and `process_report_submit` echoes a compact snapshot; rows T6–T8 and T13 pass.
- A5: Tool descriptions and the metrics bullet in `docs/architecture/metrics.md` name `detail`, the truncation markers, and `team_metrics_drill`.
### Invariants
- I1: No agent read writes a stored report, observation, or cached metrics value; property P4 and P2's no-mutation check pass.
- I2: The Metrics tab, the human Tools pager, and `ProcessReportService.list`/`report` return the same values as before (row T18).
- I3: A cursor never reads another team's data; a foreign or mismatched cursor is refused with no entries (T13, T14).
### Scope
- `src/server/metrics/**`
- `src/shared/processMetrics.ts`
- `src/shared/metricsMessages.ts`
- `src/server/team/teamPrompt.ts`
- `src/server/team/mailboxTools.ts`
- `src/server/__tests__/**`
- `src/shared/__tests__/**`
- `docs/architecture/metrics.md`
- `openspec/changes/bounded-metrics-reads/**`
### Verification
- V1: Table T rows are committed as literal table-driven tests next to the code, at least one per guarded seam through `teamToolTable`, each with the named mutant shown failing.
- V2: Properties P1 and P2 run through `propertyCases` with seeds `0xD811` and `0xC0DE` at 300 declared cases.
- V3: A citation preflight resolves every cited literal test title, then `bun run check --full-properties` passes on the clean committed head using the Bun version declared by `.bun-version` at that commit, and `scripts/verify-result.ts` reports its exit code.
- V4: `openspec validate bounded-metrics-reads --strict` passes.
### Excluded
- X1: No `task_get` change; it is delivered by PR #396 and `bounded-task-reads`.
- X2: No paging of `breakdown` or `slices` rows; `detail: full` returns them.
- X3: No edit of `bounded-metrics-and-task-get` or `delivery-outcome-metrics` artifacts and no action on their held lineages.
- X4: No live-database measurement without the owner's consent; no browser or e2e run.
