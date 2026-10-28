# Design

## Context

Source facts at this branch's base (`0bff6f6f`, `src/` unchanged since): the tracker has one production producer — `ChatSessionManager.handleDriverEvent` (3376–3383), fed by driver `onEvent` (2783); the synthetic notice path (2180) never reaches it, and transcript replay populates history only. Both drivers mint fresh `turn-<uuid>` ids per turn and fresh event ids per emit; the manager reassigns the wire sequence, so it is not durable authority. Pruning deletes `chat:`/`segment:`/`turn-end:` keys with their rows by `recorded_at`; `turn_ended` is a 90-day fact kind with an indexed `turn_id`, written by `finish()` in one transaction that also deletes the live row. `ObservationRecorder.failures` already increments on every `safe()` catch and is never reset when the generic gap clears — a process-lifetime indicator. `process_collection_checkpoints` is the existing fixed key/value carrier. `service.health()` reports recording/failure/gap state but has no tool-export field; the renderer omits families without samples entirely; `MetricsSnapshot` gauges and its 5-second text cache exist; status changes can ride the existing debounced notify (250 ms) and `ChatConnections.publishMetrics`. `loadMetricsInputs` already reads team tables in one consistent transaction.

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
- Any total-memory or byte-size guarantee; only added logical entries, checkpoint, and clone work are bounded.
- Attention items, alerts sent by Kawai, or automatic changes; a ledger; a retention increase; a new Prometheus family; a repair UI or DB rewrite.
- Subagent (Task) tool calls, which the event stream does not carry.

## Decisions

### D0 — Producer contract PC1 and admission fences

Live-driver path only: transcript replay and history never enter the tracker. Fences, all checked before any mutation of current state:
- **F0** the existing event-key dedupe;
- **F1** a `turn_started` whose id equals the live turn's is a duplicate: dropped, never finish+reopen;
- **F2** a `turn_started` for a turn with a retained `turn_ended` row is rejected (90-day window);
- **F3** tool/approval events go only into the live turn with the matching id (wrong-turn guard runs pre-mutation).

Totals never decide admission. Disclosed limit: Codex stamps late item frames with the current Kawai turn, so one upstream physical call can be misattributed (counted once for the accepted (session, KawaiTurn, callId)); no stale-frame driver guard exists or is granted. A replay older than the retained window is out of contract (renaming a closed turn to a fresh id is indistinguishable from a fresh turn; bounded state cannot reject it).

### D1 — Bounded per-turn call state (512 first-seen ids)

Live turn field `tm.calls`: `callId → {identity, outcome: pending|success|failed, failureClass?, denial?}`, capped at **B_ids = 512 first-seen ids**. Every admitted call — or any first-seen pending/terminal/quarantined id, including an orphan result's id — reserves a tombstone slot; nothing is evicted while the turn is live, everything is discarded at close (then fenced by the retained facts). A new call at the cap is non-admitted (`nonAdmitted++`); the first such call fires **SAT**: open streaks close `unknown` once (lengths are the observed prefix), no streak opens again this turn, and already-admitted pending calls still settle exactly once. Duplicate calls are ignored; a duplicate or conflicting result never mutates a settled call.

### D2 — Approval-request links (64 first-seen records with tombstones)

Metric-owned request records are **first-seen ids retained until E/R** (no capacity is reclaimed mid-turn; the existing UI/timing request map is untouched). Finite states per record: `pending(callId)`, `denied-await-call(callId)`, `transferred(callId)`, `settled-allowed|cancelled(callId)`, `unlinked|quarantined(callId?)`. The q→c binding is immutable. A linked approval before the call reserves `pending` under **B_link = 64**; a denial resolved before the admitted call exists becomes `denied-await-call`, still occupying its slot. When the call is admitted, any prior actual denial transfers to `call.deniedBeforeResult` and the record stays as a terminal `transferred` tombstone. The failed-result gate still precedes trusted denial — a success is a success. First resolution wins: duplicates, conflicts, and late resolutions never mutate a settled call or reopen a record. An unknown resolution before a known approval cannot be guessed into a denial: reserve `unlinked|quarantined` when possible and set `denialIncomplete`. At the cap an unseen record stays `unlinked` with `denialIncomplete=true`; the seen 64 still settle. Associations to quarantined, non-admitted, or terminal calls are `unlinked` or late-only and never fabricate a call or result; no-result cards create no denominator. Correlation uses only the reserved optional `approval_request.toolCallId` and the existing requestId resolution.

### D3 — Rollback and the recorder-failure gap signal

Every tracker event writes the observation row and mutates ALL added memory (calls, links, markers, streaks, slots, flags) inside the tracker's existing transaction; a throw rolls the database and every map back together, the event is lost, and `recorder.safe` records the failure. `processEnded`/restart/replacement close the live turn and discard its maps; a restart is not proof of uninterrupted history. The taint watch (D5) compares a turn-scoped `seenRecorderFailures` snapshot against the existing `recorder.failures` at every accepted live-turn event and checkpoint, including immediately before turn end; a fresh turn initializes it from the current usable value. An advanced counter, or an unusable comparison, is a recording gap for this turn.

### D4 — Identity versus label (96 opaque live slots)

The raw tool name stays memory-only. Identity: CLI built-ins by name; exact `kawai-team` catalogue members by name; `mcp__dynamic__x` (the namespace-less dynamic call and a real server `dynamic` collide at `codexEvents.ts`), names with two or more extra `__` separators, collapsed collab/sub-agent tools, and empty names are `unknown(ambiguous)`; any other distinct raw name takes one of at most **96 opaque per-turn slots**, kept once assigned; the 97th distinct name is `unknown(overflow)`. `unknown` results still count in eligible totals but never enter any streak reducer; failures on them mark identity incomplete. The public export label (`tool` enum) is separate and coarser; label equality (two names exporting `mcp:other` or `other`) never heals identity. The slot map rides D3 rollback and dies at turn close.

### D5 — Two marker owners, taint, and the first-attempt read predicate

**Owner 1 — first attempt:** per (turn, exact team tool), set by the FIRST ACTUAL call in call order (not the first admitted call), never promoted; it resolves at that call's first eligible result and freezes there. **Owner 2 — per-streak first failure:** set at streak open from the opening failed result (callId, time, seq), cleared at closure, set anew by the next failure, frozen into the `tool_streak` fact.

**Taint (R1):** live turn scalars `firstHistoryUnknown: boolean`, `streakMode: observing|tainted|saturated`, `seenRecorderFailures: number`, `denialIncomplete: boolean`, monotone within the turn. A quarantined orphan result, or the D3 gap signal, before any normal streak handling: close all open named streaks `unknown` once, set `firstHistoryUnknown=true`, switch to `tainted`, open no further streaks this turn; admitted calls may still settle their one normal result, and no orphan result becomes eligible later. At R/process-loss/replacement the same unknown closure applies. Nothing is subtracted from already-committed lifetime counters; SAT keeps its monotonic rules and composes with taint.

**Carrier:** E/R writes scalars `toolCoverageVersion=1`, `toolFirstHistoryUnknown`, `toolStreakTainted`, `toolDenialIncomplete` on the existing `turn_ended` fact (90d), beside the existing coverage/missing-first fields. A missing or version-invalid carrier is `unrecorded`, never `false`; old or absent state closes unrecorded and no zero-length streak is invented.

**Read predicate (closed-turn only):** a detail row is first-attempt eligible when it is the unique eligible completed success/failed FIRST ACTUAL call of its (session, turn), its completion is inside the window, AND a valid retained `turn_ended` for that turn exists in the SAME read snapshot with version 1 and `toolFirstHistoryUnknown=false`. The closure joins by identity even when `closedAt` lies outside the window. Unclosed turns are pending and excluded; tainted, legacy, missing-carrier, or unavailable firsts are excluded as partial/unrecorded, never counted as successes or zeros; another result is never promoted. A known first completion before the window is an ordinary n=0 exclusion, not missing history. Earlier `first=true` rows stay immutable; after a taint the closure join invalidates their eligibility. The 90-day carrier outlives the 14-day detail and supports the 7d+7d window pair; no longer detailed history is claimed.

### D6 — Classifier (K0–K14, ordered, anchored)

For a failed result, the first matching row wins. All matches are anchored at the start of the **untrimmed** output. `H` marks heuristic labels; the classifier never claims causal provenance, and a success is always K0 regardless of its text.

| K | match on failed output | class |
|----|----|----|
| K0 | result is success | success — no class, no export (even with spoofed failure text) |
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
| K11 | Bash/Monitor and starts `The command was declined.` | `denied` (H) |
| K12 | Edit/Write/MultiEdit and starts `The file change declined.` | `denied` (H) |
| K13 | Bash or Monitor otherwise | `command-failed` |
| K14 | otherwise | `other` |

Discriminators: a generic handler error such as `Unknown team: t1` is `other`, not `refused`; a declined command with an empty `aggregatedOutput` is `command-failed` unless a denial is actually linked; `The file change failed.` is `other`; missing/image-only/non-text empty output is `command-failed` for Bash/Monitor and `other` otherwise. An unlinked denial, a card with no result, or a cancellation creates no result row. Class membership uses the detail/canonical identity, never a budget-overflow export label. Cancelled/late links alone are not denial; the failed-result gate precedes K1.

### D7 — Storage, retention, drill-down paging, reveal

`tool` rows gain `identity`, `label`, and, when failed, `failureClass` (14-day detail — enough for a 7d window plus its 7d baseline). `tool_streak` is a 90-day fact kind `{ tool, length, resolution, firstCallId, firstAt, closedAt }` with the turn's attribution identity and a stable ephemeral key. Raw names, inputs, outputs, and corrupt JSON are never stored, logged, or copied into diagnostics; canaries cover every added state, rollback map, checkpoint serialization, source key, and label.

Drill-down: every abandoned streak of the window is reachable through at most **50 pages** behind a stable cursor that binds team, slice, the window's END, and page size (plus a snapshot/high-water boundary when stable totals across concurrent inserts are claimed); the response carries the total. The five longest recovered streaks come sorted by length desc, then `closedAt`, then stable fact id. An offset against a moving `now` is not a valid cursor. The default `team_metrics` projection stays compact (below 32 KB) with the requested inline drill capped at 50 plus the total.

Reveal anchors stay `tool:<firstCallId>`; `useRevealRow` reports `not-found`, `archived`, or `unreadable` explicitly instead of silently clearing, and observation pruning alone never declares an otherwise-readable transcript anchor expired.

### D8 — Export families v2 behind an activation gate

Definition version 2 installs three families — `agent_tool_calls_total` (team, group, provider, model, tool, outcome, failure_class), `agent_tool_failure_streaks_total` (+ resolution), `agent_tool_failure_streak_length` (buckets 1, 2, 3, 4, 6, 10, +Inf) — with `tool` capped at 96 enum entries (`other`, `mcp:other`, 18 built-ins, at most 76 exact team names in table order; excess collapses to `other` with the existing overflow diagnostic; detail identity stays exact). `seriesCost(histogram) = buckets + 2`; catch-alls cost 11; the reserve grows 32 → 35; the early-return bypass is replaced by per-family reservation: overflow labelset first, then catch-all, each within the 250,000 series / 10,000 per-family budgets.

Activation (R4): one transaction runs the full E+M+D preflight, inserts every missing `INSERT OR IGNORE` reservation, and writes the first active marker for the fixed checkpoint key **`tool-export-v2`**: `{version: 1, definitionVersion: 2, state: active|budget-unavailable|unknown, reason: null|series-budget|family-budget|missing-reservation|invalid-checkpoint, availableSince: ISO|null, changedAt: ISO}` — no per-label history, no new Prometheus family, only the current continuous interval. `availableSince` is the store's now at that success. A valid already-active marker keeps its boundary only while all reservations remain valid for the same definition/budget. Budget refusal writes only the fixed unavailable status (`availableSince=null`), never partial reservations; already-admitted old values keep incrementing, no new labelset is admitted, all three families stop together, and the refusal is not thrown into chat recording. Missing/malformed status is `unknown` until reservation verification; a later successful activation starts a NEW `availableSince` with no backfill, reset, or replay of skipped results; earlier history stays unknown.

Wiring: `Accumulator.add` declines before writing unadmitted values; `MetricsSnapshot` gauges use the same admission result and emit nothing for declined labels; snapshot totals never render unadmitted samples and the three families are suppressed while unavailable, preserving their stored values; the renderer's omission of empty families is preserved (no zero samples, no diagnostic family are fabricated). `service.health()` gains `toolMeasurement: { export, recovery }`; `loadMetricsInputs` reads BOTH fixed checkpoint keys in its consistent transaction and the shared `ProcessMetrics` model carries the same bounded status; `team_metrics` keeps the status in BOTH compact and full projections (compact stays under 32 KB). The status is refreshed at every returned metrics response even when numerics are cached, the 5-second text cache invalidates on a status-fingerprint change, and a committed status change notifies through the existing debounced service notify and `ChatConnections.publishMetrics` path — no new polling framework and no service→mailboxTools import.

### D9 — Recovery: per-row, admission block, quarantine

Before the first new metric admission of a process start, the service inventories `process_live_observations`. Each session with an unrecovered row is blocked from tracker event/save/checkpoint mutation until that row resolves; app execution continues and other sessions record. Each row is validated as a legacy core — session/scope agreement, usable turn and time maps, supported turn-state structure — not merely `JSON.parse` success. A valid core with no tool state recovers once as `unrecorded` (unknown closure, correct decoded identity, `turn_ended` coverage, restart gap, row delete — in its OWN transaction; commit then unblock, rollback leaves row and gate intact, retries ride the existing checkpoint cadence, and a second recovery cannot double-fold). A present-but-unusable tool state, a malformed core, or a scope mismatch is **quarantined**: the row stays byte-unchanged, the session stays blocked (no fresh start may silently overwrite the unknown identity), no turn id or fact is invented, no raw JSON is copied, and quarantine persists across restart because the evidence row remains. Resolving it requires a separately authorized recovery policy — none is built here. One fixed checkpoint key **`tool-recovery-quarantine`** holds only `{version, quarantinedCount, pendingCount, status, checkedAt}`; a failed count write leaves recovery health unknown (not zero), and the gate never depends on that write.

## Acceptance oracles

Inputs FC1–FC10, TN1–TN6, and ST1–ST9 are the original blind-derivation input ids (immutable blind record; not restated here). Their normative expected outputs below are explicit Lead policy corrections (D5/D6; notes 6bbd56f1 and acfec826), not a new blind pass. FC5's unavailable rows split into K6/K7/K8; a recalled `InputValidationError` wrapper is `precondition` (K9); a success keeps class none even with a linked denial or spoofed text (K0 — the old "unreachable" note becomes a reachable-but-success row); TN4 (`mcp__kawai-team__not_a_tool`) is not an exact member, so its label policy is `other` with an opaque slot identity, not `mcp:other`; TN6 (collapsed `echo` emission) stays `other` with `unknown(ambiguous)` identity.

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
| W7 | series budget: E=249,940 then +11 catch-alls +35 diagnostics | 249,986 fits (active); from E=249,960 the same reservation is refused as one unit with no partial reservations |
| W8 | activation marker missing or corrupt, then budget frees | `unknown` until verified; successful activation writes a NEW `availableSince`; skipped interval never backfilled |

### Properties

P1 (streak and taint model): seeded generator (`mulberry32`, seed `0x7001`, 300 cases) produces sequences of 1–60 events over 3 tools and 1–4 turns with F/S/O, turn ends, injected orphan results, rolled-back writes, and restarts at checkpoint boundaries; feeding them through the real tracker's event/checkpoint/recover seams must reproduce exactly what the ST table plus W1–W2 produce as a reference model, and every `tool` row's class must equal the K-table's answer for its fixture.

P2 (totals): over the same sequences, `agent_tool_calls_total` summed over labels equals the number of eligible results (never `tool_call` rows); the streak counters equal the fact counts; pruning every detail row leaves both unchanged; when the families are budget-disabled, admitted old totals remain readable and equal their pre-refusal values with no replay.

## Risks / Trade-offs

- [Runtime wording changes and K rows stop matching] → unmatched failures fall to `refused`/`command-failed`/`other`, never lost; fixture rows pinned from captured text fail visibly on a runtime update (fixtures are re-derived from captured lines with secrets and paths replaced; no private corpus is committed or cited).
- [Series growth] → tool enum capped at 96, failure_class at 9, resolution at 3; the existing 250k/10k budgets and the all-or-nothing activation gate apply.
- [Turn-scoped streaks undercount cross-turn retries] → accepted and documented; the drill shows consecutive streaks of one session.
- [Restart loses up to one checkpoint interval of failures] → `unknown` streaks are labelled lower bounds; no 30-second bound is claimed beyond the existing cadence.
- [Source loss] → Codex late-frame stamping can misattribute one call (disclosed, bounded); a lost event can never be reconstructed, so taint forbids exact claims across gaps.
- [Heuristic classes] → spoofed or drifted text shares a label with the real cause without establishing it; documented, no provenance claim.
- [Closed-only first attempts] → in-flight turns are excluded until close; reads may lag the live prefix, and say so.

## Migration Plan

No schema migration. Observations recorded before the deploy lack the tool fields and are read as `unrecorded` — counted in `n` only where fields exist, so pre-deploy history is never mistaken for zero failures; export totals start at the deploy; the export definition version is 2 and the first activation records a fresh `availableSince`. The recovery quarantine may hold pre-existing malformed live rows byte-unchanged and blocked, with the bounded count exposed through health and team metrics until an authorized policy resolves them.

## Open Questions

- None blocking here. Authorizing a recovery policy for quarantined live rows (replace, reset, or human-verified decode) is deliberately deferred and stays fail-closed until then. A schema-version detail field for comparing a tool across a fix can follow later if date comparison proves too coarse.
