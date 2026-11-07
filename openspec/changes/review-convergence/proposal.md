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

- **Convergence signals,** computed by Kawai over the findings ledger after
  each verify round:
  - **S1, reopened finding:** a finding id reaches `reopened` twice, or a
    resolved clause and locus comes back.
  - **S2, contradiction:** two findings are linked by `conflicts_with`
    (set by the reviewer or the developer). Two accepted findings on the
    same clause are surfaced as candidates.
  - **S3, churn:** over the last two rounds, new accepted P0/P1 findings
    are at least as many as resolved ones.
  - **S4, stagnation:** the count of open accepted P0/P1 findings is not
    lower after two consecutive revisions.
  - **S5, scope pressure:** out-of-contract findings in two consecutive
    rounds.
- **A DIAGNOSE state.** When any signal fires, the change does not get a
  fix dispatch. Kawai opens a decision card to the plan's Lead role, or to
  the task creator for manual work. The card names the signal, the
  findings involved, their clauses, and the ledger's open-count history.
  It offers these outcomes:
  - accept or reject named findings;
  - amend the contract (a new task revision; the ledger re-maps);
  - reassign the change to another developer or group;
  - escalate to the owner.

  The change waits in DIAGNOSE until the card is decided. A signal never
  leads to automatic acceptance.
- **A backstop replaces stop-at-3.** There is no hard stop while the open
  P0/P1 count keeps falling. A backstop at 5 consecutive failed fix rounds
  opens a DIAGNOSE card with the ledger attached, instead of stopping the
  change. The owner's Stop and Retry keep working as today.
- **Supervision shows the signals.** Each signal is a stall kind with its
  evidence, and the Plans view shows each change's open P0/P1 count by
  round, next to the existing progress and stall display. Each DIAGNOSE
  episode sends one `plan-stall` alert to the Lead role, as for existing
  stalls.
- **Prompts.** `lead.md` and `change-leads.md` gain a diagnosis playbook:
  - contradicting findings on one clause mean the contract is
    underspecified there, so amend it;
  - S5 means the reviewer is pushing outside the contract, so reject or
    move the findings to a follow-up proposal;
  - churn means the approach is wrong, so require a different approach or
    reassign;
  - repeated disagreement about module boundaries is an architecture
    question, not a fix round.

  The two-correction-rounds escalation text in `lead.md` and
  `reviewers.md` is replaced by the signals.

## Capabilities

### New Capabilities

- `review-convergence`: the signal definitions over the ledger, the
  DIAGNOSE state and its card, its outcomes, and the backstop.

### Modified Capabilities

- `plan-execution`: "Three consecutive failed fix rounds stop the change"
  is replaced by the signal-driven DIAGNOSE and the 5-round backstop.
  "A failed round returns the change for fixes" now applies only when no
  signal fired.
- `plan-supervision`: "Repeating failures stall" gains the convergence
  stall kinds (S1–S5 and the backstop) with their evidence, and "A stall
  alerts the Lead role once per episode" covers DIAGNOSE episodes.
- `plan-decisions`: DIAGNOSE cards with the four outcomes. Deciding
  "amend the contract" or "reassign" leads to the corresponding action.

## Impact

- **Server:**
  - `src/server/plans/execution/executor.ts` (`fixRoundOutcome`) and
    `executionRounds.ts`: the cap and the DIAGNOSE transition;
  - `src/shared/planSupervision.ts`: the stall kinds, replacing the coarse
    `failureSignature` for reviews;
  - `src/server/plans/supervision/`: the alerts;
  - `src/server/plans/decisions/`: the cards.
- **Client:** the Plans view's per-change convergence line and the DIAGNOSE
  card.
- **Prompts and docs:** `lead.md`, `change-leads.md`, `reviewers*.md`,
  `docs/agent-collaboration.md`, and `docs/recovery-matrix.md` (DIAGNOSE is
  a wait state that must survive restart, so it needs a matrix row).
- **Depends on:** `review-findings-ledger` (the ledger and finding states)
  and `implementation-contract` (contract revisions for the "amend"
  outcome).
- **Open problem, to resolve in design:** execution tasks are created by
  Kawai, so only the human can publish a new revision of them. The plan's
  Lead role therefore cannot carry out an "amend the contract" outcome
  itself. The options:
  - let a decision by the Lead role authorize Kawai to publish the
    contract revision the card proposes;
  - make the amend outcome a card addressed to the owner;
  - make the Lead role a co-creator of execution tasks.
- **Other open questions:**
  - whether S3 and S4 count rounds or revisions when a contract revision
    falls between them;
  - whether the backstop value is a plan setting or a user-level execution
    setting.
