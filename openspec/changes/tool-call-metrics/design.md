# Design

## Context

Source facts at this branch's base (`0bff6f6f`, `src/` unchanged since): the tracker has one production producer — `ChatSessionManager.handleDriverEvent` (3376–3383), fed by driver `onEvent` (2783); the synthetic notice path (2180) never reaches it, and transcript replay populates history only. Both drivers mint fresh `turn-<uuid>` ids per turn and fresh event ids per emit; the manager reassigns the wire sequence, so it is not durable authority. Pruning deletes `chat:`/`segment:`/`turn-end:` keys with their rows by `recorded_at`; `turn_ended` is a 90-day fact kind with an indexed `turn_id`, written by `finish()` in one transaction that also deletes the live row. `ObservationRecorder.failures` already increments on every `safe()` catch and is never reset when the generic gap clears — a process-lifetime indicator. `process_collection_checkpoints` is the existing fixed key/value carrier. `service.health()` reports recording/failure/gap state but has no tool-export field; the renderer omits families without samples entirely; `MetricsSnapshot` gauges and its 5-second text cache exist. `loadMetricsInputs` (`metricsQuery.ts:156`) already reads team tables in one consistent transaction.

Publisher and cache facts (current source `8d75a11e`): `ProcessObservationService.notify` (`service.ts:76–86`) only arms reconciliation — it has no publication edge. The only metrics push is `ProcessReportService.onCommit` (`ChatSessionManager.ts:1223–1224`) → `options.onProcessReportChange` → `bootstrap.ts:169` → `ChatConnections.publishMetrics` (212–213) → `MetricsConnections.publish` (51–60), per team, with a fresh recompute. `MetricsReader.read` (`computeMetrics.ts:94–104`) returns the cached `hit.metrics` object for 30 s; it is the single reader behind the Metrics tab (`metricsConnections.ts:90`), `team_metrics` (`metricsTools.ts:50`), and report snapshots (`reportService.ts:106`). The reader is constructed at `ChatSessionManager.ts:1207`, the observation service at 1239.

Budget facts: `BoundedLabels` calls `reserveOverflow` from its constructor and every `labels()`; it returns early once the `task_results_total` catch-all exists, so a populated v1 database never reserves catch-alls for added families. Normal admission adds `reserve = Object.keys(REGISTRY).length` to every new labelset check (`boundedLabels.ts:82–84`), and `overflow()` admits `export_label_overflow_total{family}` without a budget check. `ExportAccumulator` (one per `ObservationStore.record` transaction, `service.ts:51–57`) and `MetricsSnapshot.read` each construct a `BoundedLabels`.

## Goals / Non-Goals

**Goals:**
- Name the tool and the cause of every admitted failed call, bounded, with no text kept.
- Detect an agent repeatedly failing one tool, and whether it got through.
- Measure first attempts honestly: only where the turn's recorded history is provably complete.
- Show it in Prometheus and in the Metrics tab, by model and profile, with drill-down to the first failed call.
- Fail closed: every bounded map, the export gate, and quarantine prefer "unknown/unavailable" over an exact claim.

**Non-Goals:**
- Storing inputs or outputs; per-argument diagnostics; a tool-schema version label.
- Arbitrary-age replay protection: a triple replayed after its 90-day retention is explicitly outside the producer contract (PC1), not rejected.
- Any total-memory, byte-size, source-completeness, or physical exactly-once guarantee; only the added logical entries (512 call ids, 64 request records, 96 opaque slots per live turn) are bounded.
- Attention items, alerts sent by Kawai, or automatic changes; a ledger; a retention increase; a new Prometheus family; a repair UI or DB rewrite.
- Subagent (Task) tool calls, which the event stream does not carry.

## Decisions

### D0 — Producer contract PC1 and admission fences

Live-driver path only: transcript replay and history never enter the tracker. Fences, all checked before any mutation of current state:
- **F0** the existing event-key dedupe;
- **F1** a `turn_started` whose id equals the live turn's is a duplicate: dropped, never finish+reopen;
- **F2** a `turn_started` for a turn with a retained `turn_ended` row is rejected (90-day window);
- **F3** tool/approval events go only into the live turn with the matching id (wrong-turn guard runs pre-mutation).

Totals never decide admission. Disclosed limit: Codex stamps every item frame with the current Kawai turn, so late frames of earlier upstream calls can be misattributed to the current turn — each counted once for its accepted (session, KawaiTurn, callId), with no bound on how many such frames occur; no stale-frame driver guard exists or is granted. A replay older than the retained window is out of contract (renaming a closed turn to a fresh id is indistinguishable from a fresh turn; bounded state cannot reject it).

### D1 — Bounded per-turn call state (512 first-seen ids)

Live turn field `tm.calls`: `callId → {identity, outcome: pending|success|failed, failureClass?, denial?}`, capped at **B_ids = 512 first-seen ids**. Every admitted call — or any first-seen pending/terminal/quarantined id, including an orphan result's id — reserves a tombstone slot; nothing is evicted while the turn is live, everything is discarded at close (then fenced by the retained facts). A new call at the cap is non-admitted (`nonAdmitted++`); the first such call fires **SAT**: open streaks close `unknown` once (lengths are the observed prefix), no streak opens again this turn, and already-admitted pending calls still settle exactly once. Duplicate calls are ignored; a duplicate or conflicting result never mutates a settled call.

### D2 — Approval-request links (64 first-seen records with tombstones)

Metric-owned request records are **first-seen ids retained until E/R** (no capacity is reclaimed mid-turn; the existing UI/timing request map is untouched). Finite states per record: `pending(callId)`, `denied-await-call(callId)`, `transferred(callId)`, `settled-allowed|cancelled(callId)`, `unlinked|quarantined(callId?)`. The q→c binding is immutable. A linked approval before the call reserves `pending` under **B_link = 64**; a denial resolved before the admitted call exists becomes `denied-await-call`, still occupying its slot. When the call is admitted, any prior actual denial transfers to `call.deniedBeforeResult` and the record stays as a terminal `transferred` tombstone. The failed-result gate still precedes trusted denial — a success is a success. First resolution wins: duplicates, conflicts, and late resolutions never mutate a settled call or reopen a record. An unknown resolution before a known approval cannot be guessed into a denial: reserve `unlinked|quarantined` when possible and set `denialIncomplete`. At the cap an unseen record stays `unlinked` with `denialIncomplete=true`; the seen 64 still settle. Associations to quarantined, non-admitted, or terminal calls are `unlinked` or late-only and never fabricate a call or result; no-result cards create no denominator. Correlation uses only the reserved optional `approval_request.toolCallId` and the existing requestId resolution.

### D3 — Rollback and the recorder-failure gap signal

Every tracker event writes the observation row and mutates ALL added memory (calls, links, markers, streaks, slots, flags) inside the tracker's existing transaction; a throw rolls the database and every map back together, the event is lost, and `recorder.safe` records the failure. `processEnded`/restart/replacement close the live turn and discard its maps; a restart is not proof of uninterrupted history. The taint watch (D5) compares a turn-scoped `seenRecorderFailures` snapshot against the existing `recorder.failures` at every accepted live-turn event and checkpoint, including immediately before turn end; a fresh turn initializes it from the current usable value. An advanced counter, or an unusable comparison, is a recording gap for this turn.

### D4 — Identity versus label (96 opaque live slots)

The raw tool name stays memory-only. Identity rules, first match wins:
1. CLI built-ins by name; exact `kawai-team` catalogue members by name (both runtimes).
2. `unknown(ambiguous)`: `mcp__dynamic__x` (the current Codex adapter emits this for a namespace-less dynamic call, and a real server `dynamic` collides with it at `codexEvents.ts:148–158`); names with two or more extra `__` separators; collapsed collab/sub-agent placeholders; empty names; and the **bare-echo exception** — the exact bare name `echo` (the historical TN6 helper input; the current adapter is not claimed to emit it). This deliberately declines streak identity even for a legitimate bare `echo` tool; its results still count.
3. Any other distinct raw name takes one of at most **96 opaque per-turn slots**, kept once assigned; the 97th distinct name is `unknown(overflow)`.

`unknown` results still count in eligible totals but never enter any streak reducer; failures on them mark identity incomplete. The public export label (`tool` enum) is separate and coarser; label equality (two names exporting `mcp:other` or `other`) never heals identity, and no identity beyond the ≤96 slotted ones is kept in detail. The slot map rides D3 rollback and dies at turn close.

### D5 — Two marker owners, taint, and the first-attempt read predicate

**Owner 1 — first attempt:** per (turn, exact team tool), set by the FIRST ACTUAL call in call order (not the first admitted call), never promoted; it resolves at that call's first eligible result and freezes there. **Owner 2 — per-streak first failure:** set at streak open from the opening failed result (callId, time, seq), cleared at closure, set anew by the next failure, frozen into the `tool_streak` fact.

**Taint (R1):** live turn scalars `firstHistoryUnknown: boolean`, `streakMode: observing|tainted|saturated`, `seenRecorderFailures: number`, `denialIncomplete: boolean`, monotone within the turn. A quarantined orphan result, or the D3 gap signal, before any normal streak handling: close all open named streaks `unknown` once, set `firstHistoryUnknown=true`, switch to `tainted`, open no further streaks this turn; admitted calls may still settle their one normal result, and no orphan result becomes eligible later. At R/process-loss/replacement the same unknown closure applies. Nothing is subtracted from already-committed lifetime counters; SAT keeps its monotonic rules and composes with taint.

**Carrier:** E/R writes scalars `toolCoverageVersion=1`, `toolFirstHistoryUnknown`, `toolStreakTainted`, `toolDenialIncomplete` on the existing `turn_ended` fact (90d), beside the existing coverage/missing-first fields. A missing or version-invalid carrier is `unrecorded`, never `false`; old or absent state closes unrecorded and no zero-length streak is invented.

**Read predicate (closed-turn only):** a detail row is first-attempt eligible when it is the unique eligible completed success/failed FIRST ACTUAL call of its (session, turn), its completion is inside the window, AND a valid retained `turn_ended` for that turn exists in the SAME read snapshot with version 1 and `toolFirstHistoryUnknown=false`. The closure joins by identity even when `closedAt` lies outside the window. Unclosed turns are pending and excluded; tainted, legacy, missing-carrier, or unavailable firsts are excluded as partial/unrecorded, never counted as successes or zeros; another result is never promoted. A known first completion before the window is an ordinary n=0 exclusion, not missing history. Earlier `first=true` rows stay immutable; after a taint the closure join invalidates their eligibility. The 90-day carrier outlives the 14-day detail and supports the 7d+7d window pair; no longer detailed history is claimed.

### D6 — Classifier (K0–K14, ordered, anchored)

For every admitted result, the first matching row wins. All text matches are anchored at the start of the **untrimmed** output. `H` marks heuristic labels; the classifier never claims causal provenance, and a success is always K0 regardless of its text or any linked denial.

| K | match | class |
|----|----|----|
| K0 | result is success | success: counted in the denominator and in `agent_tool_calls_total` with `outcome=success`, `failure_class=none`; no stored `failureClass`; closes an open streak of its identity normally (even with spoofed failure text or a linked denial) |
| K1 | the call's linked approval resolved `denied` before the result (trusted link, not text) | `denied` |
| K2 | starts `Input validation error:` | `input-invalid` (H) |
| K3 | starts `Invalid arguments for ` | `input-invalid` (H) |
| K4 | starts `Unknown kawai-team tool: ` | `unavailable` (H) |
| K5 | starts `<tool_use_error>Blocked:` | `blocked` (H) |
| K6 | starts `<tool_use_error>Unknown skill:` | `unavailable` (H) |
| K7 | starts `<tool_use_error>` and the WHOLE phrase `No such tool available` occurs within the first 256 characters | `unavailable` (H) |
| K8 | starts `Tool references removed` | `unavailable` (H) |
| K9 | any other `<tool_use_error>` prefix (including a recalled `InputValidationError` wrapper) | `precondition` (H) |
| K10 | exact team-tool identity and starts `Refused: ` | `refused` (H) |
| K11 | Bash only, and starts `The command was declined.` | `denied` (H) |
| K12 | Edit only, and starts `The file change declined.` | `denied` (H) |
| K13 | Bash or Monitor otherwise | `command-failed` |
| K14 | otherwise | `other` |

Discriminators: a failed Monitor reading `The command was declined.` is `command-failed` (K13) and a failed Write or MultiEdit reading `The file change declined.` is `other` (K14), unless a trusted denial is linked (K1); a bare `No such tool available` without the `<tool_use_error>` wrapper is `other` for a tool other than Bash or Monitor; a generic handler error such as `Unknown team: t1` is `other`, not `refused`; a declined command with an empty `aggregatedOutput` is `command-failed` unless a denial is actually linked; `The file change failed.` is `other`; missing/image-only/non-text empty output is `command-failed` for Bash/Monitor and `other` otherwise. An unlinked denial, a card with no result, or a cancellation creates no result row. Class membership uses the detail/canonical identity, never a budget-overflow export label. Cancelled/late links alone are not denial; the failed-result gate precedes K1.

### D7 — Storage, retention, drill-down paging, reveal

`tool` rows gain `identity`, `label`, and, when failed, `failureClass` (14-day detail — enough for a 7d window plus its 7d baseline). `tool_streak` is a 90-day fact kind `{ tool, length, resolution, firstCallId, firstAt, closedAt }` with the turn's attribution identity and a stable ephemeral key. Raw names, inputs, outputs, and corrupt JSON are never stored, logged, or copied into diagnostics; canaries cover every added state, rollback map, checkpoint serialization, source key, and label.

Drill-down has two separate surfaces:
- **Inline drill** (existing projection): the Tools metric's drill inside `ProcessMetrics` and the Delivery D5 `compactMetrics` projection — at most 50 entries plus the total; the default `team_metrics` projection stays compact (below 32 KB). It never claims reachability.
- **Tab pager** (PROPOSED, reserved here before code): every abandoned streak of the window is reachable through **arbitrarily many pages of at most 50 entries each**; there is no cap on the number of pages (2,501 streaks need 51 pages at page size 50).

Pager contract (PROPOSED wire additions to `src/shared/metricsMessages.ts`, routed by `MetricsConnections` and added to the chat WS router whitelist; no `mailboxTools`/`taskContext` change):
- Request `{ type: 'process-tool-drill-page', teamPath, window, slice, pageSize, cursor: string | null }`; `pageSize` is an integer 1–50.
- Response `{ type: 'process-tool-drill-page', teamPath, teamId, window, slice, pageSize, total, entries, nextCursor: string | null }`, `entries.length ≤ pageSize`; each entry `{ factId, tool, length, sessionId, turnId, firstCallId, firstAt, closedAt }`.
- Order: `closedAt` desc, then stable fact id (`seq`) desc. The first page (null cursor) fixes `windowEnd` (now) and `highWater` (the current max observation `seq`); `total` counts abandoned facts with `seq ≤ highWater` in `[windowEnd − window, windowEnd)` and stays identical on every page; facts inserted later never shift pages.
- The opaque cursor encodes `{ teamId, slice, window, windowEnd, pageSize, highWater, last: { closedAt, seq } }`. A malformed cursor, or one whose team, slice, window, or page size differs from the request, is refused with an `error` naming the reason and no entries; an unknown team path is refused as `unknown-team`. An offset against a moving `now` is not a valid cursor.

The five longest recovered streaks come inline, sorted by length desc, then `closedAt` desc, then fact id.

Reveal anchors stay `tool:<firstCallId>`; `useRevealRow` reports `not-found`, `archived`, or `unreadable` explicitly instead of silently clearing, and observation pruning alone never declares an otherwise-readable transcript anchor expired.

### D8 — Export families v2 behind an activation gate

Definition version 2 installs three families — `agent_tool_calls_total` (team, group, provider, model, tool, outcome, failure_class), `agent_tool_failure_streaks_total` (+ resolution), `agent_tool_failure_streak_length` (buckets 1, 2, 3, 4, 6, 10, +Inf) — with `tool` capped at 96 enum entries (`other`, `mcp:other`, 18 built-ins, at most 76 exact team names in table order; excess collapses to `other` with the existing overflow diagnostic; detail identity stays exact for team tools). `failure_class` has 9 values (`none` plus the 8 failure classes) and `resolution` 3. `seriesCost(histogram) = buckets + 2`, so the three catch-alls cost 1 + 1 + 9 = 11.

**Reservation sets** (all from current rows, disjoint): the required set holds, for every `REGISTRY` family (35 under v2), its catch-all labelset (all labels `other`, weight `seriesCost`) and its diagnostic labelset `export_label_overflow_total{family}` (weight 1).
- `E` = `expandedSeries()`: the weighted cost of every already-admitted labelset.
- `M` = the summed weight of the required catch-alls not yet admitted.
- `D` = the count of required diagnostic labelsets not yet admitted (already-paid ones are excluded, so nothing is reserved twice).
- Planned family counts: for each family, admitted labelsets + its planned inserts (for `export_label_overflow_total`, + D).

**Activation transaction** (PROPOSED `BoundedLabels.ensureToolExport(now)`, replacing the `reserveOverflow` early return; run by the observation service at `start()` before the first tracker admission, and re-run when the marker is not active at a checkpoint tick): inside ONE `db.transaction`, compute E, M, D and the planned counts; it fits only when `E + M + D ≤ 250,000` and every planned family count ≤ 10,000. On fit, `INSERT OR IGNORE` every missing required labelset and write the active marker; on refusal, insert nothing and write `budget-unavailable` with `series-budget` or `family-budget`. A throw rolls back every insert and the marker together.

**Normal admission** (replacing `reserve = |REGISTRY|` at `boundedLabels.ts:83–84`): a new labelset is admitted when its family count < 10,000 and `E + seriesCost + D_missing ≤ 250,000`, where `D_missing` is the current count of missing required diagnostics — zero once activation paid them, so no speculative reserve remains. Families other than the three tool families keep today's collapse-to-catch-all and overflow behaviour; old values are never rewritten, reset, or replayed. While the tool export is not `active`, `labels()` admits no new labelset of the three tool families (no alias, no catch-all fallback, no overflow write) and `ExportAccumulator.add` writes nothing for an unadmitted one; already-admitted labelsets keep incrementing, stored but not rendered while unavailable.

Activation (R4): the activation transaction above writes the active marker for the fixed checkpoint key **`tool-export-v2`**: `{version: 1, definitionVersion: 2, state: active|budget-unavailable|unknown, reason: null|series-budget|family-budget|missing-reservation|invalid-checkpoint, availableSince: ISO|null, changedAt: ISO}` — no per-label history, no new Prometheus family, only the current continuous interval. `availableSince` is the store's now at that success. A valid already-active marker keeps its boundary only while all reservations remain valid for the same definition/budget. Budget refusal writes only the fixed unavailable status (`availableSince=null`), never partial reservations; already-admitted old values keep incrementing, no new labelset is admitted, all three families stop together, and the refusal is not thrown into chat recording. Missing/malformed status is `unknown` until reservation verification; a later successful activation starts a NEW `availableSince` with no backfill, reset, or replay of skipped results; earlier history stays unknown.

Wiring: `Accumulator.add` declines before writing unadmitted values; `MetricsSnapshot` gauges use the same admission result and emit nothing for declined labels; snapshot totals never render unadmitted samples and the three families are suppressed while unavailable, preserving their stored values; the renderer's omission of empty families is preserved (no zero samples, no diagnostic family are fabricated). `service.health()` gains `toolMeasurement: { export, recovery }`; `loadMetricsInputs` reads BOTH fixed checkpoint keys in its consistent transaction and the shared `ProcessMetrics` model carries the same bounded status; `team_metrics` keeps the status in BOTH compact and full projections (compact stays under 32 KB).

**Status publication and cache** (all PROPOSED seams; the existing debounce is not the publisher):
- **Process gate.** The service holds, per fixed key, whether THIS process has verified it (`tool-export-v2` by `ensureToolExport`) or written it (`tool-recovery-quarantine` by the start inventory). Until then, and after a failed write of that key, the status reads `unknown` whatever the stored value says; a value left by an earlier process is never shown as current.
- **One status read.** A pure `readToolMeasurementStatus(db)` in `metricsQuery.ts` reads both keys in one read transaction; `toolStatus()` combines it with the gate. `loadMetricsInputs` uses it inside its consistent transaction for a miss.
- **Cache hit.** `MetricsReader` gains an injected `toolStatus` dependency (constructed at `ChatSessionManager.ts:1207` with a closure over the observation service). Both its hit and miss paths return a shallow copy `{ ...metrics, toolMeasurement: toolStatus() }`; the cached object is never mutated, numerics stay cached for 30 s, and every tab snapshot, `team_metrics` response, and report snapshot carries current status.
- **Post-commit edge.** `ProcessObservationService` gains an `onStatusCommit` option. A status write compares the key's canonical bytes before and after inside its transaction; only after that transaction commits with a change (or a gate change) does it arm one coalesced timer (at most one pending, the service's `notifyDelayMs`). A rollback or an unchanged value arms nothing.
- **Fan-out.** `ChatSessionManager` passes `onStatusCommit: () => options.onToolMeasurementStatusChange?.()`; `bootstrap.ts` wires it to a new `ChatConnections.publishMetricsAll()` → `MetricsConnections.publishAll()`, which re-sends EVERY current subscription of every team with `fresh=false` (the keys are database-wide). No report commit or manual refresh is needed, and the service imports neither `ChatConnections` nor `mailboxTools`.
- **Text cache.** `MetricsSnapshot.read` reads the two raw key values before its 5-second cache check and recomputes when their fingerprint differs.

No new polling framework is added.

### D9 — Recovery: per-row, admission block, quarantine

Before the first new metric admission of a process start, the service inventories `process_live_observations`. Each session with an unrecovered row is blocked from tracker event/save/checkpoint mutation until that row resolves; app execution continues and other sessions record. Each row is validated as a legacy core — session/scope agreement, usable turn and time maps, supported turn-state structure — not merely `JSON.parse` success. A valid core with no tool state recovers once as `unrecorded` (unknown closure, correct decoded identity, `turn_ended` coverage, restart gap, row delete — in its OWN transaction; commit then unblock, rollback leaves row and gate intact, retries ride the existing checkpoint cadence, and a second recovery cannot double-fold). A present-but-unusable tool state, a malformed core, or a scope mismatch is **quarantined**: the row stays byte-unchanged, the session stays blocked (no fresh start may silently overwrite the unknown identity), no turn id or fact is invented, no raw JSON is copied, and quarantine persists across restart because the evidence row remains. Resolving it requires a separately authorized recovery policy — none is built here. One fixed checkpoint key **`tool-recovery-quarantine`** (PROPOSED, new) holds only `{version, quarantinedCount, pendingCount, status, checkedAt}`; a failed count write leaves recovery health unknown (not zero, and not the previously stored count, per the D8 process gate), and the admission gate never depends on that write.

## Acceptance oracles

### Original inputs and current expected outputs

The 25 rows below restate, unchanged in id and input cell, the FC/TN/ST tables of commit `540c9df2c9bda83a98d967f262113b0cf3886faa` (`openspec/changes/tool-call-metrics/design.md`, blob `1560164a426ec6a0fe081524c7ad84e1ed479da7`, lines 95–141), with their original columns verbatim; the added "expected now" column is the normative output under D4/D6. Every difference is an explicit Lead policy change (notes 6bbd56f1, acfec826, 96c8fe60), marked **Δ** — not an altered input and not a new blind pass; the blind record and its history stay immutable. Fixtures are committed synthetic or sanitized strings built from the repository's own literals; they pin the classifier's current rules and cannot detect a later external wording change by themselves.

`kt` means a `kawai-team` tool name (original note); "expected now" uses exact catalogue membership.

| id | tool | output / context | class | expected now |
|----|------|------------------|-------|------|
| FC1 | * | `context.denied` | `denied` | `denied` by K1, only for a failed result with a trusted linked denial |
| FC2 | * | starts `Input validation error:` | `input-invalid` | `input-invalid` (K2) |
| FC3 | * | starts `Invalid arguments for ` | `input-invalid` | `input-invalid` (K3) |
| FC4 | * | `<tool_use_error>Blocked:` | `blocked` | `blocked` (K5) |
| FC5 | * | `<tool_use_error>Unknown skill:`, `No such tool available`, `Tool references removed` | `unavailable` | `unavailable` for `<tool_use_error>Unknown skill:` (K6), `<tool_use_error>…No such tool available` within 256 characters (K7), and `Tool references removed` (K8); **Δ** bare `No such tool available` on a tool other than Bash/Monitor → `other` (K14) |
| FC6 | * | other `<tool_use_error>` | `precondition` | `precondition` (K9), including a recalled `InputValidationError` wrapper |
| FC7 | kt | any other failed text | `refused` | **Δ** `refused` only when the text starts `Refused: ` (K10); otherwise `other` (K14), e.g. `Unknown team: t1` |
| FC8 | `Bash`/`Monitor` | any other failed text | `command-failed` | `command-failed` (K13); **Δ** Bash `The command was declined.` → `denied` (K11); Monitor with that text stays `command-failed` |
| FC9 | other | any other failed text | `other` | `other` (K14); **Δ** Edit `The file change declined.` → `denied` (K12); Write/MultiEdit with that text stay `other` |
| FC10 | * | success | none | success (K0): counted with `failure_class=none`, no stored class; **Δ** a success with a linked denial or spoofed failure text is reachable and stays success |

| id | raw | name | expected now |
|----|-----|------|------|
| TN1 | `Bash` | `Bash` | label and identity `Bash` |
| TN2 | `mcp__kawai-team__task_submit_result` (Claude) | `task_submit_result` | label and identity `task_submit_result` |
| TN3 | the same name from a Codex dynamic call | `task_submit_result` | label and identity `task_submit_result` |
| TN4 | `mcp__kawai-team__not_a_tool` | `mcp:other` | **Δ** label `other` (not an exact member), opaque slot identity |
| TN5 | `mcp__docs-search__query` | `mcp:other` | label `mcp:other`, opaque slot identity (≤96 per turn, then `unknown(overflow)`) |
| TN6 | `echo` (a collapsed Codex emission) | `other` | label `other`; **Δ** identity `unknown(ambiguous)` by the bare-echo exception; counts, never in a streak |

| id | state | event | next | fact written | expected now |
|----|-------|-------|------|--------------|------|
| ST1 | ∅ | F | open 1 | none | unchanged |
| ST2 | open k | F | open k+1 | none | unchanged |
| ST3 | open k | S | ∅ | `recovered`, k | unchanged |
| ST4 | ∅ | S | ∅ | none | unchanged |
| ST5 | * | O | unchanged | none | unchanged |
| ST6 | open k | E | ∅ | `abandoned`, k | unchanged |
| ST7 | ∅ | E | ∅ | none | unchanged |
| ST8 | open k (checkpointed) | R | ∅ | `unknown`, k | unchanged |
| ST9 | ∅ | R | ∅ | none | unchanged |

ST rows hold in `observing` mode for a reliable (built-in, team, or slotted) identity; `tainted`/`saturated` modes and `unknown` identities follow the W rows and D4/D5 instead — guards added beside the original rows, not changes to them.

Added literal rows:
- **A1** current Codex adapter call `mcp__dynamic__echo` (namespace-less dynamic tool, `codexEvents.ts:148–158`): label `mcp:other`, identity `unknown(ambiguous)`; a separate case from TN6.
- **A2** 9 eligible successes and 1 failure of one tool: `agent_tool_calls_total` sums to 10 (9 `success/none`, 1 `failed/<class>`), and the failure rate is 10%.
- **A3** a failed Monitor `The command was declined.` → `command-failed`; a failed Write `The file change declined.` → `other`.

### Witness rows beyond the original state machine (R1–R4)

W-rule rows, kept beside (never replacing) ST1–ST9:

| id | situation | required outcome |
|----|----|----|
| W1 | admitted c1 success (`first=true`), then a quarantined orphan result, then E | first-attempt cohort n=0/partial; c1's `first=true` row ineligible via the closure join; live prefix before the orphan reads pending, never 100% |
| W2 | c1 fails (OPEN1); c2's recording transaction rolls back; unrelated health work succeeds; c3 succeeds | one `unknown` closure fires before c3; no `recovered` fact; repeated checkpoints or turn-ends cannot duplicate it |
| W3 | approval q links to c, resolves denied before c is admitted; c then fails with no denial phrase | exactly one `denied` result (transferred to `c.deniedBeforeResult`); q stays a terminal tombstone |
| W4 | 65th distinct request id arrives | unseen record `unlinked` + `denialIncomplete=true`; the seen 64 still settle; nothing evicted |
| W5 | 513th distinct call id | SAT once: open streaks close `unknown` once, mode saturated, admitted calls still settle, c513 never eligible |
| W6 | valid row A (OPEN1) + malformed row B, recovery runs twice | A yields exactly one unknown fact; B stays byte-unchanged and blocked; no double-fold, no silent erase |
| W7 | activation with E=249,940, M=11, D=35 | 249,986 fits: every reservation and the active marker commit together; from E=249,960 (250,006) the whole set is refused, zero rows inserted, marker `budget-unavailable`/`series-budget` |
| W8 | activation marker missing or corrupt, then budget frees | `unknown` until verified; successful activation writes a NEW `availableSince`; skipped interval never backfilled |
| W9 | after W7's success (E=249,986, all paid), a new histogram labelset (cost 9); plus boundary fixtures | admitted at 249,995 (D_missing=0, no speculative reserve); an activation whose E+M+D is exactly 250,000 fits and one at 250,001 is refused; a normal labelset reaching exactly 250,000 is admitted and 250,001 collapses to the catch-all; a family at 9,999 admits one (10,000) and refuses the next; a second activation inserts nothing and keeps `availableSince` |
| W10 | warm Metrics subscription (team A and team B), numerics cached, then only `tool-export-v2` commits `budget-unavailable` | both subscriptions receive a snapshot carrying the new status within one coalesced delay with no report commit or refresh; cached numerics unchanged and the cached object unmutated; a rolled-back status write sends nothing; a failed quarantine-count write reads `unknown`, not the old stored count |
| W11 | real tracker (not P1), one live turn: 511 distinct calls with c1 left pending plus one orphan result id (512 first-seen), then c513, c514, a duplicate c2 call, c1's result, a duplicate c1 result; the turn stays live past the 14-day detail prune and a duplicate c2 result arrives | the orphan's id holds a slot; c513 fires SAT once and c514 is non-admitted with no second closure; c1 settles exactly once after SAT; every duplicate hits its tombstone and changes nothing, including after the detail prune; no slot is evicted |
| W12 | 2,501 abandoned streaks in a 3d window, page size 50, plus 3 abandoned facts committed after the first page | 51 pages, every page ≤ 50 entries, all 2,501 exactly once in order, `total` 2,501 on every page and the 3 later facts absent; a cursor reused with another slice or page size, or malformed, is refused with no entries |

### Properties

P1 (streak and taint model): seeded generator (`mulberry32`, seed `0x7001`, 300 cases) produces sequences of 1–60 events over 3 tools and 1–4 turns with F/S/O, turn ends, injected orphan results, rolled-back writes, and restarts at checkpoint boundaries; feeding them through the real tracker's event/checkpoint/recover seams must reproduce exactly what the ST table plus W1–W2 produce as a reference model, and every `tool` row's class must equal the K-table's answer for its fixture. P1 never reaches the 512/64/96 caps; W11 (and the W4/W5 table tests) cover them through the real tracker.

P2 (totals): over the same sequences, `agent_tool_calls_total` summed over labels equals the number of eligible successes plus failures (never `tool_call` rows); the streak counters equal the fact counts; pruning every detail row leaves both unchanged; when the families are budget-disabled, admitted old totals remain readable and equal their pre-refusal values with no replay.

## Risks / Trade-offs

- [Runtime wording changes and K rows stop matching] → unmatched failures fall to `command-failed`/`other`, never lost; committed fixtures cannot detect an external wording change by themselves (no private corpus or capture is committed or cited), so a drift shows as a shift toward `other` in the metrics.
- [Series growth] → tool enum capped at 96, failure_class at 9, resolution at 3; the existing 250k/10k budgets and the all-or-nothing activation gate apply.
- [Turn-scoped streaks undercount cross-turn retries] → accepted and documented; the drill shows consecutive streaks of one session.
- [Restart and recorder failures lose events] → no finite loss bound is claimed: `unknown` streaks are observed prefixes (lower bounds), and taint forbids exact claims across a gap.
- [Source loss and attribution] → Codex late-frame stamping can misattribute late frames to the current turn, with no bound on their number (disclosed); a lost event can never be reconstructed.
- [Status fan-out cost] → a status change re-sends every open Metrics subscription; status changes are rare (activation, refusal, quarantine count), coalesced, and served from the numeric cache.
- [Heuristic classes] → spoofed or drifted text shares a label with the real cause without establishing it; documented, no provenance claim.
- [Closed-only first attempts] → in-flight turns are excluded until close; reads may lag the live prefix, and say so.

## Migration Plan

No schema migration. Observations recorded before the deploy lack the tool fields and are read as `unrecorded` — counted in `n` only where fields exist, so pre-deploy history is never mistaken for zero failures; export totals start at the deploy; the export definition version is 2 and the first activation records a fresh `availableSince`. The recovery quarantine may hold pre-existing malformed live rows byte-unchanged and blocked, with the bounded count exposed through health and team metrics until an authorized policy resolves them.

## Open Questions

- None blocking here. Authorizing a recovery policy for quarantined live rows (replace, reset, or human-verified decode) is deliberately deferred and stays fail-closed until then. A schema-version detail field for comparing a tool across a fix can follow later if date comparison proves too coarse.
