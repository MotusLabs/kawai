# Design

## Context

See proposal.md for why. The specs are the requirements; this design is how they are met.

What this change builds on:
- **`plan-execution`** (unarchived). Its contracts X1–X8 (its design D20) fix:
  - the execution records and change states;
  - effects recorded before they run and inspected before they repeat (X3, D14);
  - `evaluateCi`, the flaky rule, `reviewVerdict`, and the clean-merge check (X4, D10, D11, D13);
  - the append-only `START_PRECONDITIONS` (X5);
  - `LandingMechanism { mode, probe, baseFor, nextLandingStep }`, with its registry, the base-branch meaning, and the team's `plan_landing_slots` row (X6, D13);
  - `plan_change_landings` (X7);
  - the append-only stop reasons (X8).

  Direct landing is that change's only mechanism, and it refuses `integration-branch` as `landing-mode-supported`.
- **`durable-plans`** (unarchived): `landing: { mode: 'integration-branch'; branch }` with its name rules (C1), `PlanService` as the only plan writer with command ids in `plan_events` (C3, C6), and the plan-change link (C5).
- **`plan-validation`** (unarchived): `branch-free` (no other open plan's revision lands on the same integration branch), carried `acceptance` conditions (V2), and relations (V3).
- **GitHub behavior relied on:**
  - `POST /repos/{o}/{r}/git/refs` creates a ref and answers 422 when it exists.
  - `PATCH /repos/{o}/{r}/git/refs/heads/{b}` with `force: false` moves a ref only as a fast-forward, and answers 422 otherwise.
  - A pull request whose head commit becomes reachable from its base branch is marked merged.
  - `allow_merge_commit` on the repository says whether merge commits are allowed.

  Two more are plan-execution's own assumptions, inherited unchanged: `gh pr merge --match-head-commit` merges only the named head, and the update-branch API's `expected_head_sha` refuses a head that moved.

## Goals / Non-Goals

**Goals:**
- Every head Kawai gives the integration branch is a commit whose own CI passed. Kawai moves the branch only by creating it and by fast-forwards, so it never holds a tree Kawai did not verify.
- Integration landing reuses plan-execution's gate, landing slot, landing facts, acceptance, and effects runner. It adds a mechanism, records, and a promotion flow, and no second executor.
- Promotion is one human command with a durable record, recoverable after a restart from stored state alone.

**Non-Goals:**
- Running CI on the host. CI is GitHub's, read the way plan-execution reads it.
- Protecting the integration branch on GitHub. Kawai detects moves and rewrites; it does not configure branch protection.

## Decisions

### D1. Module layout

- `src/server/plans/landing/integration/`:
  - `integrationSchema.ts` and `integrationStore.ts`: the four tables (D3), their transitions, and the only SQL writer of them;
  - `integrationMechanism.ts`: the `LandingMechanism` for `integration-branch` (`probe`, `baseFor`, `nextLandingStep`), registered beside `direct`;
  - `integrationProbe.ts`: the branch rules (D2);
  - `candidates.ts`: candidate transitions and the moved and rewritten rules (D5, D6);
  - `PromotionService.ts`: preview, Promote, and Cancel, with `PROMOTE_PRECONDITIONS` (D9);
  - `promotionPlanner.ts`: the pure `planPromotionSteps(snapshot, now)` (D10);
  - `promotionConnections.ts`: the WebSocket handlers (D13).
- `src/shared/planIntegration.ts`: the view types and the pure functions `candidateChain`, `referenceCommit`, and `promotedThrough`.
- Client: `PlanIntegrationPanel.tsx`, `PlanPromoteDialog.tsx`, and `PlanPromotionRow.tsx`, wired through `teamPlanStore`.

Each file stays under 500 lines. plan-execution's executor drives both increments and promotions in its per-team tick, so one team never has two ticks at once.

### D2. The mechanism, its base, and its probe

- **`baseFor(execution, change)`** returns the plan's integration branch, so provisioning, pull requests, the up-to-date step, and `changes-on-base` all use it. The execution records `base_branch` as that branch and `base_commit` as its head on `origin`, or the default branch's head when the branch does not exist yet. The default branch is recorded on the integration-branch row as the promotion target.
- **The probe** adds four rules to direct's repository checks (git, GitHub `origin`, `gh` auth and write permission, floor map). Each failing rule is a `landing-ready` finding:

  | Rule | Reads |
  | --- | --- |
  | not the default branch | `gh repo view --json defaultBranchRef` |
  | not a change name of the plan | plan content |
  | exists on `origin` only with this plan's record | `git ls-remote --heads origin <branch>`, `plan_integration_branches` |
  | no other plan's record | `plan_integration_branches` (primary key `team_id, branch`) |

  The `branch-free` check of `plan-validation` covers open plans at validation time. The record rule also covers closed plans, and it reads `origin` when Start runs.

*Why the integration branch as base rather than the default branch:* dependents must see their dependencies' code, which is only on the integration branch until promotion. Pointing pull requests at it also makes GitHub's own merged state follow the landings.

### D3. Records

An additive migration in `integrationSchema.ts`:

```sql
CREATE TABLE plan_integration_branches (
  team_id TEXT NOT NULL, branch TEXT NOT NULL, plan_id TEXT NOT NULL,
  target_branch TEXT NOT NULL,          -- the default branch, the promotion target
  created_by TEXT NOT NULL,             -- the execution of the latest creation
  created_sha TEXT NOT NULL, created_at TEXT NOT NULL,  -- updated when the branch is created again (D4)
  PRIMARY KEY (team_id, branch)
);

CREATE TABLE plan_integration_candidates (
  id TEXT PRIMARY KEY, team_id TEXT NOT NULL, branch TEXT NOT NULL, seq INTEGER NOT NULL,
  kind TEXT NOT NULL,                   -- increment | promotion
  execution_id TEXT, change TEXT, result_id TEXT, round_id TEXT,  -- increments
  promotion_id TEXT,                                              -- promotions
  baseline_sha TEXT NOT NULL,           -- the integration head it extends
  commit_sha TEXT NOT NULL, tree_sha TEXT NOT NULL,
  outside_json TEXT,                    -- commits between the last landed candidate and baseline_sha
  state TEXT NOT NULL,                  -- verifying | passed | landed | failed | superseded
  created_at TEXT NOT NULL, decided_at TEXT,
  UNIQUE (team_id, branch, seq)
);

CREATE TABLE plan_promotions (
  id TEXT PRIMARY KEY, team_id TEXT NOT NULL, plan_id TEXT NOT NULL, branch TEXT NOT NULL,
  number INTEGER NOT NULL,              -- n in '<branch>--promote-<n>'
  command_id TEXT NOT NULL,
  from_sha TEXT NOT NULL, through_seq INTEGER NOT NULL,  -- the pinned head; the last landed candidate in it
  target_branch TEXT NOT NULL, promotion_branch TEXT NOT NULL,
  floor_json TEXT NOT NULL,             -- the floor map snapshot, as an execution records it
  pr_number INTEGER, pr_url TEXT,
  head_sha TEXT,                        -- the verified head P
  step TEXT, moves INTEGER NOT NULL DEFAULT 0,
  ci_json TEXT, rerun_at TEXT, ci_window_from TEXT,
  state TEXT NOT NULL,                  -- running | finished
  outcome TEXT, outcome_detail_json TEXT,  -- merged | failed:<reason> | cancelled
  merge_sha TEXT, tree_verified INTEGER,   -- 1 when merge_sha's tree is head_sha's tree
  fast_forwarded INTEGER, fast_forward_note TEXT,
  cancel_reason TEXT, started_at TEXT NOT NULL, finished_at TEXT,
  UNIQUE (plan_id, number),
  UNIQUE (plan_id, command_id)          -- a Promote replay is a database fact (D9)
);
CREATE UNIQUE INDEX plan_promotions_one_running ON plan_promotions(plan_id) WHERE state = 'running';

CREATE TABLE plan_promotion_effects (   -- plan_execution_effects' shape, keyed by promotion
  id TEXT PRIMARY KEY, promotion_id TEXT NOT NULL,
  kind TEXT NOT NULL,   -- create-promotion-branch | open-pr | update-branch | rerun | merge | fast-forward | close-pr
  effect_key TEXT NOT NULL UNIQUE, command_json TEXT NOT NULL,
  state TEXT NOT NULL,  -- pending | running | done | failed | unknown | cancelled
  tries INTEGER NOT NULL DEFAULT 0, next_at TEXT, outcome_json TEXT, error TEXT,
  created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT
);
```

Increments add two kinds to `plan_execution_effects` (X3): `create-integration`, which is execution-level and so has no change, and `fast-forward`. A promotion candidate is the chain's record of the integration head moving to a promotion's verified head (D10). So "the last landed candidate" is always one row, whatever moved the branch last.

*Why a separate effects table for promotions:* a promotion belongs to no execution, so it cannot satisfy `plan_execution_effects.execution_id`. The runner works through a small `EffectQueue` interface (load due, mark running, settle with transition), with one implementation per table. Inspectors are shared by kind.

### D4. Creating the integration branch

When an integration execution starts and the branch is missing on `origin`, the executor's first step is the execution-level `create-integration` effect: `gh api -X POST repos/{o}/{r}/git/refs -f ref=refs/heads/<branch> -f sha=<default head>`. Its key is X3's execution-level key, `<execution>::create-integration:<n>`, where `<n>` counts that kind's effects within the execution. Provisioning waits until the effect is done.
- **Done.** One transaction inserts the `plan_integration_branches` row. When an earlier execution created the branch and it was deleted since, the row is kept, and its `created_sha`, `created_by`, and `created_at` take the new creation.
- **422, the ref exists.** The branch is inspected. A ref at the requested commit is our own lost success. Anything else is a foreign branch: every waiting change stops as `effect-failed`, naming the branch.
- **Transient failures** back off as in plan-execution's D14. After 3 tries, every waiting change stops as `effect-failed`.

Retrying any change stopped this way first reads the branch. A branch present with this plan's record is reused. A missing one is created by a new effect under the next `<n>`. A foreign one stops the change again. So the first Retry creates the branch, and the others find it.

An existing branch with this plan's record is reused at its head. A deleted branch whose plan has unpromoted landings never gets that far: `landings-on-base` (D8) refuses Start, because the default head cannot contain those landings.

**The reference commit.** The rewritten check (D6) and outside commits (D5) both compare against one commit: the last landed candidate's commit, or the creation commit when the branch was created after that landing or nothing has landed. The pure `referenceCommit(branchRow, candidates)` computes it from stored rows.

### D5. Increments: exact candidates and the fast-forward

The integration mechanism's `nextLandingStep` runs plan-execution's direct steps 1 to 3 unchanged, against the integration branch:
1. the acceptance conditions;
2. the slot, in `passed_at` order among the changes ready to merge;
3. up to date, with the `merge-tree` prediction, `update-branch` pinned to H, and the clean-merge check.

Steps 4 and 5 are its own:
- **Candidate.** When the change is up to date, Kawai inserts a candidate in one transaction. Its fields:
  - `seq`: the next sequence number for the branch;
  - `baseline_sha`: the integration head it contains;
  - `commit_sha`: H, or H' for a carried round;
  - `tree_sha`;
  - `outside_json`: the commits `git rev-list <reference>..<baseline>` lists, with each commit's sha, author, and subject. The reference is `referenceCommit` (D4).

  The state is `passed` when the round's CI on that commit already passed. A carried round's candidate is `verifying` until the carried round's CI decides, and then becomes `passed` or `failed`. A failed candidate fails the carried round, and plan-execution's fix-round rules apply.
- **Fast-forward.** For a passed candidate, Kawai first runs the rewritten check and re-reads the branch (D6). It then runs the `fast-forward` effect: `gh api -X PATCH repos/{o}/{r}/git/refs/heads/<branch> -f sha=<C> -F force=false`. On success, one transaction makes three writes:
  - the candidate becomes `landed`;
  - the landing fact is inserted with mechanism `integration-branch`, `head_sha = merge_sha = C`, `base_sha` the head re-read before the fast-forward, and `tree_verified = 1`;
  - the change becomes `landed`, and `owns` and the slot are cleared, as in direct step 5.

  Then `TaskResultService.accept(system, …)` follows, as in direct landing.

The landed commit is the verified commit itself, so `tree_verified` is always 1, and `post_ci_json` stays empty: no further CI could add evidence about that tree. GitHub marks the change's pull request merged once C is reachable from the integration branch. Kawai records nothing from that, because the landing fact is the record.

*Why a fast-forward ref update rather than a merge:* a merge commit, even GitHub's, is a new tree that CI never ran on. A non-forced ref update is a compare-and-swap on the branch. It succeeds only while the branch is an ancestor of C, so a landed tree is exactly the tree CI passed (R16).

*Why the GitHub ref API rather than `git push`:* C already exists on GitHub as the pull request's head. The ref API needs no local objects or fetch, it makes 422 the single answer for both "exists" and "not a fast-forward", and it is a `gh` call like every other landing step.

### D6. Moved and rewritten integration branches

Before a fast-forward, after a refused one, and when inspecting one, Kawai reads `origin`'s head R with `ls-remote` and fetches it:
- **Rewritten.** R lacks the reference commit (D4), by `merge-base --is-ancestor`. The change stops as `integration-rewritten`, which is appended to X8, with R and the missing commit. Kawai never forces the branch, and Retry runs the check again.
- **Moved.** R contains the reference commit but is not C's ancestor. The candidate becomes `superseded`, and the change returns to the up-to-date step, keeping the slot. Its next candidate records the commits between the reference commit and R in `outside_json`.
- **Otherwise** the fast-forward runs or, when inspecting, runs again.

The inspection table rows this change adds to plan-execution's D14:

| Effect | Inspection | Found done | Not done |
| --- | --- | --- | --- |
| `create-integration` | `ls-remote` for the branch | a ref at the requested commit: done | missing: run again; elsewhere: foreign branch (D4) |
| `fast-forward` | `ls-remote` head R | R contains C: done | C contains R: run again; otherwise D6's rules |
| `create-promotion-branch` | `ls-remote` for the promotion branch | at `from_sha`: done | missing: run again; elsewhere: `effect-failed` |

*Why automatic recovery from a moved branch:* the owner may push a fix to the integration branch during a long execution. Incorporating it through the normal up-to-date step keeps the execution unattended, and the next candidate's CI verifies it as part of its tree. A rewrite is different, because it can drop landed work that landing facts and acceptance already recorded. Only the owner can decide whether that is intended.

### D7. Failed candidates and fix rounds

A candidate's CI follows plan-execution's rules: one rerun, the flaky rule, and the `ci-missing` and `ci-timeout` stops. A failed candidate sets its state to `failed`, releases the slot, and fails its round. The fix attempt continues from the candidate's commit and counts as a fix round when its source did (plan-execution D12's carried-round rule). The integration branch is not touched, so its head stays the last landed candidate. Evidence never moves between candidates: each candidate's CI is read for its own `commit_sha`, and its review comes from its own round or the round it carries.

### D8. The appended Start preconditions (X5)

| Entry | Reads | Refuses |
| --- | --- | --- |
| `promotion-idle` | `plan_promotions` running row of the plan | a running promotion, naming it and its step |
| `landings-on-base` | after a fetch: `git merge-base --is-ancestor <merge_sha> <base head>` for each landing fact of the plan, in every mode | each fact whose `merge_sha` the execution's base head lacks, naming the change and the branch it landed on |

Both are pre-reads, like `changes-on-base`, and run in the same read phase. An integration plan's base head is the integration branch's head, or the default branch's head when the branch does not exist. A plan with no landing facts passes `landings-on-base` trivially.

*Why `landings-on-base` lives here:* only a mode change, or a lost or rewritten integration branch, can leave a plan's landings off its base. Direct-only plans pass by construction. The entry belongs with the mechanism that creates the situation.

### D9. Promote: preview, preconditions, and the command

- **Messages.**
  - `team-plan-promotion-preview { teamPath, planId, branch }` returns the standing, the head, the carried candidates (`through_seq`), and the outside commits.
  - `team-plan-promote { teamPath, planId, branch, fromSha, commandId }`.
  - `team-plan-promotion-cancel { teamPath, promotionId, reason, commandId }`.

  `team-plan-result` answers each.
- **`PromotionService.promote`** refuses non-human callers first. Then, like Start, it reads before it writes: `ls-remote` for the integration and promotion branches, `gh api repos/{o}/{r}` for `allow_merge_commit`, ancestry for `something-to-promote`, and the probe's repository checks. The preview sends the same reads. One transaction then:
  - replays by `(plan_id, command_id)` with the compared payload `branch` and `fromSha`. The pair is unique on `plan_promotions` as on `plan_events`, so two same-key Promotes that both passed the reads leave one promotion, and the second resolves as the replay;
  - runs every entry of `PROMOTE_PRECONDITIONS`;
  - inserts the promotion with the next `number`, the floor snapshot, and `through_seq`;
  - records `promotion-started`, carrying the promotion id, through `PlanService.recordPromotionEvent(planId, event, within)`. This change adds that method beside plan-execution's `recordExecutionEvent`, which writes inside an execution's transaction: a promotion belongs to no execution. `PlanService` stays the only writer of `plan_events` (C3), and the three promotion kinds are appended under C6.
- **The list:**

  | Entry | Passes when |
  | --- | --- |
  | `integration-branch-known` | `branch` has this plan's `plan_integration_branches` row |
  | `no-execution` | the plan has no running execution |
  | `no-promotion` | the plan has no running promotion (also the partial unique index) |
  | `from-current` | `fromSha` is the branch's head on `origin` |
  | `something-to-promote` | the target branch's head does not contain `fromSha` |
  | `merge-commits-allowed` | the repository's `allow_merge_commit` is true |
  | `landing-ready` | the probe's repository checks and floor map pass |
  | `promotion-name-free` | `<branch>--promote-<number>` is absent on `origin` |

- **Cancel** refuses non-human callers, and is refused once the merge is recorded, naming the merge. Otherwise it records `promotion-cancelled` through `recordPromotionEvent`, with the compared payload `promotionId` and the trimmed `reason`. It marks pending promotion effects `cancelled`, and finishes the promotion as `cancelled` unless a merge effect is running. In that case the merge settles first. A completed merge finishes the promotion as `merged`, with a note that the cancellation came too late, and its fast-forward still runs, because it belongs to recording the merge. A merge that did not happen finishes it as `cancelled`.

Plan state is not a precondition. A completed plan is the usual one to promote, and a cancelled plan's landed work may still be wanted.

### D10. The promotion steps

`planPromotionSteps(snapshot, now)` is pure, over the promotion row, its effects, the slot, and CI reads. The executor applies its transitions as it does execution steps:
1. **Branch.** `create-promotion-branch`: `gh api -X POST …/git/refs` creating `refs/heads/<promotion branch>` at `from_sha`.
2. **Pull request.** `open-pr`: `gh pr create --base <target> --head <promotion branch>`, with a title and body naming the plan, the branch, `from_sha`, and the carried changes.
3. **Slot.** Kawai inserts the `plan_landing_slots` row with `holder_kind = 'promotion'`. While the slot is taken, the step waits and shows the holder.
4. **Up to date.** This is direct landing's step 3, unchanged except for the outcome of a conflict. Kawai fetches the target, and checks whether the promotion head contains its head.
   - When it does not, `merge-tree` predicts conflicts. A conflict fails the promotion as `promotion-conflict` with the files.
   - Otherwise `update-branch` runs, pinned to the current head, and the clean-merge check applies. GitHub's 422 conflict also fails it as `promotion-conflict`. A head that fails the check fails the promotion as `effect-failed`, because nobody else should write a promotion branch.
5. **CI.** `evaluateCi` with the promotion's floor snapshot. Its window opens at the pull request or at the update. A rerun is requested once.
   - `fail` becomes `ci-failed`, and the CI stops become `ci-missing` and `ci-timeout`.
   - A `pass` records the verified head `head_sha`.
6. **Re-read.** Kawai runs `ls-remote` for the target. When the target head is not contained in `head_sha`, `moves` rises and the step returns to 4. At `moves = 3`, the promotion fails as `target-moved`.
7. **Merge.** `merge`: `gh pr merge <n> --merge --match-head-commit <head_sha>`, then `gh pr view` for `mergeCommit`.
8. **Record.** One transaction makes three writes:
   - it sets `merge_sha` and `tree_verified`, which is 1 when the merge commit's tree is `head_sha`'s tree. A 0 means the target moved between the re-read and GitHub's merge, and the view flags it as direct landing does;
   - it inserts the promotion candidate (`kind = 'promotion'`, `baseline_sha = from_sha`, `commit_sha = head_sha`, state `passed`);
   - it releases the slot.
9. **Fast-forward.** The integration `fast-forward` (D5) moves the branch to `head_sha`, with the rewritten and moved reads of D6.
   - On success, the promotion candidate becomes `landed`.
   - If the integration branch moved, or it was rewritten, Kawai leaves the branch as it is. It records `fast_forwarded = 0` with the reason, and the promotion candidate becomes `superseded`. The next increment's outside commits then start from the last landed candidate, which is still the one before the promotion. That is correct, because the branch never received the promotion's head.
10. **Finish.** `promotion-finished` with outcome `merged`, and actor `system`, under the command id `promo:<id>:finish`, through `recordPromotionEvent` like the human kinds.

A failure at any step, and a Cancel that stops the promotion before its merge:
- cancels its pending effects and releases the slot;
- runs the `close-pr` effect, `gh pr close <n> --comment <outcome>`, when the pull request is still open;
- finishes the promotion with its outcome and detail;
- writes `promotion-finished` with that outcome.

A `close-pr` that fails after its retries leaves the outcome as it is, with a note that the pull request is still open. The branch and the closed pull request stay, and a later Promote takes `number + 1`.

*Why close a failed promotion's pull request:* left open, it is a pull request into the default branch whose head was never verified, or failed verification, and anyone could merge it by hand. A closed pull request keeps its page, checks, and comments readable, which is all the evidence the record needs.

*Why a promotion branch rather than a pull request from the integration branch itself:* `update-branch` would write a merge commit onto the integration branch before CI ran on it, breaking the rule that every head Kawai gives that branch is verified. On a separate branch, the update and its CI happen beside the integration branch, which then only fast-forwards to the verified result.

*Why always a merge commit:* squash or rebase would rewrite the integration commits. The default branch would then not contain the landed candidates, so `landings-on-base` and `promotedThrough` would both lose them.

*Why bound the target's moves here but not in direct landing:* a promotion is a human one-shot that holds the team's landing slot. Failing it after three moves returns control to the owner, and releases the slot to every other plan's landings. An unattended change keeps trying instead, because stopping it would need the owner (plan-execution D13).

### D11. Progress and `promotedThrough`

`promotedThrough(candidates, promotions)` returns, for each integration branch, the highest `through_seq` among the plan's `merged` promotions. A landing fact counts as promoted when its candidate's `seq` is at most that value.

The function is pure over stored rows, so the server, `plan_get`, and the client agree without git calls. `executionProgress` keeps "landed" for every change with a fact, and the view adds a promoted mark from `promotedThrough`. Plan completion is unchanged: the execution completes when every change has a landing fact on the integration branch.

### D12. Agent surface

- `plan_get` gains `integration` per branch: the branch and target, its head when last read, the candidate chain with states and outside commits, and the promotions with steps and outcomes.
- The execution-task instruction and plan note, from plan-execution D18, name the integration branch as the change's base, and repeat that Kawai alone writes it.
- No tool promotes or cancels, and none may be added. `PromotionService` refuses agent callers, as `ExecutionService` does.

### D13. Human protocol and the view

- The three messages of D9 are listed in `CHAT_CONNECTION_TYPES`. `team-plan-detail` gains `integration: PlanIntegrationView[]`, pushed after every candidate, promotion, or effect write.
- `teamPlanStore` holds integration views and one command id per open dialog: Promote, minted at open and re-minted when `fromSha` changes, and Cancel. Every store method that applies server state has a dispatch caller.
- `PlanIntegrationPanel.tsx`:
  - shows the branch, its head, and the target;
  - lists the candidate chain, newest first: `seq`, change, commit, CI, state, and outside commits flagged, with a failed candidate kept beside the one that replaced it;
  - offers **Promote to `<target>`** while `something-to-promote` holds and nothing of the plan runs.
- `PlanPromoteDialog.tsx`: the standing, the pinned head, the carried changes, and the outside commits.
- `PlanPromotionRow.tsx`: the steps, pull request, CI with flaky marks, moves, outcome, and **Cancel promotion** while running. Cancel asks for a reason.
- Every control disables while disconnected, and refusals show inline.

### D14. Contracts consumed and published

Consumed:
- **X1:** the change states; increments add no state, and promotions have their own rows.
- **X3:** the effect kinds `create-integration` (execution-level) and `fast-forward`, plus the promotion effects table in the same shape.
- **X4:** `evaluateCi`, the flaky rule, and the clean-merge check, all reused unchanged.
- **X5:** the entries `promotion-idle` and `landings-on-base`.
- **X6:** the `integration-branch` mechanism, and `holder_kind = 'promotion'`.
- **X7:** the landing facts, written through the same insert.
- **X8:** `integration-rewritten`.
- **C1:** the landing mode and branch.
- **C3:** `PlanService` stays the only writer of `plan_events`. This change adds `recordPromotionEvent` for the promotion kinds, and leaves plan-execution's `recordExecutionEvent` unchanged.
- **C6:** the appended kinds `promotion-started`, `promotion-cancelled`, and `promotion-finished`.
- **C5:** the link, unchanged.
- **V2:** acceptance conditions before each landing, through the shared steps.
- **V3:** no extra input. Every candidate is verified on top of every earlier landing, so changes whose capabilities overlap are always verified together.

Published:

| Contract | What it fixes | Bound by |
| --- | --- | --- |
| I1 Candidate chain | D3 candidate rows and states; `candidateChain`, `referenceCommit` | `plan-supervision` (cards for failed candidates), `execution-safety-recovery` (audit) |
| I2 Promotions | D3 promotion rows, outcomes, and effects; `promotedThrough` | `plan-supervision` (correction tasks for a failed promotion), `revision-control`, `execution-safety-recovery` |

## Risks / Trade-offs

- [The owner force-pushes the integration branch] → Landing stops as `integration-rewritten`, and Start refuses as `landings-on-base` until the landings are reachable again. Kawai never forces it back.
- [GitHub does not mark a fast-forwarded pull request merged] → The landing fact, not the pull request's state, is the record. A pull request left open is cosmetic, and the view links it.
- [A promotion holds the slot for hours of CI] → The slot is what keeps a promotion's merge and other plans' direct merges from racing on the default branch. `ci-timeout`, the 3-move bound, and Cancel all release it.
- [One slot per team also serializes increments on unrelated integration branches] → Those never race each other, so a slot per base branch would be enough for them. It would change plan-execution's X6 slot, though, and a promotion still needs to exclude every writer of the default branch. Landing is short apart from a carried round's CI, so the team-wide slot is kept until a team shows the cost.
- [Merge commits disabled on the repository] → Promote is refused as `merge-commits-allowed` with the setting named. Kawai never falls back to squash.
- [Outside commits are verified only by CI, not reviewed] → They are flagged on the candidate that first includes them and in the Promote dialog. Kawai neither reviews nor reverts them, because the owner made them.
- [Integration branch names collide with a human's branch] → The probe refuses a branch Kawai did not create, and the ref API refuses to create over one.

## Migration Plan

- The migration is additive: four tables, with no backfill.
- Integration plans become startable once this ships. Plans in direct mode are unaffected, apart from the two appended Start entries, which pass for them by construction.
- **Rollback:** finish or cancel running promotions and stop integration executions. Older builds ignore the tables. An older build refuses integration plans at Start again, as `landing-mode-supported`.

## Open Questions

None. Whether Kawai closes a failed promotion's pull request was the last one, and D10 decides it: Kawai closes it and keeps it.
