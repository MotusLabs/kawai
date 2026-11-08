# Tasks

Every Verify clause cites its oracle ids (design.md, "Acceptance oracles")
and names the mutant each must kill. Tables are committed verbatim as
table-driven tests next to the code they cover. Each test title starts
with its row or property id. The result maps each oracle id to a test
title (`` `file` › `exact title` ``) and a killed mutant. Each test that
covers a spec scenario carries its `// @covers:` annotation.

## 1. Shared model

- [x] 1.1 Add `src/shared/reviewFindings.ts` (D2): the types,
  `parseLocus`, `classifyFinding` with an injected `matchesScope`,
  `foldLedger`, `blocking`, `pendingDisputes`, `deriveVerdict`, and
  `roundReview`. Commit table GT as
  `src/shared/__tests__/reviewFindings.test.ts`, with a `resolveCitation`
  step before `classifyFinding`. Commit tables CR and GT. Verify: CR1–CR9
  and GT1–GT10 pass. Mutants to kill:
  - looking up a clause before the revision-identity fallback (CR2);
  - checking evidence before the citation (GT2 vs GT3);
  - letting `X*` through (CR6);
  - treating an unknown scope fact as outside (GT10);
  - ignoring the fact's `outside` list (GT8);
  - accepting a stale identity (CR4).
- [x] 1.2 Commit tables VD and RO as fold-level tests in the same file.
  (The fold, the verdicts, and `planSubmission` live in
  `src/shared/findingsLedger.ts`, beside the gate, to keep both files small.)
  Verify: VD1–VD10 and RO1–RO10 pass. Mutants to kill:
  - not requiring evidence on still-open (VD6);
  - letting a disputed finding block (VD8);
  - choosing the oldest resolved match (RO5);
  - reopening a rejected finding (RO7);
  - comparing line numbers in the locus (RO1).

## 2. Storage and submission

- [x] 2.1 Add the numbered migration (D3): the four `team_task_findings`
  columns, the items, events, and cards tables, and
  `plan_execution_rounds.regate_of`. Test that migrating a database with
  old text rows keeps them byte-identical and reads them as unstructured.
  Verify: the migration test passes, and the migrations snapshot test is
  updated.
- [x] 2.2 Add `src/server/team/findingStore.ts` and
  `TaskFindingService.submit` (D4, D5). Wire it from
  `TaskResultService.submitFindings`, and extend the `task_submit_findings`
  schema for both runtimes. Commit the bounds, finality, and counting
  scenarios through the production service against a real store. Verify:
  the `review-findings` scenarios on bounds, verdict, verify rounds,
  reopen, and "One review per result counts" pass. Mutants to kill:
  - allocating ids from the counted submissions only (P2);
  - skipping the finality check after a dispute;
  - counting a non-claimant row on a plan task;
  - writing items before a verdict mismatch is refused (I3);
  - an off-by-one on the blocking cap of 50, or dropping it.
- [x] 2.3 Add property P2 (seed `0xF1ED6E5`, 300 cases) over seeded
  submission sequences. Verify: P2 passes. Mutant to kill: reuse of a
  replaced submission's ids.

## 3. Disputes and decisions

- [x] 3.1 Add `task_dispute_findings` and `task_decide_dispute` (D6) with
  the ownership check. Commit table DS. Verify: DS1–DS7 pass. Mutants to
  kill:
  - omitting the ownership check (DS6, hazard B1);
  - allowing a second dispute in the same state entry (DS2);
  - an off-by-one on the limit of 10 (DS7).
- [x] 3.2 Create one card per disputed finding through `DecisionService`'s
  internal ask path, in the dispute's transaction, and add the post-commit
  decision hook, `applyCardDecision`, and its startup replay. Commit table
  DD through the real `DecisionService` (Lead decision and owner
  override). Verify: DD1–DD7 and the `plan-decisions` scenarios pass.
  Mutants to kill:
  - restoring `accepted` instead of the state before the dispute (DD1);
  - ignoring an owner override because the finding is no longer disputed
    (DD3, DD4);
  - applying a decision to a superseded finding (DD5);
  - applying an override after a later review disposed of it (DD7);
  - dropping the `source_key` (DD6).
- [x] 3.3 Add the recovery-matrix row for the decision-hook replay, citing
  its test. Verify: `recoveryMatrix.test.ts` passes.

## 4. Re-map on publication

- [x] 4.1 Write re-map events in `TaskService`'s publication transaction
  (D9). Commit table RM through `task_amend` and the human publication
  path. Verify: RM1–RM7 pass. Mutants to kill:
  - re-mapping by clause text instead of id (RM1, RM2);
  - re-mapping a revision identity onto a contract (RM4);
  - writing events when the identity is unchanged (RM6).

## 5. Plan execution

- [x] 5.0 Add `effectiveVerdict` and use it in `taskStore.ts`'s task
  summary, so the stage, workspace, attention, and Plans readers see the
  fold's verdict. Verify: the "A rejected dispute clears fixes requested"
  scenario passes through `TaskService` reads and `teamTaskStage`. Mutant
  to kill: the summary reading the stored column.
- [x] 5.1 Make `decideVerdict` read `roundReview` from the fold. Refuse a
  text-only submission from the claimant on a plan task. Commit table RD
  through the executor tick. Verify: RD1–RD4 and the `plan-execution`
  scenarios for the review and the dispute hold pass. Mutants to kill:
  - reading the row's verdict column instead of the fold (RD2);
  - failing the round on a pending dispute (RD2).
- [x] 5.2 Add `fixFindings` and the new `fixInstruction` rendering (D7)
  for all three callers (the executor fixes step, `dispatchOwedFix`, and
  the republish path). Add the review handoff text with the blocking ids.
  Verify: the "Only blocking findings are listed" and "A verify review
  lists the open findings" scenarios pass through `dispatchOwedFix` and
  the executor. Mutants to kill:
  - listing advisory items;
  - a caller still passing raw texts;
  - losing the `legacyTexts` fallback for a pre-upgrade round.
- [x] 5.3 Add the `regateRefuted` step (D8) keyed by `regate_of`. Commit
  table RG and a crash-at-each-boundary test. Add its recovery-matrix row.
  Store the failed round's `blockingIds` (column `blocking_ids`) in `decideVerdict`. Verify:
  RG1–RG10, the "Rejected disputes re-gate" scenarios, and
  `recoveryMatrix.test.ts` pass. Mutants to kill:
  - re-gating when a blocker was superseded rather than rejected (RG8);
  - re-gating a result pinned to an older revision (RG9);
  - re-gating a CI-failed round (RG4);
  - re-gating with a newer result (RG3);
  - dropping the UNIQUE constraint (RG6).
- [x] 5.4 Send `review-p0` alerts through the stop-alert path (D10),
  keyed per round and finding. Verify: the "accepted P0 alerts" scenarios
  pass. Mutants to kill:
  - alerting on an unsupported P0;
  - sending twice on a replayed tick.
- [ ] 5.5 Add properties P1, P3, and P4 (seed `0xF1ED6E5`, 300 cases)
  over seeded command sequences through the production services and the
  executor, with a crash at each transaction boundary. Verify: P1, P3, and
  P4 pass. Mutants to kill:
  - one reader re-deriving the state (P1);
  - a decision hook without its replay key (P3);
  - `upheld` restoring a non-blocking state (P4).

## 6. Reads and client

- [x] 6.1 Add the ledger to `task_get` (bounded to 100 rows), the
  per-submission items, and the task header's findings line (D10). Verify:
  the "The ledger shows a finding's history" and "Text-only findings stay
  readable" scenarios pass, and the task_get bounds test covers
  `ledgerOlderRemaining`.
- [x] 6.2 Add the Team page task detail's Findings section and the result
  card's per-item classes, with Uphold/Reject for a non-plan task's
  creator or the human. Add client tests for the rendering, including
  unstructured rows. Verify: the client tests pass, `bun run build`
  succeeds, and the Playwright walkthrough
  `tests/e2e/task-findings-ledger.spec.ts` (structured review, dispute,
  decision, ledger) passes.

## 7. Prompts and docs

- [ ] 7.1 Update `reviewers*.md`, the dev role files, `lead.md`,
  `change-leads.md`, `docs/agent-collaboration.md` (the "Review protocol"
  section), `docs/oracle-hazards.md`, and the `docs/architecture/`
  team-tasks bullet (D11). Verify: the docs tests that read these files
  (with `@reads` headers) pass, and a grep finds no remaining "free-text
  verdict" instruction in the role files.

## 8. Integration

- [ ] 8.1 Run `bun run check` on the clean committed tree. Verify every
  ADDED or MODIFIED scenario has an `@covers` annotation (the spec
  coverage guard), and map each oracle id to a test title and killed
  mutant in the result.

## Workflow follow-up

- Archive the change after review, syncing the specs and adding the
  `@covers` annotations the archive requires.
