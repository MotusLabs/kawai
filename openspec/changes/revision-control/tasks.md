# Tasks

**Split (proposed 2026-11-18, needs the owner's plan approval).** Groups 1–4 landed (PR #298 and its stack, `a2ac8ecb`). Group 5, the executions' revisions of 6.1, and the Apply parts of 7.1–7.3 move to the new change `plan-revision-apply`; its tasks.md carries them, so they are listed here only as moved. Group 9 below is this change's remaining executable slice; its contract is at the end of design.md. No box here is ticked or unticked by the split.

Original note: implement after these have landed on master: `plan-execution`, `integration-candidates`, and `plan-supervision`, together with what they build on (`durable-plans`, `strategy-revision-impact`, and `plan-validation`). Then rebase this branch onto master. Every file stays under 500 LOC. Tests that spawn git use `cleanGitEnv`. Tests never reach GitHub: they put a stub `gh` executable on a private `PATH` and use a local bare repository as `origin`.

## 1. Shared model and contracts

- [x] 1.1 Reconcile names with the merged designs, and record any renames in this design before coding. Verify by reading against D3–D5, D10–D11, and D13–D16 here:
  - plan-execution's D3, D4, D9, D12, D14, D18, and D20: `planSteps` and its decide/dispatch split, `START_PRECONDITIONS`, `plan_landing_slots`, the effect kinds and inspectors, `AttemptManifest`, `recordExecutionEvent`, and `TaskService.setStatus(…, alsoWithin)`;
  - integration-candidates' D5, D9, and I2: the fast-forward, `PROMOTE_PRECONDITIONS`, and the promotion steps;
  - plan-supervision's D10, D13, and S1–S4: the cause list and its order, `ATTENTION_SOURCES` kinds, the `plan` link, `fixStatus`, and the system caller's origins;
  - the shipped `TaskService` publication path, including the `within` variant the proposal's Impact names, `MemberRelease.readiness`, and member release's durable pending row for a Restart whose spawned holder is not yet ready.
- [x] 1.2 Create `src/shared/planRevisionControl.ts` with hold, pause, target, checkpoint, delta, and view types, and a header comment naming them. Verify with a typecheck.
- [x] 1.3 Implement the pure `holdGate` (D5), `pauseTargetState` (D8), and `revisionDelta` (D10). Verify with unit tests:
  - a change is held by a plan hold, by a changes hold, and no longer once its row is released;
  - every D8 cause and its precedence;
  - `metadata` for a landed change differing only in `dependsOn` or `fixes`, `fixes` as a compared field, and `lead-changed` as informational;
  - Paused only from `paused_at`, and `holder-killed` only for a killed holder with nothing pushed;
  - each delta class and its changed fields;
  - `landing-changed`, `plan-rules-changed` only once something landed, and `landed-changed` ignoring `dependsOn`;
  - a waiting changed change gets choice `none`.

## 2. Records and events

- [x] 2.1 Add the D2 migration in `src/server/plans/revisionControl/revisionControlSchema.ts`, with the seq-1 backfill of `plan_execution_revisions`. Verify with a migration test on a fresh database and on one with plan-execution tables and rows, run twice.
- [x] 2.2 Implement `holdStore.ts`, `pauseStore.ts`, `checkpointStore.ts`, and `executionRevisionStore.ts` as the only SQL writers of those tables, with header comments saying so. The records need no user docs beyond them. Verify with unit tests:
  - the guarded Paused and decision updates write once;
  - the execution revision primary key maps to `execution-revision-unchanged`;
  - superseding a checkpoint keeps the earlier one readable.
- [x] 2.3 Add `PlanService.recordRevisionControlEvent` and the six D3 kinds (C3, C6). Verify with unit tests: each kind replays by `(plan_id, command_id)` over its compared payload, and is refused naming the first differing field.
- [x] 2.4 Start writes the seq-1 execution revision (D2): the inserted execution's columns in Start's transaction through `ExecutionRevisionStore`; a replayed Start writes none. Verify with a test through the composed stack (`executionComposition.test.ts` › "Start writes the seq-1 revision row in its transaction; a replay writes none and record takes seq 2"): exactly one seq-1 row equal to the execution's columns, none on replay, and a later `record()` at seq 2.

## 3. Holds

- [x] 3.1 Implement `HoldService.place`, `release` (whole, changes, and narrowing), and `extend` (D4), refusing non-human callers first. Verify with unit tests:
  - every refusal (closed plan, deadline in the past or beyond 30 days, empty rationale, unknown or repeated change, foreign cite) writes nothing;
  - narrowing is one transaction, and its replay writes nothing;
  - closing and reopening the plan leaves holds unchanged;
  - an agent caller is refused.
- [x] 3.2 Wire `holdGate` into `planSteps` (D5). Verify with executor tests:
  - provisioning, each attempt kind, the review and fix handoffs, D9's revision fix, and Retry's dispatch wait under a hold;
  - the round outcome is still recorded;
  - release wakes the executor, and each deferred dispatch runs while the change still stands on that attempt's round;
  - a running turn gets no mail.
- [x] 3.3 Wire the gate into direct and integration landing and promotion (D5), and append `no-hold` to `START_PRECONDITIONS` and `PROMOTE_PRECONDITIONS`. Verify with tests:
  - a slot holder before merge gives up the slot, and another change takes it;
  - a running merge and fast-forward settle;
  - a running promotion waits at `held` without the slot, then re-runs its up-to-date step;
  - Start under a plan hold is refused, and under a changes hold it succeeds with the change unprovisioned;
  - Promote carrying a held change is refused.
- [x] 3.4 Write the R10 integration test: a result arrives under a hold and is kept, its CI runs, no review or landing happens, and release resumes the same round. Add the AGENTS.md holds bullet; that bullet is the docs for group 3. Verify by the test, and by reading the bullet against D4–D5.

## 4. Pause and checkpoints

- [x] 4.1 Implement `PauseService.pause` (D6): the targets, withdrawal of unclaimed instructions through the stop branch, and urgent `plan-pause` system mail in the same transaction. Verify with tests:
  - one mail per holder, following forwards;
  - Kawai-held steps are listed as having no active work;
  - a queued instruction is superseded without `instruction-failed`;
  - a spawning instruction gets its mail after the claim;
  - a replay sends nothing;
  - an agent caller is refused.
- [x] 4.2 Implement `task_checkpoint` and the `push-checkpoint` effect with its inspector (D7). Verify with tests against a bare remote:
  - each refusal (no pause, wrong caller, not the branch head, dirty or untracked worktree listing paths, a commit that does not contain origin's head, Kawai writing the branch) writes nothing;
  - a valid call pushes without force;
  - an unknown effect is inspected after restart;
  - a failed push leaves the target Pausing with `checkpoint-push-failed`;
  - a result round counts as a checkpoint.
- [x] 4.3 Record Paused in the executor tick (D8). Verify with tests:
  - checkpoint pushed but the holder busy stays Pausing;
  - a pending approval stays pending and reads Pausing as `request` (R11);
  - an archived holder counts as ready, and a killed holder with nothing pushed reads Pausing as `holder-killed`;
  - a parked or cooling holder reads `provider-limit` with its reset, and the pause mail is never refused for cooling;
  - a change whose merge started lists as landing in progress;
  - Paused is recorded once.
- [x] 4.4 Implement `PauseService.resolve` (D9): Continue, Adapt through the `within` task publication, and Restart with the manifest's optional `checkpoint`. Stop closes the pause. Verify with tests:
  - Continue sends one `plan-resume` mail and creates no attempt, and is refused for a killed holder (`holder-gone`) and a withdrawn target;
  - Adapt publishes one revision with its notice, and D9's fix attempt follows;
  - Restart supersedes without cancelling claimed work, and the manifest names the checkpoint;
  - Restart releases a ready spawned holder first and never a human-created one;
  - Restart starts from origin's head with the "may predate" note when no checkpoint reached origin;
  - Restart is allowed from every Pausing state (including `no-checkpoint` for a holder that ignores the mail), with the "may predate" note when nothing reached `origin`, and the old holder's later submissions and checkpoints are refused;
  - Restart of a busy spawned holder marks it pending release, and the attempt's dispatch waits for the worktree;
  - a refused Continue leaves Restart and Stop;
  - Adapt and Restart under an active hold record at once and dispatch only after release;
  - `releaseHold` releases the change in the same transaction, and is refused for a whole-plan hold with the narrowing guidance;
  - Continue resumes under a hold;
  - a task revision published while the target is undecided dispatches nothing, and the following resolution names the newest revision with no second dispatch;
  - an old manifest's hash is unchanged by the optional field.
- [x] 4.5 Write the R01 and R18 integration tests:
  - R01: restart with a Paused target keeps the execution, attempt, and checkpoint, and Continue creates no attempt;
  - R18: restart after the pause mail and before any checkpoint re-derives Pausing, records no Paused, and sends no resume.

  Add the AGENTS.md pause bullet and the plan note's `task_checkpoint` rule (D15); that is the docs for group 4. Verify by the tests, and by reading the bullet and note against D6–D9.

## 5. Apply (moved to `plan-revision-apply`, tasks 1.x–3.x there)

- [ ] 5.1 **Moved to plan-revision-apply.** Implement `ApplyService.preview` and `apply` with `APPLY_PRECONDITIONS` (D11): reads first, then one transaction. Verify with tests:
  - each entry refuses by name and writes nothing, and every failing entry is listed;
  - two concurrent Applies on one base leave one revision row;
  - an agent caller is refused;
  - the preview lists the delta, the needed choices, and the generated Adapt texts.
- [ ] 5.2 **Moved to plan-revision-apply.** Implement the per-change writes (D11). Verify with tests:
  - continue keeps the attempt, and later handoffs read the new revision;
  - adapt publishes one task revision with notify;
  - restart dispatches under the new revision;
  - added changes are scheduled by dependencies, or are landed when a fact exists;
  - removed unlanded changes and their tasks are cancelled, with the slot given up;
  - the publication rows and `revision-applied` commit together;
  - completion reads the current revision (D12).
- [ ] 5.3 **Moved to plan-revision-apply.** Write the R17 integration test: a crash before commit leaves nothing; a retry after commit replays, with one task revision and one notice per adapted change. Add the S4 forward-fix test: a change whose `fixes` names a fix task is applied to a running execution and lands, `fixStatus` reads running, and the fix task closes once no change of the current approved revision naming it is unlanded. Add the negative case (D11): a fix change removed before it lands is cancelled, and its fix task stays open. Add a `fixes`-only difference on a landed change, which applies as `metadata` with no choice. Add the AGENTS.md Apply bullet; that is the docs for group 5. Verify by the tests, and by reading the bullet against D10–D12.

## 6. Reading, supervision, and attention

- [ ] 6.1 **Split: `holds` and `pauses` are 9.2 here; executions' `revisions` moved to plan-revision-apply.** Add `holds`, `pauses`, and executions' `revisions` to `team-plan-detail` and `plan_get` (D14, D15). Verify with connection and tool tests: another team's ids read as not found, and pushes follow every write and every Paused recording.
- [ ] 6.2 **Carried out by 9.3.** Add the `paused`, `pausing`, and `hold` causes in their D13 position, and the three attention sources. Verify with tests:
  - each cause wins in its position (after `effect`, in the order `paused`, `pausing`, `hold`, before `uncertain-delivery`), and the others are listed as also applying;
  - none raises a `no-progress` stall, and `repeating-failure` keeps its S2 position ahead of them;
  - each item's id, owner, next action, and clearing rule, including after an extension;
  - `plan-checkpoint-decision` for Paused, `holder-killed`, and `checkpoint-push-failed` targets, and only `plan-pause-overdue` for a target past its deadline for another cause;
  - nothing is raised for closed plans.

  Needs no docs beyond the AGENTS.md bullets of groups 3–5.

## 7. Human protocol and the view

- [ ] 7.1 **Split: the hold and pause messages are 9.1 here; the two Apply messages moved to plan-revision-apply.** Add the D14 messages to `src/shared/planMessages.ts` and `CHAT_CONNECTION_TYPES`, and their handlers in `revisionControlConnections.ts`. Verify with router tests: every type is whitelisted, `unknown-team` is refused, and each result carries its record or error.
- [ ] 7.2 **Split: the hold, pause, and checkpoint dialogs are 9.4 here; the Apply dialog moved to plan-revision-apply.** Add the `teamPlanStore` command slots and the components of D14. Verify with component tests:
  - each dialog arms one command id and reuses it while the payload is unchanged;
  - refusals render every failing check;
  - every control disables while disconnected;
  - Pausing shows its causes and never reads Paused;
  - Apply asks a choice only for changed changes with tasks.

  Every store apply method has a dispatch caller.
- [ ] 7.3 **Split, and obsolete in part (2026-11-18): CI no longer names spec files in `.github/workflows/ci.yml`; `scripts/e2e-fixture-specs.ts` lists every fixture-gated spec. The hold-to-Continue walkthrough is 9.5 here; the Apply step moved to plan-revision-apply.** Write one browser walkthrough with the fixture adapter, `tests/e2e/chat-plan-revision-control.spec.ts`, named in `.github/workflows/ci.yml`: hold a change, pause it, record a checkpoint, see Pausing turn into Paused, Continue, and Apply a revision with one adapted change. Run it alone on a spare `E2E_PORT` after `bun run build`. Needs no docs beyond the AGENTS.md bullets.

## 8. Checks

- [ ] 8.1 **Carried out by 9.7 for this change; plan-revision-apply runs its own.** Run `bun run lint && bun run typecheck && bun run test` and `openspec validate revision-control --strict`. Verify that all pass, apart from the informational note for the unarchived `plan-execution` requirement.

## 9. Remainder: visibility, attention, human protocol, and view (proposed slice)

Contract at the end of design.md; oracles in design "Remainder". Server first (9.1–9.3, one production-path checkpoint after 9.1, whose every prerequisite is in 9.1), then the client (9.4–9.5). plan-revision-apply's 2.2 and 3.1 start after 9.1–9.2 land (shared `planMessages.ts`, `chatConnectionTypes.ts`, and `planSupervisionDetail.ts`), and its 3.2–3.3 after 9.4–9.5 (shared `teamPlanStore.ts` and `PlanExecutionSection.tsx`). Every file stays under 500 lines.

- [ ] 9.1 Add `team-plan-hold-place`, `team-plan-hold-release`, `team-plan-hold-extend`, `team-plan-pause`, and `team-plan-pause-resolve` to `src/shared/planMessages.ts` and `CHAT_CONNECTION_TYPES` (`src/server/chat/chatConnectionTypes.ts`), with handlers in a new `src/server/plans/revisionControl/revisionControlConnections.ts` composed in `planComposition.ts`, each answered by `team-plan-result`; and the minimal detail PT6 reads: `holds` (DV1's fields) in `team-plan-detail` (`src/server/plans/supervision/planSupervisionDetail.ts`), pushed after every hold place, release, and extend. Verify PT1–PT6 through the real connection router and `planComposition`; mutants: a type left out of the whitelist (PT1), the handler not composed (PT6), the push after a hold write removed (PT6). Checkpoint: the production path of PT6 (place over the socket, the push carries the hold) plus PT3's refusal, reviewed before 9.2.
- [ ] 9.2 Add `pauses` (targets with state, causes, holder, checkpoints, and decisions) to `team-plan-detail`, and `holds` and `pauses` to `plan_get`, pushed after every pause and resolve write and every Paused recording (9.1 already pushes after hold writes). Verify DV1–DV4 with connection and tool tests; mutants: the push after a Paused recording removed (DV3), the team check removed (DV4).
- [ ] 9.3 Add the `paused`, `pausing`, and `hold` causes after `effect` in the running-stage waits (`src/shared/planSupervision.ts`), and the three attention sources in `ATTENTION_SOURCES`. Verify CA1–CA6 and AT1–AT10 as table-driven tests, property AP-1, and one row each through the real `SupervisionMonitor` (no stall for a held change, CA3) and the real workspace read (AT1); mutants: `hold` placed after `uncertain-delivery` (CA4), the overdue key without the deadline (AT3), `plan-pause-overdue` raised beside `plan-checkpoint-decision` (AT7).
- [ ] 9.4 Add the `teamPlanStore` command slots and `PlanHoldsSection.tsx`, `PlanHoldDialog.tsx`, `PlanPauseSection.tsx`, and `PlanCheckpointDecisionDialog.tsx`, opened from the plan detail and the execution section. Verify UI1–UI5 with component tests; every store apply method has a dispatch caller.
- [ ] 9.5 Write `tests/e2e/chat-plan-revision-control.spec.ts`, skipped unless `AGENTBOARD_CHAT_FIXTURE=1` like the other plan specs, so `scripts/e2e-fixture-specs.ts` lists it for CI's fixture step: hold a change, pause it, record a checkpoint, see Pausing turn into Paused, Continue. Verify: `bun scripts/e2e-fixture-specs.ts` lists the file, and CI's fixture job passes it. Local runs only in a disposable checkout with its own build, database, and spare `E2E_PORT`; never `bun run test:e2e`.
- [ ] 9.6 Map every plan-holds and plan-pause scenario to a literal test title (design "Scenario partition") and add `@covers: plan-holds › …` and `@covers: plan-pause › …` annotations above them. A landed scenario whose test cannot be found becomes a failing gap row, not a silent pass. Verify: the citation preflight reports zero unresolved, and `scripts/__tests__/specCoverageGuard.test.ts` passes.
- [ ] 9.7 Run `openspec validate revision-control --strict`, the affected tests, and `bun run check --full-properties` on the clean committed head under the pinned Bun, then `scripts/verify-result.ts`. Verify: all pass; the result maps every oracle id of the remainder to a test title and a killed mutant.
