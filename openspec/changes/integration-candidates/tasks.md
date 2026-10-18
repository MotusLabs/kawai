# Tasks

Implement after `plan-execution` has landed on master, together with what it builds on (`durable-plans`, `strategy-revision-impact`, and `plan-validation`), then rebase this branch onto it. Every file stays under 500 LOC. Tests that spawn git use `cleanGitEnv`. Tests never reach GitHub: they put a stub `gh` executable on a private `PATH` and use a local bare repository as `origin`.

## 1. Shared model

- [x] 1.1 Reconcile names with the merged `plan-execution` design and record any renames in this design before coding. Verify by reading its D3, D4, D12–D14, and D20 against D3, D5, D6, D8, and D14 here: `LandingMechanism`, the mechanism registry, `START_PRECONDITIONS`, `plan_landing_slots`, `plan_execution_effects`, `plan_change_landings`, `evaluateCi`, the clean-merge check, the stop-reason union, and `PlanService.recordExecutionEvent`.
- [x] 1.2 Create `src/shared/planIntegration.ts` with the candidate kinds and states, the promotion steps and outcomes, and the view types (D3, D13), and a header comment naming them. Verify with a typecheck.
- [x] 1.3 Implement `candidateChain`, `referenceCommit`, and `promotedThrough` (D4, D11). Verify with unit tests:
  - the chain is newest first, and a failed candidate stays beside the one that replaced it;
  - the reference is the last landed candidate, or the creation commit when the branch was created after it or nothing has landed;
  - a superseded promotion candidate is not the reference;
  - only `merged` promotions count, and a fact is promoted when its candidate's `seq` is at most `through_seq`.

## 2. Records

- [x] 2.1 Add the D3 migration in `src/server/plans/landing/integration/integrationSchema.ts`: four tables and the one-running-promotion index. Verify with a migration test on a fresh database and on one that already has the plan-execution tables, run twice.
- [x] 2.2 Implement `integrationStore.ts` as the only SQL writer of those tables, with a header comment saying so; the records need no user docs beyond it. Cover the branch record (insert, and a creation again that updates it), candidates with the next `seq` and their state transitions, and promotions with the next `number`, their step, moves, and finish. Verify with unit tests:
  - `UNIQUE (team_id, branch, seq)` holds under two concurrent inserts;
  - the partial index maps to the `no-promotion` refusal;
  - illegal transitions are refused, such as `landed` to `failed` or `failed` to `passed`.
- [x] 2.3 Extract the effects runner's queue behind an `EffectQueue` interface, with one implementation over `plan_execution_effects` and one over `plan_promotion_effects` (D3). Verify that plan-execution's runner tests still pass unchanged, and that new tests cover the promotion queue: due order, backoff, and `running` becoming `unknown` at startup.

## 3. Mechanism, probe, and branch creation

- [x] 3.1 Implement `integrationProbe.ts` with D2's four rules. Verify with tests against a bare remote and a stub `gh`: the default branch, a change name, an existing branch without a record, and another plan's record each refuse `landing-ready`, naming the branch, and the probe creates no ref.
- [x] 3.2 Implement and register `integrationMechanism.ts` (D2). Verify with Start tests:
  - an integration plan starts, recording the integration branch as `base_branch` and the default branch as the target;
  - `landing-mode-supported` passes;
  - `changes-on-base` compares with the integration head, or with the default head while the branch is missing.
- [x] 3.3 Implement the `create-integration` effect and its inspector (D4, D6). Verify with tests:
  - the first execution creates the branch at the default head before any `provision` effect runs;
  - a later execution reuses the branch at its head;
  - a creation again keeps the record and updates its creation fields;
  - a 422 for a ref at the requested commit is done, and a foreign ref stops every waiting change as `effect-failed`;
  - three transient failures stop as `effect-failed`;
  - the first Retry creates the branch, and the others find it;
  - restart inspection follows the D6 table row.
- [x] 3.4 Append `promotion-idle` and `landings-on-base` to `START_PRECONDITIONS` as pre-reads (D8). Verify with Start tests:
  - a running promotion refuses, naming it and its step, and a finished one passes;
  - switching to `direct` before promotion refuses, naming the changes and the integration branch;
  - the same switch after promotion passes;
  - a direct-only plan, and a plan with no landing facts, pass.

## 4. Increments

- [x] 4.1 Implement the integration `land` (renamed from `nextLandingStep`, design D1): direct's steps 1 to 3 reused unchanged, then the candidate insert (D5). Verify with tests:
  - an up-to-date change's candidate is the round's commit, already `passed`;
  - a change behind the integration head gets `update-branch` and a carried round, and its candidate stays `verifying` until the carried CI passes;
  - outside commits are recorded only when the baseline differs from the reference, and back-to-back landings flag nothing.
- [x] 4.2 Implement the `fast-forward` effect and the landing transaction (D5). Verify with tests:
  - the integration head becomes C itself;
  - the landing fact has mechanism `integration-branch`, `head_sha = merge_sha = C`, the re-read `base_sha`, `tree_verified = 1`, and no `post_ci_json`;
  - the task is done with Kawai's acceptance, and dependents become schedulable;
  - the plan completes on the last landing and shows as not yet promoted.
- [x] 4.3 Implement the moved and rewritten rules and the `fast-forward` inspector (D6). Verify with tests:
  - a branch moved by hand supersedes the candidate, returns the change to the up-to-date step keeping the slot, and flags the owner's commit on the next candidate;
  - a refused fast-forward (422) is handled the same way;
  - a rewritten branch stops the change as `integration-rewritten`, naming the head and the missing commit, and Retry after a restore lands a new candidate;
  - a restart after the fast-forward records the landing without moving the branch again, and a restart before it runs the fast-forward again.
- [x] 4.4 Implement failed candidates (D7). Verify with the R15 test (`b` fails once merged with `a`; the branch keeps `a`'s candidate; `b` gets a fix attempt naming the checks) and the R16 test (`a` lands first; `b`'s candidate builds on it with its own CI; `a`'s evidence never counts for `b`).
- [x] 4.5 Append `integration-rewritten` to the stop reasons, with its Retry rule (check again), and document integration landing in an AGENTS.md bullet. That bullet is the docs for groups 3 and 4. Verify with a Retry test and by reading the bullet against D2–D8.

## 5. Promote and Cancel

- [ ] 5.1 Implement `PromotionService.preview` and `promote` with `PROMOTE_PRECONDITIONS` (D9): reads first, then one transaction with replay, preconditions, the insert, and `promotion-started` through the new `PlanService.recordPromotionEvent` (C3, C6). Verify with tests:
  - each of the eight entries refuses by name and writes nothing, and every failing entry is listed;
  - a replay returns the same promotion, and a different `branch` or `fromSha` under the same id is refused naming the field;
  - two same-key Promotes that both passed the reads leave one promotion, through `UNIQUE (plan_id, command_id)`;
  - an agent caller is refused;
  - the preview lists the standing, the pinned head, the carried candidates, and outside commits;
  - a completed or cancelled plan can be promoted, and its state is unchanged.
- [ ] 5.2 Implement `cancel` (D9), recording `promotion-cancelled` through `recordPromotionEvent` with the compared payload `promotionId` and `reason`. Verify with tests:
  - while CI runs, the promotion finishes as cancelled with the reason, its pull request is closed, and its branch is kept;
  - during a merge that completes, it finishes as merged, the fast-forward runs, and the note says the cancellation came too late;
  - after the merge is recorded, Cancel is refused naming the merge;
  - a replay returns the same result, and a different `reason` under the same id is refused naming the field.

## 6. Promotion steps

- [ ] 6.1 Implement the pure `planPromotionSteps` (D10). Verify with unit tests for every transition:
  - it waits for the slot, naming the holder;
  - a conflict, or GitHub's 422, fails as `promotion-conflict` with the files;
  - a head failing the clean-merge check fails as `effect-failed`;
  - a target that moved goes back to the up-to-date step, and the third move fails as `target-moved`;
  - CI outcomes map to `ci-failed`, `ci-missing`, and `ci-timeout`, with the flaky rule.
- [ ] 6.2 Implement the promotion effects and their inspectors: `create-promotion-branch`, `open-pr`, `update-branch`, `rerun`, `merge`, `fast-forward`, and `close-pr`. Verify with adapter tests against a bare remote and a stub `gh`:
  - a restart after the merge was requested finds it merged and records the promotion without merging again;
  - three failures to reach GitHub while opening the pull request fail as `effect-failed`;
  - a `close-pr` that fails leaves the outcome and notes that the pull request is still open.
- [ ] 6.3 Implement the merge record and the integration fast-forward (D10 steps 7–10). Verify with tests:
  - a squash team still merges with a merge commit, and the default branch contains each landed candidate's commit;
  - `tree_verified` is 1 normally, and 0 when the target moves between the re-read and the merge;
  - the integration branch moves to P, and the next change is provisioned from P;
  - an integration branch moved during the promotion is left as it is, with the promotion merged and its note saying why;
  - `promotion-finished` is written once under `promo:<id>:finish`.
- [ ] 6.4 Share the landing slot with `holder_kind = 'promotion'` and the promotion's id as `holder_id`, and give `executionStore`'s orphan clearing the promotion liveness check (D10 step 3). Document promotion in an AGENTS.md bullet. That bullet is the docs for groups 5 and 6. Verify with tests and by reading the bullet against D9–D10. The tests:
  - another plan's direct change waits, showing the promotion;
  - a promotion waits for a change holding the slot, showing that change;
  - a promotion holder whose promotion finished, has a recorded merge, or is missing is cleared and logged at startup and when the slot is found taken, while a running promotion's holder stays.

## 7. Agent surface and protocol

- [ ] 7.1 Add `integration` to `plan_get`, and name the integration branch as the base in the execution-task instruction and plan note (D12). Add `plan_get`'s `integration` field and the base-branch instruction to the integration bullet (4.5). Verify with tool tests: the result lists the branch, head, candidates, and promotions, and the tool list has no promote or cancel tool.
- [ ] 7.2 Add `team-plan-promotion-preview`, `team-plan-promote`, and `team-plan-promotion-cancel` to the shared types and `CHAT_CONNECTION_TYPES`, wire them in `promotionConnections.ts`, and push `team-plan-detail.integration` after every write (D13), naming the three messages in the promotion bullet (6.4). Verify with connection tests: each type routes, refusals come back in `team-plan-result`, and a candidate write pushes the detail.

## 8. Client

- [ ] 8.1 Add integration views and per-dialog command ids to `teamPlanStore`: Promote is minted at open and again when `fromSha` changes, and Cancel has its own (D13). Verify with store tests, and by grepping that every applying method has a dispatch caller.
- [ ] 8.2 Build `PlanIntegrationPanel.tsx`, `PlanPromoteDialog.tsx`, and `PlanPromotionRow.tsx`, plus progress's promoted marks (D11, D13), and describe the panel, the dialog, and the marks in the promotion bullet (6.4). Verify with component tests:
  - the chain is newest first, with the failed candidate kept beside its replacement and outside commits flagged;
  - Promote is offered only while something is left to promote and nothing of the plan runs;
  - the dialog lists the carried changes, flags an outside commit, and names the pinned head;
  - a `no-execution` refusal shows inline;
  - progress marks two of three landed changes as promoted;
  - every control disables while disconnected.
- [ ] 8.3 Add a browser walkthrough `tests/e2e/plan-integration.spec.ts` with the fixture adapter, named in `.github/workflows/ci.yml`. Verify by running it alone on a spare `E2E_PORT` after `bun run build`, then checking that `curl http://localhost:4040/` still answers.

## 9. Integration checks

- [ ] 9.1 Add an integration test with a bare remote and a stub `gh`: two changes landing on the integration branch, a promotion over a default branch that moves once, and a restart in the middle of a fast-forward. It needs no docs. Verify that it passes.
- [ ] 9.2 Run `bun run lint && bun run typecheck && bun run test` and `openspec validate integration-candidates --strict`. Verify that all pass.

## Workflow follow-up

- Archive the change once it has merged and the review requirements are satisfied, then verify the archived specs validate.
