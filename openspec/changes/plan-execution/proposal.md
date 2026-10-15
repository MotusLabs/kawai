# Proposal

## Why

Three Wave C changes give a plan its records and checks:
- `durable-plans` records an approved plan;
- `plan-validation` checks the plan against the repository;
- `strategy-revision-impact` gates its strategy pin.

None of them runs anything. After approval the Lead still executes a plan by hand:
- create worktrees and tasks, and dispatch devs;
- push branches, open PRs, and watch CI;
- request reviews, return findings, and merge on green.

Every step depends on the Lead's chat memory and turn budget. Waves B and C were run exactly this way. The stalls they hit are what strategy UC2 asks Kawai to remove, with the owner away: "The whole plan implemented, verified, and landed per its landing mode". Those stalls were provider limits, reports that never arrived, reviews nobody requested, and merges waiting for a session to come back.

Strategy revision 2 states how execution works:
- **Product approach:** "Execution: Kawai orchestrates … gates every change on the mandatory check floor … plus the plan's extra checks."
- **P5:** landing mode is chosen per plan, and landing is acceptance.
- **P6:** the floor gates every change.
- **P7:** "A change that fails three consecutive fix rounds stops and reports; known flaky tests do not count; independent work continues."
- **P8:** "Each role declares its provider profiles; Kawai routes and recovers across them."
- **P9:** durable records over chat memory.

`durable-plans` assigned this change:
- Start;
- plan and task execution attempts;
- dependency-ordered dispatch;
- gating on the floor and extra checks;
- direct landing;
- the three-round stop;
- the landing-fact record and system completion for both landing modes (design D8, D10, and D13 rows C3, C5, and C7).

`plan-validation` (contracts V1–V5) and `strategy-revision-impact` (C-I1) fixed what Start binds to.

## What Changes

- **Start, human only.** The owner starts the current approved revision from the Plans view under a command id. A replay returns the prior execution. Start reads the file-held validation inputs and runs the landing probe just before one transaction. That transaction evaluates named preconditions and reports every failing one:
  - `plan-open`, and `revision-current`: the revision and hash are the current approved ones.
  - `validation-current` (V5): plan-validation's entry. The newest report is ready, and its input hash equals the inputs recomputed now (R06).
  - `start-conditions-resolved` (V2): carried `start` conditions are resolved.
  - `strategy-impact` (C-I1): `ImpactService.gate` passes.
  - `one-execution`: no running execution of this plan.
  - `changes-unclaimed`: no running execution of another plan owns one of this plan's unlanded changes.
  - `roles-routable`: every implementing group is worktree-scoped, and every role keeps at least one profile its group allows.
  - `landing-ready`, the landing probe:
    - git is available, and an authenticated `gh` reaches the `origin` GitHub repository and its default branch;
    - every floor check maps to a CI check;
    - no branch or worktree carries a change's name unless this plan created it.
  - `landing-mode-supported`: `integration-branch` is refused until `integration-candidates` lands.

  Start records the execution: the revision and hash, the validation report and input hash, the base branch and its commit, the floor and its CI mapping, and the starter. It writes no task or mail; scheduling begins after the commit.
- **Scheduling.** Kawai schedules a change once every dependency has **landed**, up to a per-team parallel limit (default 3). V3's serialized pairs need nothing more, because `dependsOn` already orders them. A change landed by an earlier execution of the same plan is never run again.
- **Explicit provisioning.** Kawai creates `.worktrees/<change>` on branch `<change>` from the base branch's current commit. That commit is recorded as the change's baseline. Provisioning is an execution step, never a side effect of mail, so `team-worktree-staffing` still creates no worktree. A later execution of the plan reuses the change's worktree and branch.
- **Kawai-owned tasks and dispatch.**
  - Kawai creates one task per change. The task is linked to the plan change (C5), targets the worktree, and names the OpenSpec change. Its creator is Kawai, the system.
  - Kawai dispatches it through task assignment to the change's group. Kawai is the mail's sender, with no session, and a reply to Kawai is refused with guidance.
  - Each dispatch is an **attempt** (implement, fix, or update) with an immutable input manifest. It records the plan revision and hash, the task revision, the report and input hash, the baseline, and the change's artifact digests. A fix attempt also records the result and findings it answers.
  - Execution mail routes only to profiles that both the group and the plan role allow, in the role's order (P8). Review mail is tagged with the result authors' profiles, so a routing rule can pick another model family.
  - While an execution owns a change, only Kawai links tasks to it, dispatches its task, and hands it off. The human steers through Stop, Retry, and closing the task, and an instruction that fails stops the change rather than being replaced silently.
- **Results.** For an execution task, `task_submit_result` refuses three kinds of result, so a malformed result costs no round:
  - a result without a commit;
  - a commit that is not on the change's branch;
  - a commit that does not extend the branch's published head.
- **The gate, one round per result.**
  - Kawai pushes the commit to `origin`, never forcing, and opens or reuses the change's PR.
  - **CI.** Every check reported for the head must pass or be skipped. Each floor check (lint, typecheck, unit tests, CI end-to-end) must be covered by a mapped check. Failed checks are rerun once on the same commit. A check that then passes is recorded as flaky and fails nothing; this is how Kawai applies P7's "known flaky tests".
  - **Review.** Once CI passes, Kawai hands the result to the change's review group. The floor's clean reviewer verdict requires a `pass` on that exact result from the handoff's claimant, and the claimant must not be an author of the change's results. A worktree-scoped review group first gets the worktree through member release.
  - **Extra checks.** An extra check named like a reported CI check is satisfied by that check. Any other extra check is listed for the reviewer, along with the acceptance rules, and is shown as attested.
  - A verdict never transfers to another commit, except over Kawai's clean base merge (below). A newer result, or a task revision the human publishes before the merge, supersedes the round.
- **Fix rounds and the stop.** A failed round returns the change to its group with the failing checks and findings. When three consecutive fix rounds fail, the change stops and reports. Dependents wait, and independent changes continue. The owner can **Retry** a stopped change, which starts a new count, or **Stop** the execution.
- **Direct landing.** Passed changes land one at a time per team.
  - **Up to date.** The branch must contain the base branch's current commit. If it does not, Kawai updates the branch on GitHub with a base merge.
    - A clean update reruns CI and keeps the review verdict, recorded as carried over a clean base merge.
    - A conflicting update returns the change as an update attempt.
  - **Conditions.** Carried `acceptance` conditions (V2) must be resolved first, because each landing is acceptance (P5).
  - **Merge.** Kawai merges with the reviewed head pinned, using the team's merge method (merge commits by default).
  - **Landing fact.** It records the PR, head, base, and merge commit. Kawai accepts the landed result as the task's creator, which closes the task and releases its spawned members.
  - **Worktree.** Kawai removes it when it is clean and no session lives there.
  - **Plan completion.** When every change of the revision has landed, Kawai completes the plan as `system`, provided that revision is still the approved one.
- **Effects recorded before they run.** Each external step is a durable effect row with its command and outcome: worktree add, push, PR, rerun, branch update, merge, and worktree removal. A restart resumes from stored state. An unknown outcome is inspected (the remote ref, the PR state, the worktree list) and never blindly repeated. When inspection cannot decide, the change stops with the reason.
- **Visibility.**
  - The Plans view gains an Execution section:
    - **Start execution**, with the standing of each precondition;
    - each change's state and waiting reason, task, branch, PR, rounds, CI and review evidence, and landing fact;
    - **Retry** and **Stop execution**.
  - For executed plans, landing facts replace the "tasks done" progress proxy (D10).
  - `plan_get` includes executions. No agent tool starts, stops, or retries one.
- **Operator configuration.** Per team, in the user-level `~/.kawai/teams.json` and never in project files: `planExecution.floorChecks`, `maxParallelChanges`, and `mergeMethod`.

Non-goals:
- Lead decision cards, overrides as fix tasks, richer progress, and usage per role and profile. These belong to `plan-supervision`.
- Holds, checkpoints, leases, and publishing a new revision to running work (`revision-control`). A running execution keeps its revision, and a newly approved one runs in a new execution.
- Security rules in prompts, the outbound audit view, process containment, and the full crash matrix (`execution-safety-recovery`).
- The integration-branch mechanism (`integration-candidates`). It implements this change's landing contract.
- Archiving landed changes (V4 Archive). The Lead archives them as today.
- Running extra-check commands on the host, pausing, and production deployment.

## Capabilities

### New Capabilities

- `plan-execution` covers:
  - Start and its preconditions;
  - execution records, scheduling, and provisioning;
  - Kawai-owned tasks, attempts, and manifests;
  - the gate rounds, the three-round stop, Retry, and Stop;
  - restart and system completion;
  - agent visibility and the Execution section.
- `plan-landing` covers:
  - the landing probe;
  - pushes and PRs;
  - CI evidence and reruns;
  - the up-to-date rule and branch updates;
  - serialized merges and landing facts;
  - worktree cleanup and effect records;
  - the landing contract for the integration-branch mode.

### Modified Capabilities

- `team-tasks`: Kawai creates and closes execution tasks, linked to the execution's revision. While an execution owns a change, only Kawai links tasks to it. Delivered mail names the execution.
- `task-assignment`: Kawai can be a dispatcher, and only Kawai dispatches a running change's task.
- `agent-mailbox`: Kawai can be a sender, and replies to its mail are refused with guidance.
- `task-results`: results for execution tasks are checked at submission, and Kawai owns a running change's handoffs.
- `team-routing-rules`: plan roles narrow the profiles that execution mail may use, and review mail names its authors' profiles.

## Impact

- **Server.**
  - New `src/server/plans/execution/`:
    - schema and store;
    - `ExecutionService` (Start, Stop, Retry, and rights) and the Start preconditions;
    - scheduler, attempts and manifests, and the gate;
    - the executor loop.
  - New `src/server/plans/landing/`: the git and `gh` adapters, the probe, direct landing, landing facts, and the effects runner.
  - `PlanService` gains system completion.
  - `TaskService`, `AssignmentService`, `TaskResultService`, and the mailbox gain a system actor.
  - `routing/candidates.ts` gains the role-profile filter, and `teamCaps.ts` reads `planExecution`.
  - `teamPrompt.ts` gains an execution note, and the plan connections gain the Start, Stop, and Retry messages.
- **Shared.** New `src/shared/planExecution.ts` holds the types and pure functions: round evaluation, the flaky rule, and state derivation. The new messages go in `src/shared/types.ts` and `CHAT_CONNECTION_TYPES`.
- **Client.** `PlanExecutionSection.tsx` with the Start dialog and change rows, plus `teamPlanStore` wiring.
- **Data.** An additive migration with five tables and one nullable `team_messages` column. `system` becomes a creator, dispatcher, and sender kind in existing text columns. There is no backfill.
- **Docs.** AGENTS.md bullets, and the author-profile tags in `docs/routing/README.md`.
- **Tests.**
  - Unit coverage of the preconditions, scheduling, manifests, rounds, the flaky rule, Stop and Retry, restart inspection, and cross-team refusals.
  - The adapters are tested against a stub `gh` and a local bare remote.
  - One browser walkthrough with a fixture adapter, named in `.github/workflows/ci.yml`.
- **Sequencing.**
  - Implement after `durable-plans`, `strategy-revision-impact`, and `plan-validation`.
  - `integration-candidates` follows and implements the landing contract.
  - `plan-supervision`, `revision-control`, and `execution-safety-recovery` build on this change's contracts (design D14).
