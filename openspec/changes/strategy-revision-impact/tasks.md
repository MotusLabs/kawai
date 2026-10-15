# Tasks

Implement after `durable-plans` has landed on master, then rebase this branch onto it. Every file stays under 500 LOC. Tests that spawn git use `cleanGitEnv`.

## 1. Shared model

- [x] 1.1 Reconcile names with the merged `durable-plans` design: the pin type, `PlanStore` reads, `pinDisposition`'s signature, the plan-change notification, and `team-plan-result`. Record any renames in this change's design before coding. Verify by reading the merged `durable-plans` design D7 and D13 against D2, D6, and D9 here.
- [x] 1.2 Create `src/shared/strategyImpact.ts` with the D2 types and `impactGate`, `impactGroup`, and `reviewState`. Verify with unit tests, one per rule:
  - current pin, and both pins empty;
  - no strategy record;
  - an older pin with each effective disposition and with none;
  - an empty pin while a revision is approved;
  - a pin to a withdrawn revision, to another strategy record, and to any revision while none is approved, each ignoring a recorded `continue`;
  - a pin to another strategy record with the current revision number and hash, which must be `withdrawn-direction` (this forces rule 1 to compare `strategyId`);
  - a pin whose hash matches no revision, ignoring a recorded `continue`;
  - a missing current review;
  - groups for closed, affected, unaffected, and draft-only plans;
  - review states: needs decisions, reviewed (including no affected plans), superseded, and withdrawn.

## 2. Impact store

- [x] 2.1 Add `src/server/strategy/impactSchema.ts` with the D1 DDL, including the expression chain index. Verify with migration tests on a fresh database and on one created by the current strategy schema: existing impact reviews read back unchanged, and a reopen round-trips every row.
- [x] 2.2 Implement `impactStore.ts`: inserts and reads for proposals, decisions (chain head, history), and requests, plus the lookup of a command id per strategy. Verify with store tests:
  - the chain index refuses two first decisions for one plan and a forked successor;
  - a duplicate command id per strategy is refused at the database, across reviews;
  - every row survives a reopen.

## 3. Impact service

- [x] 3.1 Implement `ImpactService.detail(teamId)` per D3 on `durable-plans`' plan reads. Verify with service tests:
  - affected, unaffected, and historical grouping, with the unassessed mark;
  - an assessment only for the current review;
  - earlier reviews returned with their records and derived states;
  - no strategy record returns null without creating anything.
- [x] 3.2 Implement `decide` per D4: agent refusal, replay, current review, plan group, rationale rules, proposal match, the predecessor check, and the snapshot. Verify with service tests:
  - each refusal writing nothing, with its named reason;
  - a same-payload retry returning the decision;
  - a changed payload refused naming the field;
  - two decisions racing on one database leaving one effective decision. The loser is refused as stale, naming the decision that committed, including when the chain index is what refuses it;
  - a concurrent resend of the same command resolving as its replay, including when the chain index is the constraint reported;
  - a later decision superseding an earlier one, both readable;
  - row counts of plans, plan revisions, tasks, messages, and spawns unchanged.
- [x] 3.3 Implement `propose` per D5. Verify with service tests: a recorded proposal changing no gate, a stale review refused, an unaffected plan refused, another team's plan read as not found, and the rationale rules.
- [x] 3.4 Implement `gate`, `pinDisposition`, and `stateKey` per D6 and D11, and wire `pinDisposition` into `durable-plans`' approval context. Verify with tests through `PlanService.approve`:
  - `continue` lets a non-current pin pass;
  - `adapt`, `reconsider`, and no decision keep the `strategy-pin-current` refusal;
  - under `adapt` and under `reconsider`, a resubmitted revision passes and the plan stays open;
  - a withdrawn pinned revision is refused despite `continue`;
  - a newer strategy approval makes the old `continue` stop counting;
  - `stateKey` changing exactly when a gate result changes.
- [x] 3.5 Implement `requestAssessment` per D8. Verify with service tests:
  - exactly one human, normal-priority group message with no task, whose body names the review, the strategy revision, and each affected plan;
  - a retry returning the same message id;
  - a second request under a new command id sending a second message;
  - an unknown group and a stale review refused with no message;
  - an agent caller refused.
- [x] 3.6 Add the AGENTS.md How It Works bullet for impact reviews: groups, dispositions, the gate and withdrawn directions, idempotency and the chain index, the request, and "triggers nothing". Verify by reading it against D1–D8.

## 4. Agent tools and prompt

- [x] 4.1 Add `impactTools.ts` per D10, joining `TEAM_ALLOWED_TOOLS`. Extend `STRATEGY_FORBIDDEN_TOOL_NAMES`, and update the `strategyTools.ts` header. Verify with tool tests:
  - a get and propose round trip;
  - identity bound to the session, even with a forged actor in the input;
  - another team's ids read as not found;
  - no registered tool decides, approves, publishes, withdraws, or deletes.
- [x] 4.2 Extend the strategy note in `teamPrompt.ts` per D10. Verify with a prompt test asserting the tools, the owner-only decision, and that the note never claims an agent can decide.
- [x] 4.3 Update the AGENTS.md agent strategy tools bullet to name the two impact tools. Verify by reading it against D10.

## 5. Human protocol and pushes

- [x] 5.1 Add `strategy-impact-decide` and `strategy-impact-request` to `src/shared/types.ts` and `CHAT_CONNECTION_TYPES`, handle them in `StrategyConnections.act`, and add `impact` to `strategy-detail`. Verify with connection tests:
  - decide and request round trips by repository path and by worktree path;
  - an unknown path refused;
  - another team's review refused with no data;
  - a test asserting both types are listed in `CHAT_CONNECTION_TYPES`.
- [x] 5.2 Wire the D9 pushes: impact writes publish strategies and plans, plan writes publish strategies, and strategy changes publish plans. Add `impact` to the plans snapshot and detail, and to `team-plan-result` for a `strategy-pin-current` refusal. Verify with connection tests:
  - an open Strategy view refreshing on a plan submission;
  - an open Plans view refreshing on a decision and on a strategy approval;
  - a refused approval's result carrying the same gate as the plan detail.

## 6. Client

- [x] 6.1 Extend `strategyStore.ts` with the impact detail, `focusImpactReview`, and the decide and request actions, with a WS dispatch caller for every method that applies server state (grep the join). Each dialog mints one command id, reuses it while the payload is unchanged, and re-mints after a payload change following a lost result. (Per the 1.1 reconciliation, `focusImpactReview` is the Team page location `strategy/impact/<revision>`.) Verify with store tests:
  - detail application;
  - reconnect replacing state;
  - key reuse and re-mint;
  - a lost result never leaving `busy` set.
- [x] 6.2 Build `StrategyImpactReview.tsx` per D9, and list reviews with their states in `StrategyRevisionHistory`. Verify with component tests:
  - each review state;
  - the groups with pins, gates, and the unassessed mark;
  - the decision history;
  - the Decide dialog requiring a rationale;
  - **Use proposal** pre-filling the dialog. Changing the disposition afterwards drops the proposal id, and editing only the rationale keeps it.
  - the Ask to assess dialog preselecting `lead`;
  - controls disabled while disconnected;
  - refusals inline;
  - keyboard focus and labels.
- [x] 6.3 Add `PlanImpactBadge` to the Plans list and detail, show the impact state beside a refused approval, and link to the review through the side slot. Verify with component tests: badge states, the link focusing the review, and the refusal showing the same state as the badge. (Per the 1.1 reconciliation, the link navigates the Team page to `#/team/<key>/strategy/impact/<revision>`; the side slot no longer hosts strategy.)
- [x] 6.4 Add the AGENTS.md Strategy UI and Plans view mentions and the Structure entries for the new files. Verify by reading them against D9.

## 7. Integration walkthrough

- [ ] 7.1 Add `tests/e2e/chat-strategy-impact.spec.ts` and name it in `.github/workflows/ci.yml`, in the `AGENTBOARD_CHAT_FIXTURE=1` fixture step's spec list beside `strategy.spec.ts`. Seed only prerequisites, written through the store and tool paths:
  - a `lead` group definition in the fixture team;
  - strategy revision 1 approved;
  - a plan approved under it;
  - strategy revision 2 in review.

  Then drive the rest through the UI:
  1. approve strategy revision 2 and see the review in Needs decisions, with the plan affected;
  2. open the plan from the Plans badge link;
  3. record `continue` with a rationale and see Reviewed;
  4. record `adapt` and see the superseded `continue` in the history;
  5. ask the `lead` group to assess and see the message in the Messages view.

  Also cover a concurrent decision from a second tab being refused inline. Run it locally as the only spec, after `bun run build`, on a spare `E2E_PORT`; never `bun run test:e2e`. Afterwards http://localhost:4040/ must still answer.
- [ ] 7.2 Run `bun run lint && bun run typecheck && bun run test` and `openspec validate strategy-revision-impact --strict`. Verify all are green on the final head.
