# Proposal

## Why

The approved product strategy (`kawai` revision 2) organizes work in two modes. In planning, the owner and a Lead agent agree an implementation plan for one repository: an ordered set of OpenSpec changes with dependencies, acceptance rules, any checks beyond the mandatory floor, a landing mode, and the roles and provider profiles that execute it. In execution, Kawai delivers that plan. Today none of this has a record. Plans live in chat scrollback and in the Lead's memory. They are lost or re-explained whenever a session is replaced, a provider limit hits, or the server restarts (strategy P9: durable records over chat memory). Nothing ties a task to the part of a plan it serves.

This change is the Wave C foundation (docs/multi-agent-development-ux.md: Durable Plan and execution model, and Delivery phases "P0 Durable Plan core"). It gives plans a durable, human-approved record that the later Wave C changes bind to. The record supports planning mode (strategy UC1) end to end: the Lead drafts, the owner approves, and the Lead executes the approved plan by hand through the existing task tools until `plan-execution` automates it.

## What Changes

- **Plan record.** A durable, team-scoped plan for one repository, stored in kawai's SQLite beside tasks and strategy. A plan has:
  - a title and a creator;
  - a stored lifecycle of `open`, `completed`, or `cancelled`;
  - numbered, immutable revisions.

  The human owns every plan; the strategy names the owner as the only human. Archiving or killing the creating session leaves the plan in place.
- **Plan content.** Each revision carries a structured, canonically hashed template:
  - intent: goal, success criteria, non-goals, and approach;
  - an alignment statement with references into the pinned strategy;
  - the **ordered changes**, each naming an OpenSpec change with its dependencies, implementing group, review group, acceptance rules, extra checks, and guidance;
  - plan-wide acceptance rules and **extra checks**;
  - the **landing mode**: direct merges, or an integration branch;
  - the **roles**: the groups that execute the plan, each with its provider profiles in preference order.

  The **mandatory check floor** (lint, typecheck, unit tests, CI end-to-end, and a clean reviewer verdict) is Kawai's fixed policy, not plan content. No field can remove or weaken it, and extra checks cannot reuse its names. Saving refuses structural faults with every violation listed: duplicate or malformed change names, dependencies outside the plan, dependency cycles, and groups missing from the roles.
- **Drafts and submission.** Drafts are durable, per draft id, and saved with expected-revision checks, mirroring strategy drafts. Submitting promotes a draft to the next numbered revision in review. The server checks the draft is complete and pins the product strategy at that moment: the team's current approved strategy revision and hash, or none ("Alignment unassessed"). The pin is never author-supplied, and references in the alignment statement must exist in the pinned revision.
- **Human-only approval** (`plan-approval`). The owner approves an exact revision and content hash under a command id:
  - A retry with the same payload returns the prior result; a different payload under the same command id is refused.
  - Approval is refused as stale when the active approved revision changed after the human saw it.
  - At most one revision is active and approved; it supersedes the previous one.
  - Approval evaluates an ordered list of **named preconditions**, and a refusal names each failing one. This change ships `plan-open`, `revision-in-review`, `hash-matches`, `approved-revision-unchanged`, and `strategy-pin-current`. Later changes add their own preconditions.
  - Approval changes nothing else: no task, mail, interruption, or rebinding of linked tasks.

  No agent tool can approve, withdraw, or close a plan.
- **Closing.** The human completes a plan, cancels it with a reason, or reopens it. Completing a plan whose changes are not all done requires a stated reason. Every lifecycle action is an append-only plan event with actor, reason, and command id.
- **Plan-change link on tasks.** A task may name a plan and one of its changes at creation, through the human task form's pickers or new optional `task_create` parameters. The link is checked against the plan's current approved revision and is immutable afterwards. Delivered task mail names the plan, its revision, and the change. Per-change progress (not started, in progress, done, cancelled) and dependency waits are derived from linked task statuses at read time and never stored.
- **Agent tools.** `plan_list`, `plan_get`, `plan_save_draft`, and `plan_submit_for_review` are open to any team agent. `plan_create` is open to groups whose file sets the new `canCreatePlans: true` (a strict boolean, default false). The system prompt's plan note states these rights and that only the owner approves.
- **Plans view.** A team-scoped view lists plans with their state and strategy pin. Plan detail shows:
  - intent and alignment, with the alignment statement labeled as claimed, not assessed;
  - the changes, each with its dependencies, groups, checks, linked tasks, and derived progress;
  - the floor beside the extra checks;
  - the landing mode and the roles with their profiles;
  - each in-review revision with a diff summary against the approved one, plus **Approve revision N** and **Withdraw**;
  - drafts and history;
  - the close and reopen controls.

  The view mounts as the Team page's `plans` tab when `team-workspace-pages` has landed, and otherwise as a side-slot panel beside Strategy.

Non-goals belong to the other Wave C changes, which this change only names. Each binds to the contracts its design publishes (D12):
- `plan-validation`: technical and alignment validation reports, change-existence and artifact pinning, and environment checks for groups and profiles.
- `plan-execution`: Start, plan and task execution attempts, dependency-ordered dispatch, gating on the floor and extra checks, direct landing, and the three-round stop.
- `integration-candidates`: integration-branch landing.
- `plan-supervision`: Lead decision cards, overrides that become fix tasks, execution progress, and usage per role and profile.
- `revision-control`: holds, checkpoints, and publishing plan revisions to running work.
- `execution-safety-recovery`: security rules in every system prompt, the outbound-action audit log, and execution recovery.
- `strategy-revision-impact`: impact review and dispositions for stale pins.

Also out of scope: a structured plan editor for the human (the owner plans through the Lead in this change); multi-repository plans (strategy boundary); and plan budgets (strategy P8).

## Capabilities

### New Capabilities

- `plans`: the durable plan record covering:
  - content template, check floor, and structural checks;
  - drafts, submission, and the strategy pin;
  - closing and reopening, and the event history;
  - agent tools and the `canCreatePlans` right;
  - the Plans view.
- `plan-approval`: human-only approval of an exact plan revision and hash, covering:
  - command-id idempotency;
  - stale refusals;
  - one active approved revision;
  - named approval preconditions;
  - the guarantee that approval grants and triggers nothing else.

### Modified Capabilities

- `team-tasks`: adds two requirements. A task may link to a plan change at creation (validated, immutable). Delivered task mail for a linked task names the plan, its approved revision, and the change.

## Impact

- **Server:**
  - A new `src/server/plans/` module mirroring `src/server/strategy/`: `planSchema.ts`, `planStore.ts`, `PlanService.ts`, `planPreconditions.ts`, `planTools.ts`, and `planConnections.ts`.
  - `src/server/team/TaskService.ts` and `taskTools.ts` validate the link and gain the new `task_create` parameters.
  - `taskStore.ts` gains additive `plan_id`/`plan_change` columns.
  - `taskContext.ts` adds the plan reference to the envelope.
  - `groupFile.ts` adds `canCreatePlans`.
  - `teamPrompt.ts` adds the plan note.
  - The new tools join `TEAM_ALLOWED_TOOLS`.
- **Shared:**
  - A new `src/shared/plans.ts` holds the content types, normalization, structural checks, the floor constant, and canonical hashing, reusing `canonicalJson` from `productStrategy.ts`.
  - `src/shared/teamTasks.ts` gains the link fields.
  - `src/shared/types.ts` gains the `team-plan*` messages, which must also be listed in `CHAT_CONNECTION_TYPES`.
- **Client:**
  - A new `src/client/components/team/TeamPlansView.tsx` plus section components (each under 500 LOC).
  - A new `teamPlanStore.ts` keyed by team key.
  - The task form gains plan and change pickers.
  - A Plans entry in whichever team host exists.
- **Data:** an additive migration adds the `plans`, `plan_revisions`, `plan_drafts`, and `plan_events` tables plus two nullable `team_tasks` columns. Existing tasks stay unlinked; no plan is invented for them.
- **Docs:** AGENTS.md How It Works bullets for plans, approval, the task link, and the tools.
- **Tests:**
  - Unit coverage for content checks, CAS, the pin, approval idempotency and races, closing, the link, the tools, and the connections, including cross-team refusals.
  - One browser walkthrough spec named in `.github/workflows/ci.yml`.
- **Sequencing:**
  - Implement after Wave B2 (`task-revision-publication`, `task-results-handoffs`).
  - `strategy-revision-impact` and `plan-validation` build on this change and may proceed in parallel after it.
  - `plan-execution` follows `plan-validation`.
