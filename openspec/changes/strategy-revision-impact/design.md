# Design

## Context

See proposal.md for the motivation. Facts that shape the approach:

- **Strategy module.** `src/server/strategy/` holds `strategySchema.ts`, `strategyStore.ts` (493 lines, so nothing more fits), `StrategyService.ts`, `strategyTools.ts`, and `strategyConnections.ts`.
  - Approval inserts one `strategy_impact_reviews` row `{ id, strategy_id, revision, content_hash, command_id, state: 'pending', created_at }` in its transaction (`strategyStore.approve`).
  - Withdrawal never creates one. Withdrawing the active approved revision sets `current_approved_revision` to null; it does not restore an older revision (`strategyStore.withdrawRevision`).
  - A revision is approved at most once, since approval requires `in_review`. So there is at most one review per revision, and "the current review" is the review whose `revision` is the strategy's current approved revision.
- **Human strategy actions.** `strategy-${string}` client messages route to `StrategyConnections`. Messages that carry a `requestId` are actions answered by `strategy-result`, and every type must be listed in `CHAT_CONNECTION_TYPES`. Pushes go through `ChatConnections.publishStrategies(teamId)`, which re-sends the snapshot and detail whole.
- **Agent strategy tools.** `strategyTools.ts` registers exactly four, and its header forbids approve, publish, withdraw, and delete tools. `product-strategy` requires only that no agent tool approves, publishes, withdraws, or deletes a revision.
- **`durable-plans` (lands first).** It publishes, in its design D13:
  - C2: per-revision pins `{strategyId, revision, hash}` or empty, plus `PlanStore.revisionsPinnedTo(strategyId)` and `openPlans(teamId)`;
  - C3: `PlanService` as the only plan writer. Its after-commit change announcement, which the Plans view's pushes follow, therefore sees every plan write.
  - C4: the ordered `APPROVAL_PRECONDITIONS` and a `pinDisposition(planId, revision)` lookup, which `strategy-pin-current` consults and which returns null until this change.

  This change neither reads nor writes `plan_events` (C6).

  Submission always pins the current approved strategy revision, or nothing when none is approved. So every revision submitted after an approval is current, and every non-current revision predates the current review.
- **Human mail.** `AssignmentService` sends human mail inside its own transaction with `MailboxStore.enqueue({ fromKind: 'human', fromSession: null, fromGroup: null, originPath: team.groupsRoot, priority: 'normal', actor: 'human', … })`, after checking the group against the team's catalog.

### Reconciliation with the merged `durable-plans` (task 1.1)

Read against the merged `durable-plans` design D7, D12, and D13 and its code on master. Where this design's names differ, the merged names below win, and the decisions that follow use them:

- **Pin type.** `StrategyPin` is `PlanStrategyPin { strategyId, revision, hash }` from `src/shared/plans.ts`; an empty pin is `null`. Whole-pin equality is the shipped `samePin` (both null count as equal), which already compares `strategyId`.
- **Plan reads.** `PlanStore.openPlans(teamId)` and `revisionsPinnedTo(strategyId)` exist as C2 promised. The assessment also needs closed plans (historical) and unpinned revisions, which `revisionsPinnedTo` cannot return, so `ImpactService` reads `PlanStore.list(teamId)` and `PlanStore.revisions(planId)`. `forTeam(teamId, planId)` scopes a plan id to the team.
- **`pinDisposition`.** Its signature is `(planId: string, revision: number) => PinDisposition | null` with `PinDisposition = { kind: string }` (`planPreconditions.ts`), supplied through the `pinDisposition` option of the `PlanService` constructor in `ChatSessionManager`. `ImpactService.pinDisposition` returns `{ kind: 'continue', decisionId }`. The precondition reads the current strategy pin itself; the lookup is only consulted when the pin is not current.
- **Plan-change notification.** C3's announcement is `PlanStore.subscribe(listener(plan))`, fed by `announce(planId)` after every committed `PlanService` write. `ChatSessionManager` forwards it as `onPlanChange(teamId, planId)`, which also fires for linked-task changes. The strategy push on plan writes subscribes to the plan store itself, so a task change does not re-send strategy detail. Strategy changes arrive through `StrategyStore.subscribe` as `onStrategyChange(teamId)`.
- **Plan messages.** They live in `src/shared/planMessages.ts`, not `types.ts`. `team-plan-result` carries `failures: Array<{ name, message }>`; it gains `impact?: ImpactGate`. `team-plans-snapshot` entries and `team-plan-detail` gain an additive `impact: PlanImpact` (`{ group, gate, reviewId, revisions: [{ revision, gate }] }`); `PlanSummary` and `PlanDetail` stay untouched.
- **Strategy view host.** `ProductStrategyPanel` and `sideSlot.ts` no longer host strategy: the Strategy view is the Team page's Strategy tab (`ProductStrategyView`, sub-views overview, review, draft, history), and the side slot hosts only the debug panel. The impact review is a new Strategy sub-view, `impact` (`#/team/<key>/strategy/impact[/<revision>]`, the id being the review's strategy revision). `strategyStore.focusImpactReview(teamKey, reviewId)` becomes that location: the Plans badge link navigates the Team page to it, and the URL is the focus, as for every other Team page selection.
- **Human mail.** `TeamIdentity.groupsRoot` and `loadGroupCatalog` are the catalog check `AssignmentService.groupOf` uses; `MailboxStore.enqueue` notifies the dispatcher through its store subscription, so no extra notify is needed after commit.

## Goals / Non-Goals

**Goals:**
- One pure gate function that every plan gate shares, so the Plans view, plan approval, and the later Wave C gates can never disagree.
- Decisions made safe by database facts: command-id uniqueness, and a chain index that prevents two decisions from replacing the same predecessor.
- No stored derived state: the review state, the plan groups, and the gate results are all computed when read.

**Non-Goals:**
- Editing `durable-plans`' shipped preconditions or their messages. This change supplies only the `pinDisposition` lookup and adds the impact state beside a refusal.
- Changing `strategy_impact_reviews` rows or strategy approval and withdrawal.
- Bulk decisions, expiring decisions, and notifications of any kind beyond the explicit assessment request.

## Decisions

### D1. Three tables in new impact files

`impactSchema.ts` adds the tables, `impactStore.ts` reads and writes them, `ImpactService.ts` holds the rules, and `impactTools.ts` holds the agent tools, all under `src/server/strategy/`. Each file stays under 500 lines.

```sql
strategy_impact_proposals (
  id TEXT PRIMARY KEY,                -- 'impact-proposal-<uuid>'
  strategy_id TEXT NOT NULL,
  review_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  disposition TEXT NOT NULL,          -- continue | adapt | reconsider
  rationale TEXT NOT NULL,
  author_session TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX strategy_impact_proposals_plan ON strategy_impact_proposals (review_id, plan_id, created_at);

strategy_impact_decisions (
  id TEXT PRIMARY KEY,                -- 'impact-decision-<uuid>'
  strategy_id TEXT NOT NULL,
  review_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  disposition TEXT NOT NULL,
  rationale TEXT NOT NULL,
  proposal_id TEXT,                   -- the proposal the owner recorded, if any
  supersedes_decision_id TEXT,        -- the effective decision it replaced; null for the first
  plan_snapshot_json TEXT NOT NULL,   -- the plan's non-current revisions and pins at decision time
  actor_kind TEXT NOT NULL,           -- always 'human'
  command_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,         -- compared on replay
  created_at TEXT NOT NULL,
  UNIQUE (strategy_id, command_id)
);
CREATE UNIQUE INDEX strategy_impact_decisions_chain
  ON strategy_impact_decisions (review_id, plan_id, IFNULL(supersedes_decision_id, ''));

strategy_impact_requests (
  id TEXT PRIMARY KEY,                -- 'impact-request-<uuid>'
  strategy_id TEXT NOT NULL,
  review_id TEXT NOT NULL,
  target_group TEXT NOT NULL,
  message_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (strategy_id, command_id)
);
```

Command ids are unique per strategy, as for strategy decisions, so a reused id is caught even across reviews.

The chain index makes a forked decision chain impossible. Two writers naming the same predecessor, including two first decisions (the `IFNULL` maps the null predecessor to one key, since a plain unique index treats nulls as distinct), cannot both commit. The effective decision is the chain head: the decision for (review, plan) that no other decision supersedes.

*Alternative:* store the effective disposition as a mutable column per (review, plan). Rejected: history would need a second table anyway, and a mutable row loses the predecessor check.

### D2. A pure model in `src/shared/strategyImpact.ts`

```ts
type ImpactDisposition = 'continue' | 'adapt' | 'reconsider'
type ImpactGateState = 'current' | 'continue' | 'decision-required' | 'adapt' | 'reconsider' | 'withdrawn-direction'
type ImpactGate = {
  state: ImpactGateState
  pass: boolean                    // true only for 'current' and 'continue'
  reviewId: string | null          // the current review, when one applies
  decisionId: string | null        // the effective decision it rests on
  pin: PlanStrategyPin | null      // durable-plans C2 (src/shared/plans.ts)
}
type ImpactGroup = 'affected' | 'unaffected' | 'historical'
type ImpactReviewState = 'needs-decisions' | 'reviewed' | 'superseded' | 'withdrawn'
```

`impactGate(pin, strategy, currentReview, effectiveDecision)` applies these rules in order:
1. If the pin equals the team's current approved `{strategyId, revision, hash}` as a whole, it is `current`. With no strategy record, or no approved revision, the current pin is empty, and an empty pin then matches. Revision numbers restart at 1 in every strategy record, so the comparison must include `strategyId`. Matching revision and hash alone is not enough.
2. If the pin is non-empty, it is `withdrawn-direction` when either holds:
   - the strategy has no approved revision;
   - the pin does not name a `superseded` revision of the team's strategy record with that revision's stored hash. This covers another strategy record, a withdrawn revision, and a hash that matches no revision's content.

   Pins are server-derived and revisions are immutable, so the last case is defensive. It still keeps `continue` from covering a pin that names no real direction.
3. Otherwise the pin is non-current: an older revision of the current record, or an empty pin while a revision is approved. The effective decision in the current review decides:
   - `continue` → `continue`;
   - `adapt` → `adapt`;
   - `reconsider` → `reconsider`;
   - no decision → `decision-required`.

   If no review exists for the current revision (never expected), the state is `decision-required` with a null review id. Then the only path is resubmission.

`adapt` and `reconsider` gate identically. Both refuse the plan's non-current revisions, and neither stops the plan. Rule 1 runs first, so a resubmitted revision, pinned to the current revision, passes whatever disposition exists; resubmission is the intended way forward for both. They differ in what the owner asks for: a re-pinned revision, or a later decision. That difference shows in the label, the refusal, and C-I3, where `revision-control` may later hold a plan on `reconsider`. This change adds no hold.

`impactGroup(plan, revisions, strategy)`:
- A completed or cancelled plan is `historical`.
- An open plan with an `approved` or `in_review` revision whose gate rule 1 fails is `affected`.
- Every other open plan is `unaffected`.

`reviewState(review, strategy, affectedRows)`:
- If the review's revision is the current approved one: `needs-decisions` when any affected row lacks an effective decision, otherwise `reviewed`.
- Otherwise: `withdrawn` when that revision's status is `withdrawn`, else `superseded`.

The functions are pure and SDK-free, so the server computes them and the client can re-derive labels without drift.

### D3. The assessment is derived per read, for the current review only

`ImpactService.detail(teamId)` reads:
- the team's strategy and its revisions' statuses;
- every review;
- the decisions, proposals, and requests;
- through `durable-plans`' reads, the team's plans with their `approved` and `in_review` revisions and pins.

It returns `StrategyImpactDetail`:

```ts
{
  currentReviewId: string | null
  reviews: Array<{ reviewId, revision, createdAt, state: ImpactReviewState,
                   decisions, proposals, requests }>          // newest first; records only
  assessment: { affected: ImpactPlanRow[]; unaffected: ImpactPlanRow[]; historical: ImpactPlanRow[] } | null
}
ImpactPlanRow = { planId, title, lifecycle,
  revisions: Array<{ revision, status, pin, gate: ImpactGate, unassessed: boolean }>,
  effectiveDecision, decisionHistory, latestProposal, proposalCount }
```

Only the current review has an `assessment`. Earlier reviews show only what was recorded in them, because a live regrouping against a superseded revision would mislead.

*Alternative:* materialize affected-plan rows at approval time. Rejected: `strategy-approval` requires the approval to create exactly one item and nothing else, and a snapshot would go stale as plans move.

### D4. Decisions: human-only, one transaction, replay and predecessor checks

The human sends `strategy-impact-decide { teamPath, requestId, reviewId, planId, disposition, rationale, proposalId?, expectedDecisionId, commandId }`. `ImpactService.decide` refuses agent callers first. Then, in one SQLite transaction:

1. **Replay.** Look up `(strategy_id, command_id)`. With the same payload (`reviewId`, `planId`, `disposition`, `rationale`, `proposalId`, `expectedDecisionId`), return the recorded decision. Otherwise refuse, naming the first differing field.
2. **Review is current.** If not, refuse as stale: "review superseded, or its revision withdrawn".
3. **Plan.** The plan must belong to the team; otherwise it reads as not found. It must be `affected` now (D2); otherwise refuse, naming its group.
4. **Rationale.** It must be non-empty after trimming and at most 2,000 characters. Text over the limit is refused, never cut, because the owner's words are the record.
5. **Proposal.** If `proposalId` is given, it must be a proposal of this review and plan with the same disposition. The rationale may be edited.
6. **Predecessor.** `expectedDecisionId` must equal the current chain head, or both are null. Otherwise refuse as stale, naming the decision recorded meanwhile.
7. **Insert.** Write the row with `supersedes_decision_id = expectedDecisionId` and the snapshot of the plan's non-current revisions. The chain index backs step 6 at the database. In a true race, both writers read the same chain head and pass step 6, then the loser's insert hits a unique index. A concurrent resend of the same command violates both the chain index and `UNIQUE (strategy_id, command_id)`, and SQLite names only one, so the mapping never branches on the index name. On any unique-constraint hit the transaction rolls back and step 1 runs again:
   - If a row carries this command id, the request resolves as step 1 does: a replay, or a refusal naming the differing field.
   - Otherwise the decision is refused as step 6's stale-predecessor failure, naming the decision that committed.

   A constraint error never reaches the client raw.

Then publish strategies and plans for the team (D9).

### D5. Proposals: an agent tool, append-only, no gate

`ImpactService.propose(agent, { planId, disposition, rationale, reviewId? })` checks:
- the review is current (an omitted id means the current review; a named non-current one is refused as stale);
- the plan is the team's and affected;
- the rationale follows D4's rule.

It then inserts a proposal. There is no compare-and-swap, because proposals never replace one another. The owner sees the newest proposal and the count, and the decide dialog offers "Use proposal", which pre-fills the disposition and rationale and sends `proposalId`.

### D6. The gate and its wiring into plan approval

`ImpactService.gate(planId, revision)` reads the inputs and returns `impactGate(...)` (contract C-I1).

`durable-plans`' `pinDisposition(planId, revision)` is supplied by `ImpactService.pinDisposition`. It returns the effective `continue` decision when `gate.state === 'continue'`, and null in every other state. So `strategy-pin-current` passes exactly when the spec allows, and the shipped precondition list stays untouched.

The shipped `strategy-pin-current` message stays unchanged. The reason is carried instead by an `impact` field beside the refusal, which the UI renders. When a `team-plan-approve` is refused with `strategy-pin-current` among its failures, the plan connection adds `impact: ImpactGate` for that revision to `team-plan-result`. The Plans view renders that as "Strategy impact: decision required / adapt / reconsider / withdrawn direction — Open review".

The Plans view's badge comes from the same function. `team-plans-snapshot` entries gain `impact: { group, gate }`, using the gate of the approved revision when there is one, else of the newest in-review revision. `team-plan-detail` gains `impact` per `approved` or `in_review` revision. One function means the badge and the refusal cannot disagree.

As with `strategy-detail` (D9), the connection composes these `impact` fields beside the plan store's reads. `durable-plans`' stored plan types stay untouched, and the messages only gain additive fields.

### D7. Withdrawn directions

Gate rule 2 runs before any decision is consulted, so no disposition revives a withdrawn direction. A `continue` recorded before the withdrawal stays readable but stops counting.

Already approved plan revisions keep their `approved` status. Nothing rebinds, pauses, or notifies. The gate affects only the next action that consults it: an approval now, and a Start or validation in later changes. `strategy-approval`'s "withdrawal does not retroactively invalidate what an earlier approval authorized" holds, because recorded approvals and outcomes are never rewritten.

### D8. The assessment request: one human message in one transaction

The human sends `strategy-impact-request { teamPath, requestId, reviewId, group, commandId }`. `ImpactService.requestAssessment` refuses agent callers. Then, in one transaction:
1. Replay by `(strategy_id, command_id)`: the same `reviewId` and `group` returns the stored message id; anything else is refused naming the field. As in D4, if the request row's insert hits the command-id unique key, this step runs again. A new command id is a new request, so asking again, or asking another group, sends another message.
2. The review must be current.
3. The group must be in the team's catalog. The check is the same one `AssignmentService` uses, and an unknown group is refused by name.
4. Build the body from the current assessment:
   - the product and strategy revision;
   - the review id;
   - each affected plan with its id, its revisions' pins, its effective decision, and its newest proposal;
   - the instruction to assess each plan against the revision and propose one disposition with `strategy_impact_propose`, noting that only the owner records decisions.
5. Insert the message through `MailboxStore.enqueue` as a human message to the group, with normal priority and no task, exactly as `AssignmentService` does.
6. Insert the request row with the message id.

After commit, the dispatcher is notified as for any human send. The message follows ordinary routing: it waits for an idle member and never spawns, since it has no task. An agent's reply in its thread reaches the human under `team-message-threads`' rules.

The client preselects `lead` when the team defines that group and lets the owner pick another. No group name is hard-coded on the server.

### D9. Protocol, pushes, and views

- **Messages.** Add `strategy-impact-decide` and `strategy-impact-request`. Both carry `requestId`, so `StrategyConnections.act` handles them and answers with `strategy-result` (`decision` or `messageId` on success). Both are listed in `CHAT_CONNECTION_TYPES`. The `strategy-detail` message gains `impact: StrategyImpactDetail | null`, composed beside `store.detail(...)` so the stored strategy detail type is untouched.
- **Pushes.**
  - Every impact write calls `publishStrategies(teamId)` and `publishPlans(teamId)`.
  - Every committed plan write also calls `publishStrategies(teamId)`, because the assessment derives from plans. The hook is C3's after-commit change announcement. `PlanService` is the only plan writer, so the hook misses no write.
  - Every strategy store change also calls `publishPlans(teamId)`, because approvals and withdrawals change every plan's gate.

  Pushes go only to subscribed connections, as today.
- **Strategy view.** A new `StrategyImpactReview.tsx`, rendered by `ProductStrategyPanel` above the revision history, shows:
  - the current review's state;
  - the three groups;
  - per affected row: pins, gates, the unassessed mark, the effective decision with its history, and the newest proposal;
  - a **Decide** dialog:
    - a disposition radio and a required rationale;
    - **Use proposal**, which fills in the disposition and rationale and sets `proposalId`. Changing the disposition afterwards drops `proposalId`, so D4 step 5 never refuses a mismatch the owner cannot see. Editing only the rationale keeps it.
    - one command id per dialog, re-minted only after a payload change following a lost result, as the strategy approve dialog does;
  - an **Ask to assess** dialog with a group picker.

  `StrategyRevisionHistory` lists every review with its state and recorded decisions.
- **Plans view.** A `PlanImpactBadge` appears on list rows and in the detail. Its link opens the Strategy panel through `sideSlot.ts` and focuses the review (`strategyStore.focusImpactReview(teamKey, reviewId)`).
- **Connection state.** Controls disable while disconnected, and refusals render inline.

### D10. Agent tools and the prompt

`impactTools.ts` registers two tools, both joining `TEAM_ALLOWED_TOOLS`, with identity bound to the calling session:
- `strategy_impact_get({ review_id? })` returns `StrategyImpactDetail`, or one named review's records.
- `strategy_impact_propose({ plan_id, disposition, rationale, review_id? })`.

`strategyTools.ts`' header and AGENTS.md change from "exactly four" to the four strategy tools plus the two impact tools. `STRATEGY_FORBIDDEN_TOOL_NAMES` gains `strategy_impact_decide` and `strategy_impact_record`. The tool-list test asserts that no registered tool decides, approves, publishes, withdraws, or deletes. `ImpactService` refuses agent callers on the decide and request paths regardless (defense in depth, as `StrategyService` does).

`teamPrompt.ts`' strategy note gains:
- the two tools;
- that a strategy approval opens an impact review that only the owner decides;
- that proposals change nothing until the owner records a decision;
- that when asked to assess, the agent proposes one disposition per affected plan, with a rationale grounded in what changed between the pinned and the current revision.

### D11. Contracts for the later Wave C changes

| Contract | What it fixes | Bound by |
| --- | --- | --- |
| C-I1 Impact gate | `ImpactService.gate(planId, revision) → ImpactGate` (D2 rules) | plan approval (now), `plan-validation`, `plan-execution`'s Start |
| C-I2 Impact state key | `ImpactService.stateKey(planId)`: sha256 over the canonical gate results of the plan's `approved`/`in_review` revisions; equal keys mean equal gates | `plan-validation`'s input identity |
| C-I3 Dispositions | `continue`/`adapt`/`reconsider` and the effective decision per plan in the current review | `revision-control` (holds may cite `reconsider`), `plan-supervision` (decision cards may link the review) |

## Risks / Trade-offs

- [After the first strategy approval, every plan submitted without a pin needs a decision] → This is what `durable-plans`' stale-pin rule implies already. The assessment request, proposals, and **Use proposal** make it one action per plan. Resubmitting also clears it.
- [`continue` cannot revive a withdrawn direction] → Deliberate. Approved revisions and running work are untouched, and resubmission is one tool call.
- [The assessment can change between render and decision] → Step 3 of D4 re-checks affectedness inside the transaction, and pushes refresh the view.
- [Plan writes now push strategy detail] → Only to subscribed connections, and the payloads are small. Strategy and plan writes are rare compared with mail.
- [`durable-plans` may shift in its own review or implementation] → This change binds to C2, C3, and C4 by name. Task 1.1 starts by reconciling names with the merged `durable-plans` design.

## Migration Plan

The migration is additive. `CREATE TABLE IF NOT EXISTS` adds the three tables and the chain index. Existing `strategy_impact_reviews` rows are untouched and gain derived states when read:
- the current review shows Needs decisions or Reviewed;
- the others show Superseded or Withdrawn.

There is no backfill: no decision is invented for an existing plan. Rollback leaves the new tables unread, and plan approval falls back to `durable-plans`' null `pinDisposition`, which is stricter but loses nothing.

## Open Questions

- Should the owner be able to record one rationale for several plans at once? This can be deferred: each plan would still get its own decision record.
- Should a `continue` lapse when a plan's newer revision is approved? This can be deferred: a newer revision is current by construction, so the decision simply stops mattering.
