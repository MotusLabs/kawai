# Tasks

## 1. Pure model

- [ ] 1.1 Add `src/server/metrics/observations/toolCalls.ts`: the identity mapping (D4: built-ins, exact team membership via the production table's names, ambiguous shapes, 96 opaque slots), the ordered anchored K0–K14 classifier (D6) with its discriminators, and the bounded turn state machine (D1/D2/D5) as a pure reference model.
  - Verify: commit FC1–FC10, TN1–TN6, and ST1–ST9 verbatim as table-driven tests in `src/server/__tests__/toolCalls.test.ts`, with one captured failure line per FC row (secrets and paths replaced). Kill these mutants: the trusted-denial check moved after the prefix checks (K1/FC1); the `Invalid arguments for ` prefix removed (K3); `No such tool available` searched past 256 characters (K7); the team-table lookup replaced by a prefix test (TN4); another tool's result closing a streak (ST5); turn end closing as `recovered` (ST6).
- [ ] 1.2 Add the taint and saturation transitions to the reference model (D5: orphan closure, gap signal, SAT, scalar flags; W1/W2/W5 semantics) and the R1 read predicate as a pure function over (detail rows, retained turn_ended).
  - Verify: table tests for W1 (c1 success + orphan + E → n=0/partial, no promotion), W2 (OPEN1 + rolled-back c2 + unrelated health success + c3 → one unknown closure, no recovered), W5 (513th id → SAT once, admitted calls still settle), duplicate-closure suppression, crash before/after the taint transaction, and a known first completion outside the cohort → n=0. Kill the mutant that reads first attempts from live turns (closed-only) and the one that treats a missing carrier as clean.

## 2. Tracker admission and storage

- [ ] 2.1 In `chatTracker.ts`, wire PC1's fences (F0–F3), carry the bounded `tm` state per live turn (512/64/96), classify on `tool_result`, close streaks at success/turn end/interruption/process end/recovery, persist the D5 scalars on `turn_ended` (90d), and watch `recorder.failures` at every accepted event and checkpoint (D3/D5).
  - Verify: P1 through the real tracker (seed `0x7001`, 300 cases; ST1–ST9 + W1/W2/W5), plus fences tests: duplicate turn start (F1), replayed start after close (F2), wrong-turn tool event (F3), and an orphan result under an admitted c1 (W1 end-to-end). Kill the mutants that admit history events, skip F2, or leave checkpointed streaks out (ST8).
- [ ] 2.2 Make `tool_streak` a 90-day fact kind in the retention lists; keep `tool` detail at 14 days; add the D5 coverage scalars to `turn_ended`.
  - Verify: a retention test shows a 20-day-old `tool_streak` surviving the prune while a 20-day-old `tool` row does not; a replay test shows the R1 predicate still excluding a tainted turn after its detail rows prune. Kill the mutant that classifies `tool_streak` as detail and the one that writes `false` defaults for a missing carrier.
- [ ] 2.3 Prove no text reaches storage: a failed result carrying a canary string must leave the canary in no observation row, checkpoint blob, source key, or label (all added state included).
  - Verify: the canary test; kill the mutant that stores `output`.

## 3. Approval-request links

- [ ] 3.1 Implement the D2 record states over the reserved optional `approval_request.toolCallId` and the existing requestId resolution: pending, denied-await-call, transferred, settled, unlinked/quarantined; cap 64 first-seen with tombstones; `denialIncomplete` bookkeeping.
  - Verify: table tests for W3 (pre-call denial transferred to the admitted call, exactly one denied result), W4 (65th id unlinked + flag, seen 64 settle), duplicate/conflicting/late resolutions, allowed and cancelled settlements, and a link to a quarantined call staying late-only. Kill the mutants that release a pre-call denial's slot, attach a late resolution to a later call, or create a denominator for a no-result card.

## 4. Recovery

- [ ] 4.1 In `service.ts`/`chatTracker.ts`, add the D9 start inventory with the per-session admission block, per-row transactions for valid cores (unrecorded recovery when no tool state, unknown closure otherwise), and quarantine for malformed/unusable/mismatched rows (byte-unchanged, blocked, restart-persistent), plus the `tool-recovery-quarantine` checkpoint write.
  - Verify: W6 end-to-end (valid A with an open streak + malformed B, recover twice: exactly one unknown fact for A, B unchanged and blocked, no double-fold); a fresh session for the quarantined row runs but records no tracker metrics; a valid-JSON scope mismatch quarantines; a rolled-back recovery leaves row and gate intact; a failed quarantine-count write leaves health unknown. Kill the mutants that delete or overwrite a bad row, fold twice, or gate on the count write.
- [ ] 4.2 Expose `health().toolMeasurement.recovery` from the bounded checkpoint (never raw JSON), and surface the same status to team metric reads.
  - Verify: health test asserting the bounded shape and the unknown-on-write-failure rule.

## 5. Export activation

- [ ] 5.1 In `registry.ts`/`boundedLabels.ts`/`accumulator.ts`: definition version 2, the three families, the 96-entry `tool` enum with exact team names in table order, `failure_class` (9) and `resolution` (3), per-family reservation replacing the early return, and `Accumulator.add` declining unadmitted values.
  - Verify: P2; the 500-foreign-names scenario collapsing to `mcp:other`; W7 (249,986 accepted; from 249,960 refused whole with no partial reservation); boundary 250,000/250,001 and family 9,999/10,000; no double reservation of admitted diagnostics; old totals readable and equal after a refusal with no replay. Kill the mutants that count `tool_call` rows, bypass the budget, or admit one family alone.
- [ ] 5.2 Add the `tool-export-v2` state machine: one-transaction preflight + reservations + first active marker, budget-unavailable refusals, unknown-until-verified, new `availableSince` on reactivation, and the service notify on committed status changes (existing debounced path; `ChatConnections.publishMetrics`).
  - Verify: no-traffic active vs budget-disabled; first upgrade; refused transaction rolls everything back; failed atomic commit leaves no marker; missing/corrupt marker reads unknown then verifies; reactivation starts a new boundary with no backfill; snapshot-gauge decline emits nothing; the 5-second text cache invalidates on a status-fingerprint change; a status change notifies through the existing path. Kill the mutants that reuse an old `availableSince`, write partial reservations, or render suppressed families.

## 6. Process metrics, status, and UI

- [ ] 6.1 Read both checkpoint keys in `loadMetricsInputs`' consistent transaction; add the bounded `toolMeasurement` status to the shared `ProcessMetrics` model and keep it in BOTH compact and full `team_metrics` projections; add the tool-only-origin observation load to `metricsQuery.ts`.
  - Verify: a tool test through the production `teamToolTable` (hazard M1) asserting the status fields and the compact size bound; a read-consistency test over the two keys.
- [ ] 6.2 Add the Tools family to `processMetrics.ts`/`computeMetrics.ts` (failure rate by tool × class, closed-cohort first-attempt success, abandoned streaks, mean failures before recovery) with the turn attribution side and the R1 exclusion rules (partial/unrecorded never counted as successes or zeros).
  - Verify: the `team-process-metrics` scenarios "Misleading schema shows up" and "Weak model gives up more" as tests, plus W1/W2 at the metric layer (tainted turns excluded, unrecorded carriers not zeros). Kill the mutants that count every call instead of each turn's first actual call, read first attempts live, or treat unrecorded rows as successes.
- [ ] 6.3 Render the family and the measurement status in the Metrics tab (collection/recovery shown separately from export unavailable/active-since); page the drill-down through the stable cursor (all abandoned reachable in ≤50 pages, total included, five longest recovered); make `useRevealRow` report `not-found`/`archived`/`unreadable` and open the first failed call.
  - Verify: client tests for "Open an abandoned streak", the paging cursor binding (window end + size + stable order, 60+ abandoned streaks), the ≤50-page bound with a total, explicit reveal outcomes, and pruning never expiring a readable anchor. Kill the mutants that reveal the last failed call, silently clear a missing anchor, or drop the total.

## 7. Docs and check

- [ ] 7.1 Update `docs/operations/process-observability.md` (families, labels, classes, bounded admission, taint, quarantine, activation states, drill paging, example alert rules) and AGENTS.md's observability bullet.
- [ ] 7.2 Run `bun run check` on the clean committed tree. The result maps FC1–FC10, TN1–TN6, ST1–ST9, W1–W8, P1, and P2 to test titles and killed mutants.
