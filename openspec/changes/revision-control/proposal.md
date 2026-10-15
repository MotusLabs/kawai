# Proposal

## Why

Strategy revision 2 makes the owner the owner of intent and of the plan (P1). Lead decisions are provisional (P2), overrides become forward fixes (P3), and results must be trustworthy before throughput (P10). `plan-execution` runs one approved plan revision to completion. Its rule "A running execution keeps its revision" protects running work from silent redirection, but it leaves the owner only two levers once they learn the direction is wrong:
- **Stop** throws away every unlanded change;
- **let it run** lets work the owner no longer wants land on the base branch.

`plan-supervision` can record an override and plan its forward fix (S4), but the fix joins only a later execution. Meanwhile the change it corrects keeps running and may land first. `strategy-revision-impact` lets the owner mark a plan `reconsider` (C-I3), and its proposal says that "a real hold on a plan arrives with `revision-control`".

The multi-agent design names the missing protocol ("Publication, holds, and checkpoint protocol"):
1. record the decision and hold before notifying;
2. stop scheduling affected work;
3. ask the holders to stop at a safe point and save a durable checkpoint;
4. never show a false Paused;
5. let the owner choose Continue, Adapt, Restart, or Cancel.

Barriers keep stale work from passing integration. Its tests R01, R10, R11, R17, and R18 describe the guarantees: a paused execution survives restart, a result under a hold is kept but cannot land, a pause beside a pending approval never approves it, and a crash during publication or pause never doubles a revision or invents a Paused state.

## What Changes

- **Impact holds.** The owner places a hold on a whole plan or on named changes, under a command id:
  - The hold records owner, rationale, scope, creation time, and a required review deadline. It may cite a strategy impact review (`reconsider`, C-I3) or a decision card (S1).
  - While a change is held, Kawai starts no new attempt or handoff for it, gives it no landing slot, and runs no merge, fast-forward, or promotion that includes it. A held change that holds the slot gives it up before its merge starts. A merge already running settles.
  - A hold interrupts no running turn. A result submitted under a hold is kept and gated up to the barrier (R10).
  - A whole-plan hold also refuses Start, through the appended precondition `no-hold` (X5), and refuses Promote.
  - The owner releases a hold by scope (whole, some changes, or narrowing a plan hold to named changes) and extends its deadline. A passed deadline raises attention and never releases the hold.
- **Pause with a durable checkpoint.** On an active hold, the owner chooses **Pause affected work** with a pause deadline:
  - In the same transaction, Kawai sends each holder of a held change's current agent stage an urgent direct system mail. The mail asks the holder to stop at a safe point, commit the work in progress with a clean worktree, and call the new agent tool `task_checkpoint`.
  - `task_checkpoint` records the commit, summary, unfinished actions, errors and tests, and next steps. Kawai checks that the commit is on the change branch and pushes it as the new `push-checkpoint` effect. Kawai stays the only writer of change branches (plan-execution D18, X3).
  - A target reads **Pausing**, with its cause, until its checkpoint commit is on `origin` and its holder is ready under member release's readiness. Only then does Kawai record **Paused**. A result whose round push landed counts as the checkpoint. A review holder needs readiness only. A holder that was killed without a checkpoint reads **Checkpoint lost**.
  - Pending approvals and questions stay unresolved, and urgent-direct semantics are unchanged (R11). A passed pause deadline raises attention. Nothing is ever killed.
  - Per paused change, the owner chooses:
    - **Continue**: the same attempt, with a resume mail to the same holder and no new attempt (R01);
    - **Adapt**: publish a new task revision with notify through the shipped publication path, which returns the change for re-evaluation (plan-execution D9);
    - **Restart**: a new attempt from the checkpoint commit, carrying the checkpoint package;
    - **Cancel**: the existing execution Stop.
- **Apply an approved plan revision to a running execution.** An owner command under a command id, compare-and-swapped on the execution's current revision:
  - Kawai classifies every change as unchanged, changed, added, or removed against the execution's revision (C1).
  - For each changed change the owner picks continue, adapt, or restart. Adapt publishes a task revision with notify.
  - Added changes are scheduled by their dependencies. Removed changes that have not landed are cancelled as Kawai's own tasks.
  - It refuses:
    - a landed change whose definition changed, or that was removed;
    - a change of landing mode or integration branch;
    - a change of plan-wide acceptance rules or extra checks once a change has landed.

    Each refusal points to a forward fix (P3).
  - The target revision needs V1 standing and Start's preconditions for the changes it adds.
  - One transaction records the execution's next revision row, the publication record (rationale, per-change classification and choice, the task revisions it published, and their notices), and a `revision-applied` plan event. A retry under the same command id replays and publishes nothing twice (R17).
  - This is how S4 forward fixes join running work.
- **Reading and attention.**
  - `plan_get` and `team-plan-detail` carry holds, pauses with their targets and checkpoints, and the execution's revision history with its publications.
  - Supervision names the new causes `hold`, `pausing`, and `paused`.
  - The attention queue raises overdue holds, overdue pauses, and paused changes awaiting a decision.
  - No agent tool places, releases, or extends a hold, pauses, resolves a pause, or applies a revision.

Non-goals:
- **Owned by `execution-safety-recovery`:** the outbound-action audit log, the crash and fault matrix, leases, epochs and fencing tokens, backups, and budgets. This change publishes the records it needs (R1–R4).
- **Contract work:** typed relations, contract registries, and archive automation.
- **Agent-side controls:** any agent-side hold, pause, resume, or apply.
- **Pause sweeps beyond plans:** pausing standalone tasks, or holds outside a plan.
- **Forced termination** of a holder that does not stop.

## Capabilities

### New Capabilities

- `plan-holds`:
  - placing, releasing, narrowing, and extending holds;
  - what a hold blocks in execution, landing, and promotion;
  - results under a hold;
  - `no-hold` at Start;
  - the `hold` cause and the overdue-hold attention item.
- `plan-pause`:
  - Pause on a hold, and the pause mail;
  - the `task_checkpoint` tool and the `push-checkpoint` effect;
  - Pausing, Paused, and Checkpoint lost, and their recovery after restart;
  - the four choices;
  - the `pausing` and `paused` causes and their attention items.
- `plan-revision-apply`:
  - the Apply command and its preconditions;
  - the revision delta and per-change choices;
  - added and removed changes, and the landed-change refusals;
  - the execution revision history and the publication record.

### Modified Capabilities

- `plan-execution`, in the unarchived `plan-execution` change. Its requirement "A running execution keeps its revision" now allows the owner's Apply. Approval alone still changes nothing.

## Impact

- **Server.** New `src/server/plans/revisionControl/`:
  - `holdStore.ts`, `holdService.ts`, and the pure `holdGate.ts`;
  - `pauseStore.ts`, `pauseService.ts`, the pure `pauseState.ts`, and `checkpointTool.ts`;
  - `applyService.ts`, the pure `revisionDelta.ts`, and `applyPreconditions.ts`;
  - `revisionControlConnections.ts`.

  Existing modules gain hooks:
  - the executor's `planSteps` reads the hold gate;
  - the landing mechanisms and `PromotionService` consult it before the slot, the merge, and the fast-forward;
  - `START_PRECONDITIONS` and `PROMOTE_PRECONDITIONS` gain `no-hold`;
  - `PlanService` gains `recordRevisionControlEvent`;
  - `TaskService` publication gains a `within` variant;
  - the effects runner gains `push-checkpoint`;
  - supervision gains the three causes;
  - `planAttention.ts` gains three sources.
- **Shared.** New `src/shared/planRevisionControl.ts`: holds, pauses, checkpoints, the delta, and the views. The new messages go in `src/shared/planMessages.ts` and `CHAT_CONNECTION_TYPES`.
- **Client.** `PlanHoldsSection.tsx`, `PlanHoldDialog.tsx`, `PlanPauseSection.tsx`, `PlanCheckpointDecisionDialog.tsx`, and `PlanApplyRevisionDialog.tsx`, plus `teamPlanStore` wiring.
- **Data.** An additive migration with seven tables: holds, hold changes, pauses, pause targets, checkpoints, execution revisions, and publication changes. A backfill writes revision 1 of each existing execution's history.
- **Docs.** AGENTS.md bullets for holds, pause and checkpoints, and Apply, and the plan note's `task_checkpoint` rule.
- **Tests.** Unit and integration coverage of every command, gate, and state. That includes R01, R10, R11, R17, and R18 as server integration tests, plus one browser walkthrough with the fixture adapter, named in `.github/workflows/ci.yml`.
- **Sequencing.** Implement after `plan-execution`, `integration-candidates`, and `plan-supervision`, whose contracts X1–X8, I2, and S1–S4 it binds.
