# Design

## Context

See proposal.md for motivation. This design is included because the pilot changes coordination across every repository role and must resolve authority, reporting, recovery, and evaluation before rollout.

Observed in this checkout:
- `lead.md` centralizes planning, assignment, clarification, formal review routing, corrections, landing, and completion. Developer/reviewer reports target `lead`.
- `docs/agent-collaboration.md` already supplies design challenges, production-path checkpoints, direct technical clarification, and independent review.
- `TaskService` binds amendment and closing rights to the creator session. A parent link grants no authority. `task-results` permits result acceptance under creator/human rights, while current agent tools expose result submission, findings, and handoff rather than a new acceptance operation.
- Group mail is worktree-scoped by default; direct session mail crosses worktrees. Staffing allows one spawned writer per resolved worktree. A group with `worktreeScoped: false` receives across worktrees but does not spawn through this mail path.
- Execution-owned changes reserve their own task and review/fix dispatch.
- The owner confirms parallel-suite and per-result-suite are implemented; local hooks/scripts and unchecked planning tasks are stale relative to that report. Establish the authoritative integrated base before implementation, without rebuilding those changes.

## Goals / Non-Goals

**Goals:**
- Test delegated change ownership without requiring new server authorization or scheduling.
- Preserve one authoritative coordinator per task and one writer per worktree.
- Make success, failure, cost, and withdrawal inspectable using existing records.

**Non-Goals:**
- A permanent three-level hierarchy, dedicated developer pools, automatic coordinator spawning, or nested teams in the product.
- Role-based inheritance of creator rights, new acceptance tools, automatic metrics collection, or execution-engine changes.
- More frequent checks, duplicated review gates, or a change to the implemented test policy.

## Decisions

### D1. One opt-in, manually coordinated change

Add `docs/change-lead-pilot.md` as the common protocol, linked by the existing collaboration document and roles. Start with one change containing at least two coherent implementation groups and meaningful local coordination. Exclude trivial fixes, inseparable same-file work, and changes owned by a running execution. The Team Lead records the selection rationale and obtains the human's named candidate/session enrollment decision at activation; installing the protocol is not enrollment.

Use a default evaluation window of 14 calendar days from the first assignment, ending earlier on landing or withdrawal. This is an operational review point, not a statistical claim. Further enrollment or expansion needs a human decision.

Alternative: switch all work to the hierarchy. Rejected because small changes may only acquire another handoff and there is no Kawai-specific evidence of benefit yet.

### D2. Add a coordinator role without a private developer pool

Create `.kawai/groups/change-leads.md` with `canCreateTasks: true`, `canCreatePlans: false`, `canManageMailbox: false`, `canReportProcess: false`, `worktreeScoped: false`, `releaseOnTaskClose: false`, and `canReleaseMembers: true`. Set `max: 1` as a pilot configuration; the one-pilot limit is an operating rule, not a claim that max prevents human-created sessions. Leave profile, effort, and approval unset so the human's session choice and existing defaults apply. Do not change existing developer/reviewer caps or routing.

The human creates the coordinator session in a stable repository checkout, outside developer worktrees. A session's group is fixed, so an existing senior session is not silently promoted. No enrollment mail is sent until a valid named coordinator is available.

Developers remain in shared senior/middle/junior groups. Discover capacity at dispatch, respect account quotas and model constraints, and maintain named writer/branch/worktree assignments. Do not reserve developers by merely listing them in a pool.

Alternative: separate developer groups per coordinator. Rejected because it fragments capacity and introduces routing/configuration changes before the value of delegation is established.

### D3. Parent and child creators express actual authority

The Team Lead creates the coordination parent, links the target OpenSpec change, and records:
- Pilot state, change id, coordinator session, scope and revision, contract boundaries and their owners.
- Approved dependency/integration order and decisions reserved to the Team Lead or human.
- Evaluation window, baseline task ids or baseline-selection criteria, model/resource conditions, known evidence gaps.
- Current subtasks, participants, next action, and escalation/recovery contacts.

The Change Lead creates implementation children with `parent_id`, `openspec_change`, a real worktree, explicit covered requirement/task groups, dependencies, acceptance, and a coordinator session reference. It owns child amendments and closure; the Team Lead retains the parent. Each subtask's direction contains a small coordination block: parent id, pilot change, coordinator session, reporting route, and escalation to `lead`.

Publish material direction changes through `task_amend` and require acknowledgment before dependent work. Decisions remain in revisions/journals, not conflicting mailbox instructions. The Change Lead may draft an artifact clarification within approved scope; scope or cross-change contract amendments require the Team Lead's reconciliation and any applicable human gate.

Alternative: Team Lead creates all children then tells the Change Lead to manage them. Rejected because it leaves every amendment and closing decision bottlenecked on the original creator.

### D4. One dispatch owner and explicit reporting exceptions

Update all three developer roles and reviewers with the same narrow exception: an explicitly enrolled task follows its named Change Lead; ordinary work keeps reporting to `lead`. Routine status/result/findings reports use direct session mail without `task_id`, naming the child, revision, result/findings ids, next action, and wait in the body. This preserves the existing no-task-binding status-report convention. Technical exchanges may bind the child task.

The Change Lead discovers a suitable developer, creates its worktree before dispatch, and sends task mail through existing tools. It coordinates advisory checkpoints and exactly one formal result-bound review/fix handoff, selecting an explicit session for cross-model review. It inspects standing assignments before retrying; a duplicate naming another recipient is not a reassignment.

The Team Lead receives milestones, unresolved boundary questions, named blockers requiring its action, and final assembled evidence. It does not approve every local decision or duplicate child dispatch. Developers and reviewers clarify technical mechanisms directly, journaling outcomes.

### D5. Preserve independent evidence and make assembly a real assignment

The Change Lead coordinates rather than writes production code. Keep the existing risky-work checkpoints and formal independent reviewer. A coordinator's agreement is not review evidence. Preserve the existing cross-model policy and fresh focused advisory assessment where applicable; reviewer absence remains a named wait.

Allocate one developer/worktree for assembly under an explicit child assignment when multiple branches need integration. The Team Lead determines base/order and owns cross-change conflicts; the Change Lead coordinates local assembly and corrections. Record the assembled commit, requirement coverage, child result/findings ids, relevant contract/workflow checks, and unresolved risks. Changed assembly/conflict code receives a new result and review for the resulting head.

Close children only when their own acceptance holds; stage completion does not prove assembled acceptance. Closing a task through available creator tools is distinct from recording result acceptance; preserve current creator/human acceptance rights and expose no new tool. The Team Lead makes the final landing decision and closes its parent only after the assembled evidence and checks hold.

### D6. Recovery and withdrawal never invent task ownership

If the coordinator is unavailable, send one escalation to `lead` and journal a named wait; do not dispatch a second implementation or review. The Team Lead reconciles outstanding assignments, queued/delivered mail, branches, results, creator sessions, and next actions.

A replacement may coordinate within existing rights. It cannot amend or close the original coordinator's children. Ask the original creator to publish the handover if available; otherwise ask the human to amend direction and perform creator-bound closure. Require acknowledgments and reconcile in-flight handoffs before new dispatch. Do not recreate existing subtasks merely to obtain creator rights.

Withdrawal stops new pilot assignments, records a handover to the default Lead path using authorized amendments, preserves pending reviews and evidence, and lets safe in-flight work settle. Retain the role until its dependent work is resolved. Remove or revert the role/protocol additions only after reconciliation; never kill sessions or discard work. Human-created coordinator sessions are archived by the human. New prompts apply at ordinary starts; a running participant receives an explicit safe-checkpoint instruction rather than an automatic restart.

### D7. Evaluate accepted outcomes and observable waits

Use parent/child journals and existing results, assignments, mail history, and process reports. The Team Lead owns the evaluation report; the Change Lead supplies evidence but does not gain process-report rights.

Record matching baseline task/change ids before outcomes are known. Match scope, risk, dependency coupling, model mix, review policy, checks, and resource conditions where possible; list mismatches. Prefer recent work under the implemented parallel-suite/per-result-suite baseline. If no comparable baseline exists, report a descriptive pilot rather than a causal comparison.

Collect:
- Enrollment, first dispatch, result, findings, correction, assembled-ready, landing/withdrawal timestamps.
- Clarification request/answer times; named quota, suite, reviewer, human and coordinator waits. Avoid double-counting overlapping waits; report unclassified time.
- Blocking defects by class and discovery phase, repeated correction rounds, integration defects and missed criteria.
- Actual token/cost records where attributable, including coordination and review. Mark incomplete coverage; quota meters are not costs. No new usage instrumentation.
- Total elapsed time to accepted completion, including failed/abandoned work, plus available post-landing defects through the recorded report cutoff.

Publish evidence references, limitations, and continue/revise/withdraw recommendation at the window end. A favorable pilot requires no unaddressed correctness/authority regression and an observed coordination or completion benefit worth its measured overhead. Missing baseline/cost evidence makes those conclusions inconclusive. Do not set percentage promises or expand automatically.

### D8. Verify protocol integration proportionally

Use the actual role file with existing group parsing/catalog helpers to check effective rights. Extend existing disposable task/handoff fixtures only where needed to demonstrate creator asymmetry, parent/child linkage, direct reviewer handoff, duplicate dispatch behavior, and unavailable-coordinator recovery through authorized actors. Reuse existing tests instead of duplicating established service coverage or testing prompt wording.

A documented tabletop walkthrough covers interpretation, reporting exceptions, escalation, assembled-head review, and withdrawal. It does not claim to prove that agents will obey prompts. No live mail or sessions are needed for repository verification.

Follow the integrated baseline's affected-test/full-check policy; include runtime-read declarations for role/docs fixtures where its selector requires them. Broad server, migration, or UI changes discovered necessary are a new scope decision, not an excuse to enlarge the pilot implementation silently.

## Risks / Trade-offs

- [More handoffs consume time and tokens] -> Keep small work direct, allow local decisions, and measure coordinator overhead.
- [A mistaken spec interpretation reaches all developers] -> Preserve independent challenge and actual contract/production-path checks.
- [Creator session loss strands amendments] -> Explicit human/original-creator recovery, no implicit ownership transfer.
- [Prompt-only boundaries are unenforced] -> State that this is an operating protocol; existing service authorization remains the mechanical boundary.
- [Shared resource waits mask the hierarchy's effect] -> Hold test policy and caps constant and report named waits separately.
- [One selected change produces misleading conclusions] -> Report selection and uncertainty; require a human decision before any expansion.

## Migration Plan

1. Start implementation on the authoritative integrated baseline; reconcile stale planning metadata without modifying unrelated changes.
2. Land the additive role, common protocol, narrow reporting exceptions, and verification evidence together.
3. Review readiness with the human, name one eligible change and coordinator session, and record baseline and window before dispatch.
4. Run the opt-in pilot through existing tools; running tasks outside the pilot retain their current authority and routing.
5. Evaluate at landing, withdrawal, or the window boundary. Continue only by an explicit decision; use D6 for rollback.

## Research Basis

These sources motivate hypotheses, not promised Kawai outcomes:
- [Agyn](https://arxiv.org/html/2602.01465v1): competitive manager-coordinated coding results; comparisons do not isolate an extra lead layer.
- [MSEval](https://arxiv.org/html/2607.27877v1): coordination performance varies by project; managerial oversight is not a universal winner. New-application benchmark and preprint limitations apply.
- [Scaling Agent Systems](https://arxiv.org/html/2512.08296v1): task decomposability and coordination overhead matter; benchmarks do not directly establish maintenance-team gains.
- [Anthropic research-system report](https://www.anthropic.com/research/multi-agent-research-system): separate contexts help parallel exploration, with explicit cautions about tightly dependent coding work.
