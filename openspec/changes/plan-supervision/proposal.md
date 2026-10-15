# Proposal

## Why

`plan-execution` runs an approved plan unattended. It records every state, round, stop, and landing, but it explains little and keeps no record of the decisions agents make along the way. Strategy revision 2 asks for both.

- **Needs and outcomes.** "See every decision the Lead made on the owner's behalf, next to the work it affected, and change any of them later." "When a decision is changed, get the product brought in line by a forward fix, without archaeology." "Know who is responsible for what, what is waiting and why, and what actually happened."
- **Product approach.** "The Lead answers the questions agents raise and records each answer as a provisional decision." "Each Lead decision is a card next to its change (question, options considered, choice, rationale, who asked, affected tasks and commits). Override picks another option or writes a new one; Kawai creates a fix task the Lead plans and runs through the same checks, and records the owner's decision as superseding the Lead's. The plan view also shows usage per role and profile; there is no plan budget for now."
- **Success measures.** M2 (the share of Lead decisions the owner overrides) and M4 (the time from an override to its verified forward fix landing) cannot be computed today, because neither decisions nor overrides are records.

The UX doc's P1 Supervision phase adds the rest: meaningful progress apart from activity, stalls that alert the Lead (R21), named waits instead of "stuck", and a partial outcome that never claims fulfilled intent (R22).

The Wave C contracts left these to this change:
- `plan-execution`: X1 (cards, progress), X4 (evidence, overrides), X7, and X8 (a card per stop). It also leaves "stalled" and "needs attention" to be derived here.
- `plan-validation`: V2 (cards for carried conditions).
- `integration-candidates`: I1 (failed candidates) and I2 (correction tasks for a failed promotion).
- `strategy-revision-impact`: C-I3 (cards may link the impact review).
- `team-workspace`: its attention queue reserves `card` links and Wave C kinds.

## What Changes

- **A Lead role per plan.** Plan content gains an optional `leadGroup`, one of the plan's roles. When it is unset, questions and fixes go to the owner. Normalization keeps the field absent when unset, so existing revisions keep their hashes.
- **Decision cards.** An agent working on a plan task asks with `decision_ask`, never with the human-blocking AskUserQuestion. Kawai records a card with the question, the options considered, the context, and who asked: session, group, and profile.
  - The question goes to the plan's Lead role as group mail tagged `decision-question`.
  - It goes to the owner instead when the plan has no Lead role, or when the Lead itself asks.
- **Recorded answers.** A Lead-role member answers with `decision_record`: a choice (an option or new text), a rationale, and the affected tasks. Kawai records the decision and delivers it as the Lead's reply in the question's thread.
  - The Lead records its own calls the same way, without a question.
  - A plain `reply` to an open question is refused with guidance, so no answer bypasses the record.
- **Owner answers and overrides.** These are human-only commands with command ids.
  - **Answer** decides an open card.
  - **Override** decides a card again: another option or new text, with a required rationale. It is guarded by compare-and-swap on the decision it replaces, and supersedes that decision while every earlier decision stays readable.
- **Forward fixes.**
  - **The fix task.** An override makes Kawai create a fix task for the plan's Lead role. The task names the card, both decisions, and the affected tasks, changes, and commits. With no Lead role, the fix task is left for the owner to assign.
  - **How the Lead fixes.** The Lead writes an OpenSpec change and adds it to a plan revision as a change whose new `fixes` field names the override. That revision then goes through the plan's normal approval, validation, Start, and gate. A fix is never a bypass.
  - **Closing.** Kawai marks the fix task done once every change naming the override has landed. A fix needing no change ends when the owner accepts the Lead's result saying so.
  - **Status.** Each override shows a derived fix status: planning, in review, approved, running, landed, no change, or superseded. The time to landing is shown too, which is M4.
  - **Other effects.** A completed plan is reopened by the override. A later override cancels an earlier fix task that is still open.
- **Correction tasks (I2).** A promotion that fails on a conflict or a CI failure makes Kawai create a correction task for the Lead role. The task is done when a later promotion of the plan merges, or when the owner accepts its result. Every other failure is an owner attention item: Promote again.
- **Supervision, derived and never stored.**
  - **Outcome.** Each change has exactly one outcome with a named cause: landed (with its verification), running (stage and holder), waiting, stalled, stopped (reason and detail), cancelled, or not started. Plans show counts, never a percentage.
  - **Named waits.** These are dependency, parallel slot, staffing capacity, provider limit, approval or question, open decision card, CI, member release, acceptance condition, landing slot, and uncertain delivery. A named wait is never a stall.
  - **Progress and activity.** Last meaningful progress (an accepted result, CI passing, a verdict, a round passing, a landing, or a candidate passing) is shown apart from last activity.
- **Stalls.** Two kinds of stall exist:
  - `no-progress`: no meaningful progress within the stage's deadline, while no named wait applies. The deadline is shorter once the holder sits idle.
  - `repeating-failure`: two consecutive failed rounds with the same failure signature, raised before the round limit stops the change.

  Each episode alerts the plan's Lead role once, by Kawai's system mail tagged `plan-stall`. A durable row dedupes the alert. With no Lead role, the stall is an owner attention item.
- **The report.** It says what stopped and why: the reason, the evidence, the blocked dependents, and the next action. It states partial delivery as "landed N of M" with the blockers, and never claims the plan's success criteria. It also shows:
  - failed integration candidates (I1);
  - a non-continue strategy-impact disposition, linked to its review (C-I3);
  - M2 as counts: "k of n Lead decisions overridden".
- **Team workspace.**
  - **Attention.** New sources join the queue: plan stops, stalls, decision questions, forward and correction fixes waiting on someone, acceptance conditions holding a change, and failed promotions. A new link kind `plan` joins `card`.
  - **Morning summary.** It gains landings, stops, stall alerts, decisions, and overrides.
- **Usage per role and profile.** `turn_completed` gains the result frame's per-turn token usage. Kawai records one usage row per completed turn of a task-bound session: group, profile, model, input, output, cache-read, and cache-creation tokens, and steps. Plan usage sums the tasks linked to the plan, its execution tasks included, plus its fix and correction tasks. It is shown by role and profile, and per change. It shows no currency and sets no budget. Turns outside any task, such as the Lead answering questions, are shown as not attributed.
- **Agents.** `plan_get` gains decisions, supervision, and usage. Any agent on plan work can call `decision_ask`. `decision_record` is refused outside the Lead role. The plan note explains both. No agent tool answers for the owner, overrides, retries, stops, or dismisses anything.

Non-goals:
- Holds, pausing, and publishing new direction into running work (`revision-control`). A fix runs as a new plan revision in a new execution.
- The outbound-action audit log, budgets, and the crash matrix (`execution-safety-recovery`).
- Retry or Stop by the Lead, and any agent control of an execution.
- Currency cost and plan budgets (strategy boundary).
- Intercepting AskUserQuestion. The prompt steers plan work to `decision_ask`.
- Computing M1, M3, M5, and M6.

## Capabilities

### New Capabilities

- `plan-decisions` covers:
  - the Lead role;
  - decision cards, `decision_ask`, and `decision_record`;
  - owner answers and overrides;
  - forward-fix and correction tasks, the `fixes` field, and the derived fix status;
  - cards in the Plans view, and the agent surface for decisions.
- `plan-supervision` covers:
  - derived change outcomes and named waits;
  - meaningful progress, stalls, and stall alerts;
  - the "what stopped and why" report and partial delivery;
  - the plan sources of the team attention queue and summary;
  - usage per role and profile;
  - the agent surface for supervision.

### Modified Capabilities

- `agent-mailbox`: a reply to an open decision question is refused with guidance, for agents and the human.
- `team-tasks`: Kawai also creates fix tasks for overrides and correction tasks for failed promotions. This modifies `plan-execution`'s requirement that Kawai creates tasks only through an execution, so `plan-execution` archives first.

## Impact

- **Server.**
  - New `src/server/plans/decisions/`: schema and store, `DecisionService`, the agent tools, the connections, and the fix and correction tasks.
  - New `src/server/plans/supervision/`: the read model, the monitor and its stall alerts, the attention sources, and the summary buckets.
  - New `src/server/chat/chatTurnUsageStore.ts`.
  - `ChatSessionDriver` reads the result frame's `usage`. `ChatSessionManager` records usage beside turn ends.
  - The reply paths gain the decision guard, `teamPrompt.ts` gains the decision note, and `workspaceRead.ts` registers the new sources and buckets.
  - The `ExecutionService` system caller gains the decision origin.
- **Shared.**
  - New `src/shared/planDecisions.ts` and `src/shared/planSupervision.ts`, holding the types and the pure derivations.
  - `PlanContent` gains `leadGroup` and `PlanChange.fixes`.
  - `AttentionLink` gains `plan` and an optional `planId`, and `MorningSummary` gains five buckets.
  - The new messages go in `src/shared/types.ts` and `CHAT_CONNECTION_TYPES`.
- **Client.** `PlanReportSection`, `PlanDecisionCard`, `PlanDecisionDialog`, and `PlanUsageSection`, plus `teamPlanStore` and workspace wiring.
- **Data.** An additive migration with five tables (`plan_decision_cards`, `plan_decisions`, `plan_fix_tasks`, `plan_stall_alerts`, `chat_turn_usage`). There is no backfill, so usage starts at deployment.
- **Docs.** AGENTS.md bullets for decisions, supervision, and usage.
- **Tests.** Unit coverage of the derivations, stall episodes, CAS, replay, the reply guard, fix completion, and cross-team refusals. One fixture walkthrough runs an override through to its fix, and it is named in `.github/workflows/ci.yml`.
- **Sequencing.**
  - Implement after `plan-execution` and `integration-candidates`. The I1 and I2 parts read the latter's records.
  - `plan-execution` archives first, because of the `team-tasks` delta.
  - `revision-control` and `execution-safety-recovery` bind to the contracts published in design D17.
