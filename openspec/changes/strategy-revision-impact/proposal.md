# Proposal

## Why

Approving a strategy revision creates one `strategy_impact_reviews` row in state `pending`, and nothing else (`strategy-approval`, "Publication grants nothing but one impact-review item"). The design deliberately left the review unworked. Nothing lists the plans the new direction affects, nobody records what happens to them, and a plan still pinned to the old revision has no defined path forward.

`durable-plans` already refuses to approve a plan revision whose pin is no longer the current strategy, through its `strategy-pin-current` precondition. Once that change lands, the only way past that refusal is to resubmit, which re-pins the plan. There is no way to decide deliberately that a plan should continue under the direction it was agreed against.

`docs/product-strategy.md` (Data model and revision policy; implementation sequence step 4) asks for exactly this. Strategy publication opens an explicit impact review for the Lead and the owner. They review affected and unaffected plans and record a disposition per plan. Nothing is silently rebound, interrupted, or reinterpreted, and historical acceptance keeps its original pin. Strategy revision 2 states the owner's side: "product strategy and plans are approved by the owner" (boundaries) and "the owner owns intent and the plan" (P1).

## What Changes

- **Assessment of the current impact review.** The review of the current approved strategy revision groups the plans of the strategy's team, derived at read time and never written:
  - **affected**: open plans with an approved or in-review revision whose pin is not that revision. This includes revisions submitted with no pin, which are marked unassessed.
  - **unaffected**: the other open plans.
  - **historical**: completed or cancelled plans, listed with their original pins and never changed.

  Earlier reviews show only what was recorded in them.
- **Dispositions per affected plan, recorded by the owner.**
  - `continue` keeps the plan on its older pin.
  - `adapt` requires a new plan revision pinned to the current strategy.
  - `reconsider` holds the plan until the owner decides again.

  Each disposition needs a rationale and is idempotent under a command id. A later disposition for the same plan supersedes the earlier one, and both stay readable.
- **Agents propose.** Agents (in practice the Lead) read assessments and propose a disposition with a rationale through two new `kawai-team` tools, `strategy_impact_get` and `strategy_impact_propose`. A proposal changes no gate. The owner's controls show it beside the decision, and the owner can accept it with one action. No agent tool records a disposition.
- **The gate.** A plan revision whose pin is not the current approved strategy revision (an older pin, or none) passes `durable-plans`' `strategy-pin-current` precondition only under the owner's `continue`, recorded in the review of the current approved revision. The precondition is supplied through that change's `pinDisposition` lookup.
  - `adapt`, `reconsider`, and no disposition all leave the refusal in place, and the refusal names which applies. Resubmitting re-pins as before.
  - Dispositions count only under the current review. When another strategy revision becomes current, earlier reviews show as superseded, and plans still pinned elsewhere need a new decision.
- **A withdrawn direction is never continued.** A plan revision pinned to a withdrawn strategy revision, or to any revision while the strategy has no approved revision, is refused at every plan gate whatever disposition exists, until it is resubmitted. Already approved revisions and running work are left alone.
- **One impact-state read for plan gates.** A plan revision's impact state is one of:
  - passes (the pin is current, or the team has no strategy);
  - passes by `continue`;
  - decision required;
  - held by `adapt` or `reconsider`;
  - withdrawn direction.

  Plan approval and the Plans view consult this state now. `plan-validation` (its input identity) and `plan-execution` (its Start gate) bind to the same read later.
- **Derived review state.** A review shows **Needs decisions**, **Reviewed**, **Superseded**, or **Withdrawn**, derived at read time. The stored row stays exactly as approval created it.
- **Ask an agent group to assess.** From the current review, the owner can send one ordinary normal-priority message to a group of the team, under a command id. The `lead` group is preselected when the team defines one. The message names the review and its affected plans. This is the only mail the impact review ever sends, and only on that explicit request.
- **Views.**
  - The Strategy view shows each review with its state. For the current review it adds the grouped plans with pins and impact states, proposals, decisions and their history, the decision controls, and the assessment request.
  - The Plans view marks each affected plan with its impact state and a link to the review.

Non-goals:
- automatic rebinding of any plan;
- pausing, interrupting, or notifying running work (holds and checkpoints belong to `revision-control`, and a disposition only links there);
- changing strategy approval or withdrawal (an approval still creates exactly one row, and a withdrawal creates none);
- an impact review for withdrawing the active approved revision (plans pinned to a withdrawn direction are blocked until resubmitted);
- validation reports (`plan-validation`) and the Start gate (`plan-execution`), which bind to this change's read;
- re-evaluating historical plans or accepted results;
- cross-team plans (the strategy boundary is one repository per plan).

## Capabilities

### New Capabilities

- `strategy-impact-review`, which covers:
  - the derived assessment of an impact review;
  - owner dispositions and agent proposals;
  - the `continue` gate on stale pins;
  - the impact-state read for plan gates;
  - the withdrawn-direction rule;
  - the derived review state;
  - the explicit assessment request;
  - the Strategy and Plans view surfaces.

### Modified Capabilities

None. Strategy approval still creates exactly one impact-review row and nothing else. The impact-review rows are only read here, never rewritten. `durable-plans`' `strategy-pin-current` precondition and its `pinDisposition` extension point already define where a recorded disposition lets an older pin pass, so `plan-approval`'s requirements are unchanged. The two new agent tools read and propose only; no strategy tool gains approve, publish, withdraw, or delete rights.

## Impact

- **Server.**
  - New `src/server/strategy/impactSchema.ts` and `impactStore.ts`: the `strategy_impact_proposals`, `strategy_impact_decisions`, and `strategy_impact_requests` tables. `strategyStore.ts` is already at 493 lines, so nothing is added there.
  - New `ImpactService.ts`: rights, idempotency, the assessment read through `durable-plans`' plan reads, and the gate.
  - New `impactTools.ts`.
  - `strategyConnections.ts`: the new human actions, plus pushes on impact writes and on plan writes.
  - The `durable-plans` `pinDisposition` lookup gets wired to the gate, and its approval refusal carries the impact state.
  - `teamPrompt.ts`: the strategy note gains the impact tools.
- **Shared.** New `src/shared/strategyImpact.ts`: the assessment, the gate, and derived states as pure functions. `src/shared/types.ts` gains the new messages, which must also be listed in `CHAT_CONNECTION_TYPES`.
- **Client.**
  - A `StrategyImpactReview.tsx` section in the Strategy view.
  - A badge and link in the Plans view.
  - Store wiring in `strategyStore.ts` and the plan store.
- **Data.** An additive migration with three new tables. Existing impact-review rows are untouched.
- **Docs.** AGENTS.md How It Works bullets for impact review, dispositions, the gate, and the tools. The "exactly four strategy tools" wording is updated to name the two impact tools.
- **Tests.**
  - Unit coverage of grouping, dispositions, idempotency, the gate (with durable-plans' approval), withdrawn directions, supersession, derived state, the request, cross-team refusals, and persistence.
  - One browser walkthrough, named in `.github/workflows/ci.yml`.
- **Sequencing.**
  - Implement after `durable-plans`, whose pins, plan reads, lifecycle, and `pinDisposition` lookup it binds to (its design D13: C2, C3, C4, and C6).
  - It can run in parallel with `plan-validation`.
