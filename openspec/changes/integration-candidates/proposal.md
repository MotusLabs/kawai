# Proposal

## Why

Strategy revision 2 lets the owner choose a plan's landing mode: "changes merge to the main branch as they pass, or accumulate on an integration branch. Landing per the plan's mode is acceptance" (P5). `durable-plans` records the mode, with a named integration branch. `plan-validation` checks that no other open plan claims that branch. `plan-execution` lands changes directly, and refuses an `integration-branch` plan as `landing-mode-supported` until a mechanism for that mode exists (its design D13 and contract X6).

So a plan whose changes must not reach the main branch one by one cannot run at all. Its owner is back to integrating by hand:
- cut a branch;
- retarget each pull request;
- merge;
- rerun CI on the combination;
- merge the result into the main branch.

The work is the same as before, and so are the stalls UC2 asks Kawai to remove.

Accumulating changes is only safe if the accumulated state is checked as a whole. Changes that each pass alone can still break together. The multi-agent design asks for exact **integration candidates**:
- a recorded baseline, the exact results it includes, the combined commit, and evidence for that exact tree;
- a failed combination keeps the last good state and routes the fix to the change that broke it;
- "earlier tree evidence cannot approve a new tree" (R15, R16).

Promotion onto the target branch is a separate, authorized operation, rechecked against that branch's current head.

## What Changes

- **The `integration-branch` landing mechanism.** It registers under plan-execution's `LandingMechanism` contract, so `landing-mode-supported` passes for such plans.
  - The plan's integration branch becomes the execution's **base branch**: changes provision from it, their pull requests target it, and they land on it.
  - The repository's default branch becomes the **promotion target**.
- **Kawai creates the integration branch.** Just after Start, Kawai creates the branch on `origin` from the default branch's head, before any change is provisioned.
  - The landing probe refuses Start if the branch name is the default branch, or matches one of the plan's changes.
  - It also refuses Start if a branch with that name already exists that no execution of this plan created, or if another plan's record already uses it.
  - Kawai never writes to the integration branch except to create it and to fast-forward it.
- **Every integration head is an exact, verified candidate.** A passed change is brought up to date with the integration head, using the same update-branch and clean-merge check as direct landing. Its CI then runs on that exact commit.
  - Landing fast-forwards the integration branch to the verified commit itself, through GitHub's ref API and never forced. GitHub refuses it unless the branch is still an ancestor of that commit, so a landed candidate's tree is always exactly the tree CI passed.
  - If the branch moved, nothing lands: the candidate is superseded, and the change is brought up to date with the new head. If the branch no longer contains its last landed candidate, the change stops as `integration-rewritten`, and Kawai never forces it back.
  - A candidate that fails CI returns the change as a fix round, and the integration branch keeps its last good candidate.
  - Each candidate records:
    - its sequence number;
    - the head it extends;
    - the change, result, and round it includes;
    - the exact commit and tree;
    - any commits it found on the branch that no candidate produced;
    - its state.
- **Landing on the integration branch is acceptance.** The landing fact records the change's pull request, the integration head it extended, and the landed commit. Kawai accepts the result and closes the task as in direct landing.
  - Dependents are provisioned from the integration branch, so they see their dependencies' code.
  - The plan completes when every change has landed on the integration branch.
- **Promotion, human only.** The owner promotes an integration branch onto the default branch from the Plans view.
  - The command is pinned to the integration head the owner reviewed, under a command id.
  - Promotion runs under named preconditions: the branch is the plan's own, the plan has no running execution or promotion, the head is current, there is something to promote, the repository allows merge commits, the landing probe passes, and the promotion branch's name is free.
  - Kawai builds the promotion on its own branch, starting at that head, and opens a pull request into the default branch. It brings the pull request up to date with GitHub's update-branch, with the clean-merge check, and runs the floor's CI on the exact head (one rerun; the flaky rule).
  - Kawai merges with a merge commit, pinned to the verified head, after re-checking the default branch's head. A default branch that moved sends the promotion back to the up-to-date step, at most three times. Kawai then fast-forwards the integration branch to the promoted head, so later work starts from it.
  - A conflict, failing CI, or a default branch that keeps moving fails the promotion. It merges nothing, closes its pull request, and keeps its evidence. The owner can cancel a running promotion.
- **Start gains two preconditions**, appended to plan-execution's list:
  - `promotion-idle`: no promotion of the plan is running.
  - `landings-on-base`: every landing fact of the plan is reachable from the execution's base head. For example, a plan that switches from an unpromoted integration branch to `direct` must promote first.
- **Shared landing slot.** A promotion holds the team's landing slot while it updates, verifies, and merges, so it never races another plan's direct landing onto the default branch.
- **Visibility.**
  - The Plans view shows the integration branch, its candidate chain (with commits made outside Kawai flagged), and what each promotion would carry. It offers **Promote to `<default>`** and **Cancel promotion**, and shows promotions with their steps, CI, pull request, and outcome.
  - Progress shows which landed changes are already promoted.
  - `plan_get` includes the branch, its candidates, and its promotions. No agent tool promotes or cancels.

Non-goals:
- **Batched candidates and bisection.** Candidates are one change at a time.
- **Syncing the default branch into the integration branch** other than through promotion.
- **Automatic correction tasks for a failed promotion.** Routing them to a Lead or integrator role belongs to `plan-supervision`.
- **A contract registry.** V3 relations order the changes.
- **Deleting integration or promotion branches**, and deployment.

## Capabilities

### New Capabilities

- `integration-landing` covers:
  - the integration-branch mechanism and its probe rules;
  - creating the integration branch;
  - the integration branch as base;
  - candidates and their chain;
  - fast-forward landing, moved branches, and `integration-rewritten`;
  - outside commits;
  - the `promotion-idle` and `landings-on-base` preconditions;
  - progress and visibility.
- `integration-promotion` covers:
  - the human Promote and Cancel commands and their preconditions;
  - the promotion branch and pull request;
  - the up-to-date step, floor CI on the exact head, and the bound on default-branch moves;
  - the pinned merge commit, the promotion record, the integration fast-forward, and failure outcomes.

### Modified Capabilities

None. The behaviour this change builds on belongs to `plan-execution` and `plan-landing`, both still in the unarchived `plan-execution` change. That change defines the landing mechanism's base branch, never pushes to the default branch, and re-reads the base before a merge. It also keeps the landing slot and execution-level effects in shapes a mechanism can extend, and its Start preconditions and stop reasons are append-only lists. This change only appends to them: `promotion-idle`, `landings-on-base`, and `integration-rewritten`.

## Impact

- **Server.** New `src/server/plans/landing/integration/`:
  - the mechanism and its probe;
  - the candidate and promotion store and schema;
  - `PromotionService`, for the human commands and their preconditions;
  - the pure promotion planner;
  - promotion connections.

  The plan-execution executor drives promotions through the same effects runner.
  - Increments add two effect kinds: `create-integration`, which is execution-level, and `fast-forward`. Both are GitHub ref API writes.
  - Promotions keep their own effects: `create-promotion-branch`, then the shared kinds `open-pr`, `update-branch`, `rerun`, `merge`, and `fast-forward`.
- **Shared.** New `src/shared/planIntegration.ts`: types, the candidate chain, and `promotedThrough`. The new messages go in `src/shared/types.ts` and `CHAT_CONNECTION_TYPES`.
- **Client.** `PlanIntegrationPanel.tsx`, `PlanPromoteDialog.tsx`, and `PlanPromotionRow.tsx`, plus `teamPlanStore` wiring.
- **Data.** An additive migration with four tables: integration branches, candidates, promotions, and promotion effects. There is no backfill.
- **Docs.** AGENTS.md bullets for the mechanism, candidates, and promotion. Routing is unchanged.
- **Tests.**
  - Unit coverage of the probe rules, candidate states, the fast-forward inspection, outside commits, both preconditions, the promotion preconditions and steps, the bound on moves, cancel, and every failure outcome.
  - The adapters are tested against a local bare remote and a stub `gh`.
  - An integration test covers two changes landing on the integration branch, a promotion over a moved default branch, and a restart mid-fast-forward.
  - One browser walkthrough with the fixture adapter, named in `.github/workflows/ci.yml`.
- **Sequencing.** Implement after `plan-execution`, which it extends through contracts X4–X7.
