# Proposal

## Why

Plan execution stops a change after three consecutive failed fix rounds,
whatever those rounds achieved. The only repeating-failure stall compares
failure signatures: the failing check names plus `review:fail`. Every
failed review therefore has the same signature, so a converging change
(5 open blocking defects, then 3, then 1) and a diverging one (3, then 3
new ones, then 3 again) look identical. The cap cuts off work that is
converging, and it lets diverging work spend its rounds instead of
diagnosing why. Limiting rounds treats the symptom. This change measures
convergence as unresolved, validated blocking defects, over the
`review-findings-ledger` ledger. When convergence stalls, it routes the
change to a diagnosis by whoever owns the contract, rather than to another
developer–reviewer round. This is the third of three changes toward a
convergent review protocol.

## What Changes

- **Convergence signals,** computed by Kawai over the findings ledger when
  a round fails on its review. Each reads only the task's counted reviews
  under the current contract since the last diagnosis:
  - **S1, oscillation:** the newest review reopens a finding that had
    already been reopened once.
  - **S2, moving clause:** in each of the last two reviews, a finding on
    one contract clause was resolved and a new blocking finding on the
    same clause was raised. Fixing the clause in one place breaks it in
    another, which suggests the clause is underspecified.
  - **S3, churn:** over the last two reviews, the blocking findings raised
    (new or reopened) are at least as many as those resolved.
  - **S4, stagnation:** the open blocking count did not fall across the
    last three reviews.
  - **S5, scope pressure:** each of the last two reviews raised an
    out-of-contract finding.
- **A diagnosis instead of another fix round.** When a signal fires, or
  the backstop is reached, Kawai dispatches no fix. It raises a decision
  card to the plan's Lead role (else the owner) naming the signals, the
  findings involved, their clauses, and the open count per review. The
  change waits, shown as stalled on convergence, until the card is
  decided. Its options:
  - **Fix round:** send the fix as usual, with the decision's rationale;
  - **Reject** the named blocking findings: the round passes again when
    nothing else blocks, else a fix round goes out for the rest;
  - **Amend the contract:** the owner is asked to publish a new task
    revision, and the change waits for it;
  - **Reassign** the fix to another group the plan names;
  - **Escalate:** the change stops for the owner.

  A signal never accepts or rejects a finding by itself.
- **A backstop replaces stop-at-3.** No fixed round count stops a change.
  When the failed fix rounds since the last pass or diagnosis reach the
  team's `planExecution.maxFailedFixRounds` (default 5), a diagnosis opens
  instead. The owner's Stop and Retry keep working as today.
- **Supervision shows the signals.** An open diagnosis is the stall kind
  `convergence` with its signals as evidence. Its card's message is the
  episode's one `plan-stall` alert. The review part leaves the
  repeating-failure signature for structured reviews. The Plans view shows
  each change's open P0/P1 count by review.
- **Manual tasks** get the signals as a journal entry and one message to
  the task's creator; nothing waits.
- **Prompts.** `lead.md` and `change-leads.md` gain a diagnosis playbook:
  - S2 means the contract is underspecified on that clause, so amend it;
  - S5 means the reviewer is pushing outside the contract, so amend the
    contract or keep the fix within it;
  - S3 and S4 mean the approach is wrong, so require a different approach
    or reassign;
  - S1 means the fixes undo each other; ask for an invariant-based plan.

  The two-correction-rounds escalation text in `lead.md` and
  `reviewers.md` is replaced by the signals.

## Capabilities

### New Capabilities

- `review-convergence`: the signals over the ledger and their window, the
  diagnosis episode and its card's outcomes, and the manual-task notice.

### Modified Capabilities

- `plan-execution`: "Three consecutive failed fix rounds stop the change"
  is removed, replaced by the configurable backstop that opens a
  diagnosis. "A failed round returns the change for fixes" now applies
  only when no diagnosis opens. Retry learns the `diagnosis-escalated`
  stop, and the execution settings gain `maxFailedFixRounds`.
- `plan-supervision`: "Repeating failures stall" no longer counts a
  structured review in its signature. The new stall kind `convergence`
  sends its alert through the diagnosis card, and has one attention item
  with it. The Plans view shows the open count by review.
- `plan-decisions`: Kawai raises the diagnosis card in its own name, with
  the outcome options.

## Impact

- **Server:**
  - `src/shared/reviewConvergence.ts`: the signals (new, pure);
  - `src/server/plans/execution/executor.ts` (`applyFix`), the planner,
    and a new diagnosis step: the backstop and the outcomes;
  - `src/shared/planSupervision.ts` and `src/server/plans/supervision/`:
    the stall kind and its alert;
  - `src/server/plans/decisions/`: the Kawai-asked card;
  - `src/server/team/teamCaps.ts`: the setting.
- **Client:** the Plans view's change row shows the open count line and
  the diagnosis.
- **Prompts and docs:**
  - `lead.md`, `change-leads.md`, `reviewers.md`;
  - `docs/agent-collaboration.md`, `docs/architecture/plan-execution.md`,
    `docs/architecture/plan-supervision.md`;
  - `docs/recovery-matrix.md`: the diagnosis is a wait state that must
    survive restart, so it gets matrix rows.
- **Depends on:** `review-findings-ledger` and `implementation-contract`,
  both archived.
- **Decided:**
  - only the owner publishes the amended contract;
  - S2 needs no new finding field;
  - the backstop is a user-level execution setting.
- **Overlap:** `team-workspace-redesign` D5's `rework-stuck` item counts
  failed review rounds. That change is not edited here. When it is
  implemented, its predicate should read an open convergence diagnosis.
