# Tasks

Implement after `plan-execution` and `integration-candidates` have landed on master, together with what they build on (`durable-plans`, `strategy-revision-impact`, `plan-validation`, and `team-workspace`), then rebase this branch onto them. Every file stays under 500 LOC. Tests that spawn git use `cleanGitEnv`. Tests never reach GitHub.

## 1. Shared model

- [x] 1.1 Reconcile names with the merged designs and record any renames in this design before coding. Verify by reading the designs against D3, D7, D9, D10, D13, and D17 here:
  - `plan-execution` D2, D3, D12, D18, and D19: the system `TaskCaller`, the change states and steps, the stop-reason union, Kawai's reply guard, and `completeBySystem`;
  - `integration-candidates` D3 and D9–D11: candidates, promotions, and their outcomes;
  - `team-workspace` D5 and D8: `ATTENTION_SOURCES`, `AttentionLink`, and the summary buckets.
- [x] 1.2 Create `src/shared/planDecisions.ts` with the card, decision, fix-task, and view types (D3, D15), and a header comment naming them. Implement `currentDecision`, `cardState`, `fixStatus`, `overrideCounts`, `fixDurations`, and `fixesFieldErrors` (D2, D3, D12, D13). Verify with unit tests:
  - the current decision is the highest `seq`, and states are open, decided, or overridden;
  - fix status walks planning, in review, approved, running, landed, no change, and superseded;
  - M2 counts only agent `answer` and `own-call` decisions of the addressed group, and the overridden ones among them;
  - M4 measures override to newest landing, flagged when a landing is not tree-verified;
  - `fixes` entries must match `task-<uuid>`, with no duplicates within a change, and an entry that is empty after trimming is refused, not dropped.
- [x] 1.3 Create `src/shared/planSupervision.ts` with the outcome, cause, progress, activity, stall, and report types, and the cause and stop-reason labels (D10, D12). Verify with a typecheck, and with a test that an unknown cause or stop reason renders verbatim.
- [x] 1.4 Implement `changeSupervision(input, now)` (D10, D11). Verify with unit tests:
  - the outcome precedence: landed, cancelled, stopped, waiting, a `repeating-failure` stall, then the running stages;
  - a repeating failure reads stalled during a fix round's CI wait, with the wait listed as also applying;
  - the failure signature of a round that fails CI and its review is the sorted check names followed by `review:fail`;
  - each of the ten named waits in order, with the others listed as also applying;
  - progress comes from results, CI passes, verdicts, passed rounds, landings, and passed candidates, never from turns or tokens;
  - `no-progress` uses 2 h for attempts and 1 h for reviews, counted from the latest of delivery, progress, and `waitEndedAt`, and 15 min from the last turn end for an idle, archived, or killed holder;
  - `repeating-failure` needs two consecutive failed rounds with an equal signature, skips superseded rounds, follows a carried round's source, and excludes flaky checks;
  - the episode keys stay the same when only `waitEndedAt` moves;
  - a named wait never stalls.
- [x] 1.5 Implement `failureSignature`, `blockedDependents`, and `planReport` (D12). Verify with unit tests:
  - the transitive closure over `dependsOn` includes only unlanded changes;
  - the report reads "Landed N of M" with blockers, and "All M changes landed" without claiming success criteria;
  - failed and superseded candidates sit beside their change;
  - a non-continue disposition is shown with its link;
  - the M2 and M4 lines match 1.2.

## 2. Plan content

- [x] 2.1 Add `PlanContent.leadGroup` and `PlanChange.fixes` to the plan model, with normalization that omits each when unset (D2). Verify with a test that every pre-existing fixture revision keeps its canonical serialization and hash byte-for-byte, and that a set field round-trips.
- [x] 2.2 Extend `planStructureErrors` with the three D2 checks. Verify with tests:
  - a `leadGroup` outside the roles is refused;
  - a malformed or duplicate `fixes` entry is refused, naming it;
  - one fix task named by two changes passes.
- [ ] 2.3 Add the read-time warning for a `fixes` entry that names no fix or correction task of the plan (D2). Verify with a plan-detail test showing the warning, and an approval test that the warning does not refuse approval.
- [x] 2.4 Document `leadGroup` and `fixes` in the durable-plans AGENTS.md bullet, and the `plan_save_draft` tool description. Verify by reading both against D2.

## 3. Records

- [ ] 3.1 Add the D3 migration for `plan_decision_cards`, `plan_decisions`, `plan_fix_tasks`, and `plan_stall_alerts` in `decisionSchema.ts` and `supervisionSchema.ts`. Verify with a migration test on a fresh database and on one that already has the plan tables, run twice.
- [ ] 3.2 Implement `decisionStore.ts` as the only SQL writer of the decision tables, with a header comment saying so. The records need no user docs beyond it. Verify with unit tests:
  - `UNIQUE (card_id, seq)` turns the losing insert into a refusal that names the winner;
  - `UNIQUE (plan_id, command_id)` replays a human command, while null command ids never collide;
  - `UNIQUE (source_kind, source_id)` keeps one fix task per override and one correction per promotion;
  - another team's rows read as not found.
- [ ] 3.3 Implement the stall-alert store over `plan_stall_alerts`. Verify with tests that the unique episode key refuses a second insert, and that a row with a null `message_id` is accepted.

## 4. Usage capture

- [ ] 4.1 Confirm `team-process-metrics` has shipped the `turn_completed.usage` mapping, the `chat_turn_usage` table, and its turn-start-pinned writer (D14); this change adds none of them. Verify by reading `chatTurnUsageStore.ts` against D14's attribution rule.
- [ ] 4.4 Implement the plan usage read: the plan's linked tasks plus its `plan_fix_tasks`, summed by `(group, profile)` and by change, with fix and correction tasks as their own rows (D14). Verify with a test across two profiles of one role, and with tests that another plan's tasks and rows with a null `task_id` are excluded.
- [ ] 4.5 Add the AGENTS.md usage bullet: the per-turn record, the attribution rule, no currency, and no backfill. Verify by reading it against D14.

## 5. Decisions and fix tasks

- [ ] 5.1 Widen the system `TaskCaller` to `{ kind: 'system'; team; origin }` with the three origins, constructed only module-privately, extending plan-execution D2's exhaustive switches over `origin` (D7). Verify with:
  - an exhaustive-switch typecheck;
  - a test that no tool or connection path yields a system caller;
  - a test that the execution origin keeps exactly D2's rights.
- [ ] 5.2 Implement `DecisionService.ask` (D4). Verify with tests:
  - the plan resolves from the session's task, from a fix task, or from the Lead role with `plan_id`, and anything else is refused with D4's message;
  - a conflicting `plan_id` is refused, and another team's plan reads as not found;
  - a Lead-addressed card and its task-less `decision-question` mail commit in one transaction;
  - an owner-addressed card sends no mail;
  - the input limits are enforced.
- [ ] 5.3 Implement `DecisionService.record` for card answers and own calls (D5). Verify with tests:
  - only the addressed group answers, and owner-addressed cards are refused;
  - the same session and choice replays, and anything else is refused naming the decider;
  - the answer goes through the reply path with the card's task passed explicitly, tagged `decision-answer`, and a killed asker's answer falls back to its group;
  - an own call needs the Lead role and creates a decided card with no mail;
  - `affected_tasks` defaults to the card's task and refuses other teams' tasks.
- [ ] 5.4 Implement `DecisionService.answer` (D6). Verify with tests:
  - agent callers are refused;
  - replay compares the D6 fields, and a different payload is refused naming the field;
  - a decided card is refused naming the decider;
  - queued or awaiting-request question mail is cancelled with the human as actor, while claimed mail is left alone;
  - the answer mail goes to the asker in the question's thread;
  - a race with `decision_record` leaves one first decision.
- [ ] 5.5 Implement `fixTasks.ts` creation and dispatch for overrides (D7). Verify with tests:
  - the title, direction, and acceptance follow D7, with no worktree, change, or parent, and the instruction names `fixes: ["<the task's id>"]`;
  - the `plan_fix_tasks` row commits with the task;
  - dispatch goes to `leadGroup` with the role's profiles, the tag `plan-fix`, and the key `fix:<decisionId>`;
  - with no Lead role nothing is dispatched;
  - the origin's rights end at create, dispatch, and close.
- [ ] 5.6 Implement `DecisionService.override` as one transaction (D6). Verify with tests:
  - replay, and the CAS refusal naming the current decision;
  - an open card is refused with `answer it instead`, and a missing rationale is refused;
  - a cancelled plan is refused, and a completed one is reopened through `PlanService.reopen(…, within)` with command id `override:<commandId>:reopen`;
  - an earlier open fix task is cancelled with a note;
  - the new fix task is created and dispatched;
  - a failure at any step writes nothing.
- [ ] 5.7 Add the AGENTS.md decisions bullet: the Lead role, cards, the two tools, owner answers and overrides, and fix tasks. Verify by reading it against D3–D7.

## 6. Agent surface

- [ ] 6.1 Add `decision_ask` and `decision_record` to the `kawai-team` server, allowed without cards, identity-bound like the task tools (D16). Verify with tool tests that call through the server and see D4's and D5's refusals.
- [ ] 6.2 Implement `decisionReplyGuard.ts` and wire it into the `reply` tool and the human composer's reply path (D9). Verify with tests:
  - a reply to an open card's question is refused with guidance, and nothing is queued, for an agent and for the human;
  - a reply after the decision is queued;
  - `DecisionService`'s answers bypass the guard;
  - the null guard passes everything.
- [ ] 6.3 Extend `plan_get` with `decisions`, `supervision`, and `usage` (D16). Verify with a tool test on a plan with a stalled change and a decided card.
- [ ] 6.4 Add the decision and supervision text to the plan note in `teamPrompt.ts` (D16). Verify with a prompt test that the note names both tools, the refused reply, the stall alerts, and the owner's rights, and claims no agent can override, retry, or stop.

## 7. Human connections

- [ ] 7.1 Implement `decisionConnections.ts` for `team-plan-decide` and `team-plan-override`, answered by `team-plan-result`, and add both to `CHAT_CONNECTION_TYPES` (D15). Verify with connection tests: another team's plan or card is refused, a replay returns the prior decision, and a refusal shows its message.
- [ ] 7.2 Add `decisions`, `supervision`, and `usage` to `team-plan-detail`, pushed after every decision, fix, or alert write. Verify with a connection test that an answer pushes one detail carrying the decision.

## 8. Supervision monitor

- [ ] 8.1 Implement `supervisionRead.ts`, the loader that feeds `changeSupervision`: change rows, rounds, effects, assignments, mailbox reasons, session facts, the slot holder, cards, conditions, candidates, turn ends, and task mail (D10). Verify with a store-backed test per named wait.
- [ ] 8.2 Implement `SupervisionMonitor.ts`: one per team, single-flight sweeps at startup, on the D11 notifications, and on a 60 s timer while there is work. Verify with tests:
  - the timer stops when the team has no running execution or promotion and no open fix or correction task;
  - a sweep error is logged and the next trigger retries;
  - a sweep never writes execution rows.
- [ ] 8.3 Raise stall alerts (D11). Verify with tests:
  - the alert row and Kawai's mail commit in one transaction, tagged `plan-stall` and `stall:<kind>`, with the role's `allowed_profiles` and the D11 body;
  - a restart during a stall sends nothing new;
  - new progress then a new stall sends a second alert;
  - with no Lead role, a row with a null message is written and no mail is sent;
  - a reply to the alert hits Kawai's reply guard.
- [ ] 8.4 Complete fix and correction tasks in the sweep by the D8 rule. A change counts as landed when it has a landing fact and its definition in the landing execution's revision names the task; it counts as outstanding when the current approved revision names the task and it has no landing fact. Verify with tests:
  - the task closes once a naming change has landed and none is outstanding, with a note naming the merge commits;
  - one change landed of two keeps it open;
  - a revision naming the task with nothing landed keeps it open;
  - a change that landed from revision 5 still closes the task after revision 6, which no longer names it, is approved;
  - a later revision that adds another naming change keeps the task open until that change lands;
  - a superseded fix stays cancelled;
  - an owner-accepted no-change result leaves the task done, Kawai writes nothing for it, and `fixStatus` reads no change.
- [ ] 8.5 Create and complete correction tasks for failed promotions (D8). Verify with tests:
  - a promotion stored as `failed:promotion-conflict` or `failed:ci-failed` gets one correction task with the D8 title and evidence, and its instruction names `fixes`, also across a restart;
  - the other failures and a cancellation create none;
  - a landed change naming the correction closes it by the 8.4 rule;
  - a later merged promotion closes it with a note.
- [ ] 8.6 Push `team-plan-detail` after a sweep that changed a plan's derived view, and only then. Verify with a test that two sweeps with no change push once.
- [ ] 8.7 Add the AGENTS.md supervision bullet: outcomes, named waits, progress versus activity, the two stalls and their deadlines, alerts, and the report. Verify by reading it against D10–D12.

## 9. Team workspace

- [ ] 9.1 Extend `AttentionKind` with the six kinds and `AttentionLink` with `plan` and an optional `planId` and `change` (D13). Verify with a typecheck and a shared-type test.
- [ ] 9.2 Implement `planAttention.ts` and register its sources in `ATTENTION_SOURCES` (D13). Verify with one test per kind:
  - the owner, next action, and link follow the D13 table;
  - a fix task's owner follows its phase;
  - each item clears when its cause clears;
  - a correction task's owner follows the same phases as a fix task's;
  - the `plan-promotion` item is absent while a correction for it is open, and returns when that correction closes with no later promotion started;
  - another team's plans never appear.
- [ ] 9.3 Add the five summary buckets to `MorningSummary` over team-workspace's 24-hour window (D13). Verify with a test that they read only durable rows inside the window, and that they survive a restart.
- [ ] 9.4 Extend the team-workspace AGENTS.md bullet with the plan sources and buckets. Verify by reading it against D13.

## 10. Plans view

- [ ] 10.1 Extend `teamPlanStore` with decisions, supervision, and usage, plus one command id per open Answer or Override dialog (D15). Verify with store tests: an id is re-minted only when the payload changes, a reconnect replays under the same id, and every apply method has a dispatch caller.
- [ ] 10.2 Build `PlanDecisionCard.tsx` and `PlanDecisionDialog.tsx`. Verify with component tests:
  - cards render inline in their change row, and in the Decisions list when they have no change;
  - the history and fix status show;
  - Override names the decision it replaces and requires a rationale;
  - controls disable while disconnected, and refusals show inline.
- [ ] 10.3 Build `PlanReportSection.tsx`: outcome counts, named waits, progress and activity with ticked elapsed times, stops with blocked dependents, partial delivery, candidates, the disposition, and M2/M4 (D12). Verify with component tests for a stopped, a stalled, and a fully landed plan.
- [ ] 10.4 Build `PlanUsageSection.tsx`: the group × profile table, the per-change rows, and the note on what is not counted (task-less turns and Task subagent calls), with no currency (D14). Verify with a component test.
- [ ] 10.5 Navigate `plan` and `card` attention links to the plan detail, scrolled to the change or card (D15). Verify with a navigation test from the attention queue.
- [ ] 10.6 Describe the cards, the report, and the usage section in the Plans AGENTS.md bullet. Verify by reading it against D15.

## 11. Integration

- [ ] 11.1 Add a fixture walkthrough, `tests/e2e/plan-supervision.spec.ts`, and name it in `.github/workflows/ci.yml`. It shows a seeded execution with a Lead-answered card, then an owner override that creates a fix task and puts a `plan-fix` item in the attention queue, then a stall in the report. Verify by running it alone on a spare `E2E_PORT` after `bun run build`, then checking that `http://localhost:4040/` still answers.
- [ ] 11.2 Run `bun run lint && bun run typecheck && bun run test` and `openspec validate plan-supervision --strict`. Verify that all pass, and that no new file exceeds 500 LOC.

## Workflow follow-up

- Archive `plan-execution` before archiving this change, because the `team-tasks` delta modifies a requirement that only it adds.
- Archive this change after its pull request merges.
