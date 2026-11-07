# Proposal

## Why

Review findings are one free-text blob with a pass/fail verdict
(`task_submit_findings`). When a round fails, plan execution forwards the
whole text to the developer (`fixInstruction`, cut at `LIST_CHARS`). Nothing
separates a demonstrated defect from a preference, nothing says which part
of the contract a finding violates, and the developer can only comply.
Findings have no identity across rounds, so nobody can tell whether a fix
loop is converging. This is the second of three changes toward a convergent
review protocol. It depends on `implementation-contract` (clause identities
`r<N>#<hash12> › <clause>`) and enables `review-convergence` (signals
computed over this change's ledger).

## What Changes

- **Structured findings.** `task_submit_findings` takes a list of findings
  instead of (or beside) the text. Each finding has:
  - a stable id (`F<n>`, unique within the task; a re-raise reuses the
    prior id);
  - a level: `P0` (security, data corruption, severe correctness), `P1`
    (a reproducible requirement violation, a significant regression), or
    `P2` (advisory: refactoring, maintainability, optimization,
    preference);
  - the clause identity it violates;
  - evidence (`file:line`, test output, or a counterexample);
  - its impact;
  - an optional reproduction.

  The verdict is derived: `fail` exactly when at least one finding is
  accepted at P0 or P1.
- **A mechanical gate.** Kawai classifies each submitted finding:
  - `accepted`: P0/P1 with every required field, citing a clause of the
    pinned revision's contract, inside scope, and not in an `X*` clause;
  - `unsupported`: P0/P1 missing evidence, impact, or a clause;
  - `advisory`: P2, recorded only;
  - `out-of-contract`: cites no clause, cites an `X*` clause, or points
    only at paths outside scope.

  Only accepted findings can fail a round.
- **The rebut action.** The developer can dispute accepted findings with
  counter-evidence, as a new tool or a field of `task_submit_result`. A
  disputed finding goes to the plan's Lead role, or to the task creator
  for manual work, as a decision card (`decision_ask`). The decision
  upholds the finding (back to `accepted`) or rejects it. The change waits
  instead of spending a fix round on it.
- **P0 escalation.** An accepted P0 also opens a Lead card immediately,
  while the fix proceeds. This is a proposed default, still to be
  confirmed with the owner.
- **A findings ledger per task.** It holds one row per finding id, with its
  level, clause, state (`accepted`, `unsupported`, `advisory`,
  `out-of-contract`, `disputed`, `rejected`, `resolved`, `still-open`,
  `reopened`), the round and result of each transition, and the contract
  identity it was judged under. `task_get` and the Team page show it.
- **Verify rounds.** The re-review of a fix result must give a disposition
  (`resolved`, `still-open`, or `regressed`) for every finding that was
  open on the previous round. A new finding is gated as above, so it
  blocks only at P0/P1 with a clause and evidence. A re-raise of a resolved
  id, or of the same clause at the same locus, records `reopened`.
- **Accepted findings only in fix instructions.** `fixInstruction` lists the
  accepted P0/P1 findings that are still open, by id, with their clause,
  evidence, and reproduction, instead of the full review text. Advisory
  and out-of-contract findings stay in the ledger.
- **Contract revisions re-map the ledger.** When a new task revision
  changes the contract, each open finding is re-mapped to the clause with
  the same id in the new contract, if one exists. Otherwise it is marked
  `superseded` and journaled.
- **Prompts.** The reviewer role files replace the scattered blocking and
  oracle rules with the finding format and the verify-round rule. The dev
  role files say to fix only the listed ids, with minimal changes, and to
  rebut with evidence rather than comply with a finding they can refute.
  `docs/agent-collaboration.md` gains the review protocol section.

## Capabilities

### New Capabilities

- `review-findings`: the finding model (ids, levels, clause citation,
  evidence), the gate's classification, the rebut action and its decision
  card, the findings ledger, and the verify-round disposition rules.

### Modified Capabilities

- `task-results`: "Findings are bound to the result examined" now takes
  structured findings with a derived verdict; text-only findings remain
  readable.
- `plan-execution`: "A failed round returns the change for fixes" now
  means a round with at least one accepted P0/P1 finding, and the fix
  instruction carries only the open accepted findings. A disputed finding
  holds the change until its card is decided.
- `plan-decisions`: rebuttal and P0 cards are new card kinds raised by
  Kawai on the developer's or reviewer's behalf.

## Impact

- **Data:** new tables for findings and their state transitions, keyed by
  task, result, and finding id. Existing `team_task_findings` rows stay as
  text-only findings with no ledger rows.
- **Server:** `TaskResultService.submitFindings`, the task tools, a new
  ledger store and gate (`src/server/team/` or `src/server/review/`), and
  `executionRounds.ts`/`executionDispatch.ts`/`instructions.ts` for the
  derived verdict and the filtered fix instruction. The decision-card
  composition (`src/server/plans/decisions/`) also changes.
- **Client:** the task detail's findings ledger, and the result card's
  per-finding states.
- **Prompts and docs:** `.kawai/groups/reviewers*.md`, the dev role files,
  `lead.md`, `change-leads.md`, `docs/agent-collaboration.md`, and
  `docs/oracle-hazards.md` (the blocking rules move into the protocol).
- **Metrics:** `delivery-outcome-metrics` counts review rounds from
  findings rows and gains per-finding counts.
- **Depends on:** `implementation-contract` (clause identities, scope,
  `X*`) and `revision-control` (the fix-attempt path).
- **Open questions to settle in design:**
  - whether the rebuttal is a separate tool or a result field;
  - the exact locus rule for "same clause, same locus" reopen detection;
  - whether an unsupported P0 (a claimed security bug without evidence)
    still alerts the Lead.
- **Out of scope:** convergence signals, DIAGNOSE, and the fix-round
  backstop (`review-convergence`).
