# Tasks

## 1. Signals (design decisions 1–2)

- [x] 1.1 Add `src/shared/reviewConvergence.ts`:
  - `reviewSnapshots(submissions, events)` with `raised`, `resolved`,
    `outOfContract`, `reopened`, and `openAfter` per counted review;
  - `convergenceWindow(snapshots, anchor)`;
  - `convergenceSignals(window, rows)` for S1–S5 with their evidence.

  Commit tables SG and WN verbatim as table-driven tests in
  `src/shared/__tests__/reviewConvergence.test.ts`. Verify:
  - SG1/SG2 kill "count any reopen";
  - SG3/SG4/SG5 kill "key S2 on the clause key" (revision citations would
    count);
  - SG6/SG8 kill "drop raised ≥ 1";
  - SG9/SG11 kill "drop newest > 0";
  - SG12/SG13 kill "one review suffices";
  - WN3 kills "filter by hash instead of the trailing run";
  - WN6 kills "compare the whole identity instead of its hash".
- [x] 1.2 Add `@covers` annotations for each `review-convergence` signal and
  window scenario above the tests from 1.1, and verify that
  `specCoverageGuard.test.ts` passes.

## 2. Backstop setting (decision 3)

- [x] 2.1 Parse `planExecution.maxFailedFixRounds` in `teamCaps.ts` (2–20,
  default 5, malformed values logged), record it at Start as
  `max_failed_fix_rounds` (migration default 5), and pass it to
  `fixRoundOutcome(count, round, limit)`, which returns `{ count, backstop }`.
  Remove `ROUND_LIMIT` and the `round-limit` write, and make the fix
  instruction read "of <limit>". Verify, with tests for the "An
  out-of-range backstop falls back" and "A passing round resets the count"
  scenarios:
  - A7 kills "keep the limit at 3";
  - A7 kills "read the setting at tick time instead of Start" (a change of
    `teams.json` mid-run must not move a running execution's limit).
- [x] 2.2 Make Retry run a fix attempt for `diagnosis-escalated`, keeping
  `round-limit` for stopped rows, and add the `diagnosis-escalated` stop
  reason and its label. Verify "Retry after an escalated diagnosis" and
  "Retry after the round limit": A8 kills "count continues across Retry".

## 3. The Kawai-asked diagnosis card (decision 6)

- [x] 3.1 Add `kind` to cards (default `'question'`) and
  `DecisionService.raiseDiagnosis(input, within)`. It asks as Kawai, is
  addressed to the Lead role else the owner, and sends a system mail tagged
  `decision-question`, `plan-stall`, and `stall:convergence` as the card's
  `messageId`. Build the option list in the spec's order. Verify A4 with
  the "Options of a stagnating change", "Scope pressure names nothing to
  reject", "The Lead receives a diagnosis", and "No Lead role" scenarios:
  - kills "skip the Reject cap of ten";
  - kills "route like `askForTask`" (a Lead-group exemption would send it
    to the owner).
- [x] 3.2 Make `resolveChoice` refuse free text on `kind = 'diagnosis'` for
  `record`, the owner's answer, and the owner's override, and make `record`
  send no answer mail for it. Verify "A free-text choice is refused" for
  all three callers: A4 kills "check only the agent path".

## 4. Opening a diagnosis (decisions 4, 5 intro)

- [x] 4.1 Add the `plan_execution_diagnoses` table, the `diagnosing` step,
  and the open step in `applyFix`, in one transaction: the row, the card,
  the stall-alert row, the transition, and the journal entry. In the
  planner, emit `diagnosis` instead of `fixes` for `gating`/`diagnosing`.
  Commit table DO as table-driven tests over the matrix harness. Verify:
  - DO1–DO7, each asserting rounds, attempts, diagnoses, cards, and mail;
  - DO4 kills "signals only, no backstop for CI-only rounds";
  - DO6 kills "drop `UNIQUE(round_id)`";
  - DO7 kills "ignore the anchor".
- [x] 4.2 Add a recovery-matrix row for "a crash inside the diagnosis open
  step" citing a test that throws after the card insert and asserts that
  nothing is stored and that the next tick opens exactly one. Verify that
  `recoveryMatrix.test.ts` passes, and that the test kills "commit the card
  outside the open transaction".

## 5. Applying outcomes (decisions 5, 7)

- [x] 5.1 Implement the `diagnosis` stage and the five outcomes:
  - `group_override` on change rows, read by every fix or update dispatch
    and by Retry;
  - `insertRegateRound(failed, failed.attemptId)` (the failed round's own attempt);
  - ledger `rejected` events that carry the card and decision ids;
  - the previous implementer's release after `Reassign`.

  Commit table DX verbatim as table-driven tests through the production
  executor composition with the real `DecisionService`. Verify:
  - DX1–DX10 (spec "Fix round sends the fix…", "Reject rejects…", "Amend
    the contract waits…", "Reassign sends the fix…", "Escalate stops…",
    "The first decision of an open diagnosis applies");
  - DX1 kills "apply the decision before the revision check";
  - DX4/DX5 kill "always re-gate after Reject";
  - DX7 kills "re-apply `amend` each tick" (a second journal entry);
  - DX8 kills "apply only the first decision";
  - DX9 kills "override only this fix's group" (the next attempt must go
    to `g` too);
  - one DX3 run with the planner's `diagnosis` stage unwired kills M1.
- [x] 5.2 Add the crash rows for DX3, DX5, and DX9 (a throw after the
  dispatch, before the close), snapshotting every round, attempt, mail,
  ledger event, and diagnosis row around the replay. Add recovery-matrix
  rows for "a decision committed but its outcome not applied" and "an
  `amend` wait across a restart". Verify I2:
  - kills "close before dispatch";
  - kills "unkeyed fix dispatch";
  - `recoveryMatrix.test.ts` passes.
- [x] 5.3 Journal an override or decision after the close, and dispatch
  nothing. Verify "An override after a fix round went out": I5 kills
  "apply the newest decision whatever `closed_at` says".

## 6. Supervision and attention (decision 8)

- [x] 6.1 Add the following:
  - `structuredReview` on `SupervisionRound` and its use in
    `failureSignature`;
  - `diagnosis` on `SupervisionInput`;
  - the `convergence` stall, ahead of `repeating-failure`;
  - the `contract-revision` wait;
  - the cause and stop labels.

  Verify, with tests for "A diagnosis names its signals", "Waiting for the
  amended contract", and "Two failed structured reviews":
  - A5 kills "keep `review:fail` for structured rounds";
  - A5 kills "convergence after repeating-failure".
- [x] 6.2 Make the stall-alert sweep find the convergence episode written at
  open and send nothing, and make `planAttention.ts` emit the card's item
  only, then **Publish a task revision** after `amend`. Verify "A diagnosis
  sends one message" and "The amended contract needs the owner":
  - A5/A6 kill "the sweep alerts convergence like any stall" (two
    messages);
  - A5/A6 kill "a stall item beside the card item".

## 7. Plans view (decision 9)

- [x] 7.1 Add `convergence` to `ExecutionChangeView` from the shared module,
  and render the count line and the signals in `PlanExecutionChangeRow.tsx`.
  Verify "A converging change" with a client test: A9 kills "count every
  review instead of the window".
- [x] 7.2 Add a Playwright spec. In the fixture plan, failed structured
  reviews open a diagnosis, and the spec sees the convergence stall, the
  card with its options, and the count line. Run `bun run build`, then the
  spec. Verify V5: kills "row renders nothing for an open diagnosis".

## 8. Manual-task notice (decision 10)

- [x] 8.1 Add `team_task_convergence_notices` and the notice in
  `TaskFindingService` after a counted review on an unowned task: one
  transaction for the row, the journal entry, and the mail to a session
  creator. Verify "A manual task churns":
  - A10 kills "notice on owned tasks too" (two messages for a plan change);
  - A10 kills "no primary key" (a replayed submission notices twice).

## 9. Properties (V4)

- [ ] 9.1 Add the executor-seam properties P1 and P3 (seed `0xC0FE1D`, 24
  cases, a crash at each transaction boundary of the open step and the
  outcome), and the service-seam property P2 (300 cases), in
  `*.integration.test.ts` files. Verify:
  - each tallies DO and DX paths reached (open, each outcome, a crash);
  - P1 kills "drop the closed guard";
  - P2 kills "a signal writes `rejected` without a decision";
  - P3 kills "dispatch the fix and open the diagnosis".
- [x] 9.2 Add P4 (seed `0x5161A1`, 300 ledgers): `executionView`'s counts
  and the executor's signals equal the shared module's on the same input.
  Verify that I3 kills "the view re-derives `openAfter` from round
  `blockingIds`".

## 10. Prompts and docs (decision 11)

- [x] 10.1 Make the following edits:
  - in `lead.md`, replace the two-correction-rounds bullet with a pointer
    to the playbook and the diagnosis card's tools;
  - give `change-leads.md` the same pointer;
  - replace `reviewers.md`'s "retain the two-unsuccessful-correction-round
    escalation" sentence;
  - add the "Convergence" paragraph to `docs/agent-collaboration.md`'s
    "Review protocol";
  - update the `docs/architecture/plan-execution.md` and
    `plan-supervision.md` bullets.

  Extend `reviewProtocolDocs.test.ts` to check:
  - no role file holds "two unsuccessful correction rounds" or "two
    correction rounds";
  - the playbook appears once, in the protocol section;
  - `lead.md` and `change-leads.md` name `Amend the contract` and the
    signals.

  Verify A11: kills "the playbook copied into a prompt" (twice).

## 11. Integration

- [ ] 11.1 Add `@covers` annotations for every ADDED and MODIFIED scenario
  of the four delta specs. Check that no test cites the removed
  requirement. Map each oracle id (SG, WN, DO, DX, P1–P4) to its test title
  and killed mutant in the result. Run `openspec validate
  review-convergence --strict` and `bun run check` on the clean committed
  tree, and verify that both pass.

## Workflow follow-up

- Archive the change after review, syncing the four delta specs, and add
  any coverage annotations the archive's coverage rule asks for.
