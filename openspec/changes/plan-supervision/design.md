# Design

## Context

See proposal.md for the motivation. Current state and constraints:

- **Plans and executions.** `durable-plans` stores plans, revisions, and `plan_events`, with `PlanService` the only writer of plan events (C3). `plan-execution` stores executions, change rows (state, step, stop reason, fix rounds), attempts, rounds, effects, the landing slot, and landing facts (X1, X3, X7, X8). Its D3 leaves "stalled" and "needs attention" to be derived here. `integration-candidates` adds candidates and promotions (I1, I2). None of the plan modules is implemented yet, so this change is written against their designs and contracts. It is implemented after them.
- **Kawai as an actor.** plan-execution D2 adds `SystemActor` and a system `TaskCaller` that only `ExecutionService` constructs, with rights limited to an execution's own tasks. D7 modifies that caller.
- **Replies to Kawai.** plan-execution D18 refuses replies to Kawai's mail in the `reply` tool (`mailboxTools.ts`) and in the human composer's reply path (`messageConnections.ts`).
- **The team workspace.** `team-workspace` (on master) registers attention sources in `ATTENTION_SOURCES` (`src/server/team/workspaceRead.ts`), each a pure function over existing state. Its `AttentionLink.kind` already reserves `card` for Lead decision cards (its D5). The morning summary is a fixed set of `SummaryBucket`s; `runtimeOnly` marks buckets a restart empties.
- **Turn ends.** `ChatSessionManager` writes `chat_turn_ends` on `turn_completed` for task-bound sessions (`chatTurnEndStore.ts`). The driver's `handleResult` (`ChatSessionDriver.ts`) emits `turn_completed` with `subtype`, `totalCostUsd`, and `numTurns`. The SDK result's `usage` field (input, output, cache-read, and cache-creation tokens) is per turn and covers the main agent loop only: the SDK's type notes say it excludes Task subagent, sidechain, and auxiliary model calls. `total_cost_usd` and `modelUsage` are cumulative per `query()` call: a resumed or forked session continues from its saved total, and a mid-session `/clear` resets it.
- **The mail behind a turn.** `LimitOutcomes.delivered(sessionId, message)` (`src/server/team/routing/limitOutcomes.ts`) already tracks the mail pushed as a session's next turn, until that turn ends. It is last-write-wins per session, so a later push replaces it; D14 therefore pins a turn's mail when the turn starts.
- **Strategy boundaries.** Usage is shown, never capped. No agent approves anything the owner decides.

## Goals / Non-Goals

**Goals:**
- Decisions are records that the owner can review and override, and each override has an observable path to a landed fix.
- Every claim the supervision view makes comes from a durable record or a named runtime fact. Nothing is a percentage or a guess.
- Supervision never changes execution state: it reads, alerts, and creates fix and correction tasks, and does nothing else.

**Non-Goals** (beyond the proposal's):
- Configurable stall deadlines.
- Per-turn tool-use history.
- A team-wide usage view outside plans.
- Notifications other than mail and attention items.

## Decisions

### D1. Module layout

- **`src/shared/planDecisions.ts`.** Types and pure functions: card states, `currentDecision`, `fixStatus`, `overrideCounts` (M2), `fixDurations` (M4), `fixesFieldErrors`.
- **`src/shared/planSupervision.ts`.** Types and pure functions:
  - `changeSupervision(input, now)`: outcome, cause, progress, activity, and stall;
  - `failureSignature`;
  - `blockedDependents`;
  - `planReport`;
  - the cause and stop-reason labels.
- **`src/server/plans/decisions/`:**
  - `decisionSchema.ts`, `decisionStore.ts`;
  - `DecisionService.ts`: ask, record, answer, override, and rights;
  - `fixTasks.ts`: fix and correction tasks, their creation and completion;
  - `decisionReplyGuard.ts`;
  - `decisionTools.ts`, `decisionConnections.ts`.
- **`src/server/plans/supervision/`:**
  - `supervisionSchema.ts`;
  - `supervisionRead.ts`, the snapshot loader that feeds the pure functions;
  - `SupervisionMonitor.ts`;
  - `planAttention.ts`, the attention sources and summary buckets.
- **`src/server/chat/chatTurnUsageStore.ts`.**

Every file stays under 500 lines. The pure functions own every rule, so the server, `plan_get`, and the client agree, and tests need no database.

### D2. Plan content: `leadGroup` and `fixes` (extends C1)

- `PlanContent.leadGroup?: string` and `PlanChange.fixes?: string[]`. `fixes` names the fix and correction tasks (`plan_fix_tasks`, D7 and D8) that the change answers.
- **Normalization.** It keeps `leadGroup` only when it is a non-empty trimmed string. It keeps `fixes` only when it is a non-empty list, with each entry trimmed and kept in order. An entry that is empty after trimming stays, so the structure check refuses it rather than normalization hiding it. Otherwise it omits the key, never writing `null` or `[]`. The canonical serialization of every earlier revision is therefore byte-identical, and its hash is unchanged.
- **`planStructureErrors` gains three checks:**
  - `leadGroup` must be one of `roles[].group`;
  - each `fixes` entry must match `task-<uuid>`;
  - a change must not name an entry twice.

  One fix task may be named by several changes, and its fix then spans them.
- **References are not checked at save.** Whether an id names a fix or correction task of this plan is checked when the plan is read, and a miss becomes a warning on the plan detail (`fixes names no fix or correction task of this plan: <id>`). Checking at save would tie `PlanService`'s pure structure check to the decision store. A wrong reference costs only a warning, because completion considers only real fix and correction tasks.

*Why `fixes` names the task rather than the override:* both an override and a failed promotion end in a `plan_fix_tasks` task. One reference therefore gives both the same phases (D13) and the same completion (D8), and a correction is answered exactly like a fix.

*Alternative rejected:* a separate "fix plan" record. A fix is ordinary plan work, and approval, validation, Start, and the gate already exist for changes. A new record would need all of them again.

### D3. Records

An additive migration in `decisionSchema.ts`, `supervisionSchema.ts`, and `chatTurnUsageStore.ts`:

```sql
CREATE TABLE plan_decision_cards (
  id TEXT PRIMARY KEY,                    -- card-<uuid>
  team_id TEXT NOT NULL, plan_id TEXT NOT NULL,
  revision INTEGER,                       -- the revision the asker works from
  change TEXT, task_id TEXT,
  question TEXT NOT NULL, options_json TEXT NOT NULL, context TEXT,
  asked_by_session TEXT NOT NULL, asked_by_group TEXT, asked_by_profile TEXT,
  addressed_to TEXT NOT NULL,             -- lead | owner
  addressed_group TEXT,                   -- set when addressed_to = 'lead'
  message_id TEXT UNIQUE,                 -- the question mail, when one was sent
  created_at TEXT NOT NULL
);
CREATE INDEX plan_decision_cards_plan ON plan_decision_cards(plan_id, created_at);

CREATE TABLE plan_decisions (
  id TEXT PRIMARY KEY,                    -- decision-<uuid>
  card_id TEXT NOT NULL, plan_id TEXT NOT NULL, team_id TEXT NOT NULL,
  seq INTEGER NOT NULL,                   -- 1 is the first decision; each override adds one
  kind TEXT NOT NULL,                     -- answer | own-call | override
  choice TEXT NOT NULL, option_index INTEGER, rationale TEXT,
  decided_by_kind TEXT NOT NULL,          -- agent | human
  decided_by_session TEXT, decided_by_group TEXT, decided_by_profile TEXT,
  affected_json TEXT NOT NULL,            -- task ids
  command_id TEXT, payload_json TEXT,     -- human commands only
  reply_message_id TEXT,                  -- the answer mail
  created_at TEXT NOT NULL,
  UNIQUE (card_id, seq),
  UNIQUE (plan_id, command_id)
);

CREATE TABLE plan_fix_tasks (
  task_id TEXT PRIMARY KEY, team_id TEXT NOT NULL, plan_id TEXT NOT NULL,
  source_kind TEXT NOT NULL,              -- override | promotion
  source_id TEXT NOT NULL,                -- the override decision id, or the promotion id
  created_at TEXT NOT NULL,
  UNIQUE (source_kind, source_id)
);

CREATE TABLE plan_stall_alerts (
  id TEXT PRIMARY KEY, team_id TEXT NOT NULL, plan_id TEXT NOT NULL,
  execution_id TEXT NOT NULL, change TEXT NOT NULL,
  kind TEXT NOT NULL,                     -- no-progress | repeating-failure
  episode_key TEXT NOT NULL,              -- D11
  detail_json TEXT NOT NULL, message_id TEXT, raised_at TEXT NOT NULL,
  UNIQUE (execution_id, change, kind, episode_key)
);

CREATE TABLE chat_turn_usage (
  session_id TEXT NOT NULL, turn_id TEXT NOT NULL, task_id TEXT NOT NULL,
  group_id TEXT, profile_id TEXT, model TEXT,
  input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL, cache_creation_tokens INTEGER NOT NULL,
  num_turns INTEGER, ok INTEGER NOT NULL, ended_at TEXT NOT NULL,
  PRIMARY KEY (session_id, turn_id)
);
CREATE INDEX chat_turn_usage_task ON chat_turn_usage(task_id);
```

**Card state is derived, never stored:**
- open, with no decision;
- decided, when the current decision is `answer` or `own-call`;
- overridden, when it is `override`.

The current decision is the highest `seq`.

**The database arbitrates the races:**
- `UNIQUE (card_id, seq)` decides between the Lead and the owner, and between two overrides. The losing insert maps to a refusal that names the winner.
- `UNIQUE (plan_id, command_id)` replays human commands. SQLite treats null command ids as distinct, so agent decisions never collide.
- `UNIQUE (source_kind, source_id)` keeps one fix task per override and one correction task per promotion.
- `plan_stall_alerts`' key keeps one alert per episode.

### D4. `decision_ask`

Input: `{ question, options?, context?, plan_id? }`. The limits:
- `question`: 1–2000 characters;
- `options`: at most 8, each 1–300;
- `context`: at most 4000.

**The plan is resolved from the caller's session,** never from a task id the caller supplies, so a caller cannot attach a card to someone else's work:
1. **A task linked to a plan.** The card takes that plan, the task's change, and the revision the task works from: the execution's revision for a Kawai execution task, else the current approved revision. A `plan_id` naming another plan is refused.
2. **A fix or correction task** (`plan_fix_tasks`). The card takes that plan, with no change.
3. **Otherwise,** the caller's group must be the `leadGroup` of `plan_id`'s current approved revision, and the card has no task or change.
4. **Anything else** is refused with `decision_ask needs plan work: a task linked to a plan, a plan's fix or correction task, or the Lead role naming plan_id`. Another team's plan reads as not found.

**Addressing** reads the current approved revision's `leadGroup` when the card is asked:
- **To the Lead.** When there is a lead group and the caller is outside it, the card is addressed to `lead`, with `addressed_group` set. In the same transaction, Kawai enqueues group mail from the caller to that group:
  - normal priority, tagged `decision-question`, with no `task_id`;
  - the body names the card id, the plan, the change, and the task, gives the question, the numbered options, and the context, and ends with the `decision_record` call to make.
- **To the owner.** Otherwise the card is addressed to the owner, and no mail is sent.

The tool returns `{ card_id, addressed_to, addressed_group?, guidance }`. The guidance says the answer arrives as mail in this thread, and that the agent may continue other work or end its turn.

*Why the question mail carries no task:* `lead` is worktree-scoped by default. Task mail for a dev's worktree would wait for a Lead in that worktree, or spawn one there. It would also switch the Lead's session to the dev's task. The card carries the task instead.

*Why a retry may duplicate a card:* an idempotency key would push key handling onto every asking agent. A duplicate costs one extra question, which the Lead answers or decides as an own call.

### D5. `decision_record`

Input: `{ plan_id, card_id?, question?, options?, choice?, option_index?, rationale, affected_tasks? }`.
- **The choice.** It is either `option_index`, which is 1-based and names the option's text, or a new `choice` text of 1–2000 characters.
- **The rationale** is required, 1–4000 characters.
- **Affected tasks.** They default to the card's task when there is one, and each must be a task of the team.

**With `card_id`:**
1. **Rights.** The caller's group must be the card's `addressed_group`. A card addressed to the owner is refused with `addressed to the owner`.
2. **The transaction.**
   - **The card is decided.** If the same session already decided it with the same choice, Kawai returns that decision. Otherwise it refuses, naming the decider.
   - **The card is open.** Kawai inserts `seq = 1` with kind `answer`, and the decider's session, group, and profile. It then enqueues the answer through the mailbox's reply path, with the guard bypassed (D9):
     - from the decider to the asker, in the question's thread;
     - with the card's task passed explicitly as `taskId`, because the question mail has none and a reply otherwise keeps its parent's;
     - tagged `decision-answer`;
     - with the choice and the rationale in the body.

   Because the mail goes through the reply path, a killed asker's answer falls back to its group as any reply does.

**Without `card_id`:** an own call. The caller's group must be the current approved revision's `leadGroup`, and `question` and the choice are required. One transaction inserts a card addressed to `lead`, with the caller as asker and no mail, plus its decision `seq = 1` with kind `own-call`.

*Why first-write-wins rather than letting the Lead revise:* the strategy makes the owner the only one who replaces a decision. A Lead that changes its mind records a new own call, and the card history shows both.

### D6. The owner's answer and override

`DecisionService.answer` and `override` refuse non-human callers first.

**`team-plan-decide { teamPath, planId, cardId, choice?, optionIndex?, rationale?, commandId }`:**
1. **Replay.** A known `(planId, commandId)` returns the prior decision when `cardId`, `choice`, `optionIndex`, and the trimmed `rationale` match. Otherwise it is refused naming the first differing field.
2. The card must be open; else the refusal names the decider.
3. Kawai inserts `seq = 1` with kind `answer` and `decided_by_kind = 'human'`.
4. If the question mail is still `queued` or `awaiting-request`, it is cancelled through `MailboxStore.cancel(id, human, 'answered by the owner')`. Claimed or delivered mail is left alone, and the Lead's later `decision_record` is refused naming the owner.
5. Kawai enqueues direct mail from the human to the asker:
   - in the question's thread when one exists, else new;
   - on the card's task, tagged `decision-answer`.

   The send path is the composer's human-sender path. Like `decision_record`'s answer, it is written by `DecisionService` and so is not subject to the reply guard (D9).

**`team-plan-override { teamPath, planId, cardId, expectedDecisionId, choice?, optionIndex?, rationale, commandId }`.** One transaction:
1. **Replay** by command id, comparing `cardId`, `expectedDecisionId`, `choice`, `optionIndex`, and `rationale`.
2. **Checks.**
   - The card must be decided; an open card is refused with `answer it instead`.
   - The current decision must be `expectedDecisionId`; otherwise the stale override is refused naming the current one.
   - An empty rationale is refused.
3. **The plan.**
   - A `cancelled` plan is refused with `reopen the plan first`.
   - A `completed` plan is reopened through `PlanService.reopen(human, planId, { commandId: 'override:<commandId>:reopen' }, within)`. `PlanService` stays the only writer of `plan_events` (C3): this adds only the `within` variant of its existing reopen, whose compared payload is still the command name alone. The override's decision row records why the plan reopened.
4. **The decision.** Kawai inserts `seq + 1` with kind `override`, decided by the human.
5. **An earlier fix.** An open fix task of an earlier override of this card is cancelled as Kawai, its creator, with a journal note naming the newer override.
6. **The new fix.** Kawai creates and dispatches the new fix task (D7).

The override sends no mail to the original asker. The fix task tells the Lead role, and the card shows the history.

*Why compare-and-swap on the decision id:* the owner overrides the decision they read. A concurrent override must not silently replace a decision the owner never saw.

### D7. Fix tasks and the system caller's origins

**The caller.** plan-execution's system `TaskCaller { kind: 'system'; team; executionId }` becomes `{ kind: 'system'; team; origin }`, where `origin` is one of:
- `{ kind: 'execution'; executionId }`;
- `{ kind: 'override'; decisionId }`;
- `{ kind: 'promotion'; promotionId }`.

Only `ExecutionService` constructs the first. Only `fixTasks.ts` constructs the other two, through functions the module does not export. A test asserts that no tool or connection path yields a system caller.

**This modifies plan-execution D2.** D2 fixes the system caller as `{ kind: 'system'; team; executionId }`, built only by `ExecutionService`, and lets it create tasks only with an execution link. This change:
- widens the shape to `origin`;
- scopes the rights per origin, keeping D2's rights for the execution origin unchanged;
- extends every exhaustive switch D2 introduced over `origin`.

plan-execution archives first, so its design stays the record of D2 as written, and this decision records the modification. The `team-tasks` delta records the same widening of who creates tasks as Kawai.

**Rights of the decision origins.** Through them Kawai may only:
- create a task with no plan link, inserting the `plan_fix_tasks` row in the same transaction;
- dispatch it;
- set `done` or `cancelled` on it as its creator.

Execution rights such as handoffs, acceptance, and release stay with the execution origin. Member release needs no right here: its close hook releases a task's spawned members on `done` or `cancelled`, whoever closes the task. Every human-only path keeps refusing the system caller.

**The fix task:**
- **Title:** `Forward fix: <question, cut to 80 characters> — <plan title>`.
- **Direction** names:
  - the card;
  - the superseded decision (choice, rationale, decider) and the override (choice, rationale);
  - the affected tasks with their changes, the commits of their results, and their landing facts' merge commits since the superseded decision.

  It then gives the instruction: write an OpenSpec change, and land its proposal on the base branch, as `changes-on-base` requires. Add it to the plan's next revision with `fixes: ["<this task's id>"]` and `dependsOn` the affected changes still in the revision, then call `plan_submit_for_review`. The owner approves and starts it, and Kawai gates and lands it like any change. If no change is needed, submit a result explaining why, and the owner accepts it.
- **Acceptance:** "A change naming this task in `fixes` has landed and no change of the current approved revision naming it is unlanded, and Kawai then closes this task; or the owner accepted a no-change result."
- **No worktree and no OpenSpec change.** The change does not exist yet. There is no parent task.

**Dispatch.** `AssignmentService.dispatch(system, …)` sends it to `leadGroup` with the Lead role's `allowedProfiles`, the tag `plan-fix`, and the request key `fix:<decisionId>`. With no Lead role, nothing is dispatched, and the attention queue asks the owner to assign the task (D13).

*Why the fix task has no plan link:* durable-plans D9 links a task to a change of the approved revision, and the fix's change does not exist yet. `plan_fix_tasks` ties the task to the plan, which is what usage (D14) and attention (D13) read.

### D8. Completing fixes, and correction tasks for failed promotions (I2)

The monitor (D11) runs these on each sweep, each in its own idempotent transaction.

**Completion, for fix and correction tasks alike.** For each open task in `plan_fix_tasks`:
1. **Landed:** the changes with a landing fact (X7) whose definition, in the revision of the execution that landed them (`plan_change_landings.execution_id`), names the task in `fixes`.
2. **Outstanding:** the changes of the current approved revision that name the task and have no landing fact.
3. When at least one change has landed and none is outstanding, Kawai sets the task `done` as its creator. The journal note names each landed change with its merge commit.

Each landed change is judged by the revision it landed under, so a later revision that drops or renames a landed fix change cannot strand the task. A revision that adds another naming change keeps the task open until that change lands too. The current approved revision decides only what is still outstanding.

**A no-change result.** The owner's **Accept result** closes the task as `done` through the shipped acceptance path. The human may set any status on any task, Kawai's included, so this needs no new right. Kawai writes nothing for it, the monitor only reads the closed task, and `fixStatus` reads no change. A superseded fix was already cancelled (D6).

**Correction creation.**
1. Find promotions of the team's plans that have no `plan_fix_tasks` row and whose stored outcome is `failed:<reason>`, with the reason `promotion-conflict` or `ci-failed`. That is integration-candidates' stored form; the specs name the bare reasons.
2. Create a correction task for each, with the origin `promotion`:
   - **title:** `Correct failed promotion: <reason> — <plan title>`;
   - **direction:** the promotion, its pull request (already closed by Kawai), its failure detail (the conflicting files, or the failing checks with links), and the instruction. The instruction is to resolve the cause on the integration line through the plan: add or amend a change with `fixes: ["<this task's id>"]` in a new revision, as for a fix, so the owner can promote again. If nothing needs changing, as with a flaky check, submit a result saying so.
3. Dispatch it as fix tasks are dispatched, with the request key `correct:<promotionId>`.

The other failures (`ci-missing`, `ci-timeout`, `target-moved`, `effect-failed`) create no task. They become an owner item, **Promote again** (D13). A cancelled promotion creates nothing.

**Correction completion.** A correction closes by the completion rule above, or by an accepted no-change result. In addition, a later promotion of the same plan that finished `merged` closes it, with a journal note naming that promotion. Once the correction closes, the owner's **Promote again** item returns unless a later promotion has already started (D13).

*Why the monitor rather than the promotion's finish transaction:* promotions belong to `integration-candidates`, which must not depend on decisions. The finished promotion row is the I2 contract, and the unique source makes the reaction exactly-once across restarts. An override is this change's own command, so its fix is created in its own transaction.

### D9. The reply guard

`decisionReplyGuard.check(parentId)` runs in the `reply` tool and in the human composer's reply path, beside plan-execution's Kawai guard. It refuses when the parent is tagged `decision-question` and its card (`plan_decision_cards.message_id = parentId`) has no decision:
- **Agents** are told: `This is the question of decision card <id>. Decide it with decision_record({ plan_id, card_id, … }) so the decision is recorded.`
- **The human** is told to use the card's **Answer** in the Plans view.

Nothing is queued. Once the card is decided, replies pass, so the asker and the Lead can discuss the answer.

`DecisionService` writes the answers of D5 and D6 through the mailbox's reply path with the guard bypassed. Without the plans module, a null guard passes everything.

The guard covers replies only. An agent can still `send_message` its answer to the asker, and that bypasses the record. The plan note steers against it, and the card stays open in the attention queue until it is decided.

### D10. Supervision derivation

`changeSupervision(input, now)` is pure. Its input per change:
- the change row and its rounds, attempts, and effects;
- the outstanding assignment, with the state of its instruction mail and the claimant;
- the claimant's facts: status, pending request, running background tasks and workers, due direct mail, park state, and profile cooldown;
- the mailbox waiting reason of the instruction mail;
- the landing-slot holder;
- the outcomes of its dependencies;
- open cards asked from its task;
- its carried acceptance conditions (V2) and their decisions;
- its candidates (I1);
- the holder's last turn end and last task mail.

`supervisionRead.ts` loads these from the stores. The waiting reason and session facts are runtime facts, already exposed by the mailbox and session modules.

**The outcome**, first match wins:
1. **landed:** there is a landing fact. It is shown with `tree_verified` and the base-branch CI.
2. **cancelled.**
3. **stopped:** with the reason and detail.
4. **waiting** before provisioning: on a dependency (or a stopped one), or on the parallel limit.
5. **stalled as `repeating-failure`** (D11). This is a fact about decided rounds, not about the holder, so it is checked before the waits. A change in a fix round's CI wait therefore reads stalled, with the wait listed as also applying.
6. **running stages:** the first applicable named wait, in this order:
   1. a Kawai effect that is pending, running, or unknown (`effect`, naming its kind, try, and next time);
   2. `uncertain-delivery`;
   3. staffing (`staffing`, with the mailbox reason's blocker);
   4. `parked` or a cooling profile (with the reset);
   5. a pending approval or question (`request`);
   6. `decision-card`;
   7. CI pending (`ci`);
   8. `member-release`;
   9. `condition`;
   10. `landing-slot` (naming a change or a promotion).

   The other applicable waits are listed as also applying, as `team-waiting-reasons` does. With no wait, an agent-held stage is checked for a `no-progress` stall (D11) and reads stalled or running. A step Kawai holds between ticks reads running.

**Progress and activity.** `lastProgress` is the newest of:
- a result row for the change's task (rows exist only once the submission check accepted them);
- a CI pass;
- a verdict;
- a passed round;
- a landing;
- a passed candidate.

`lastActivity` is the newest of the holder's turn end, its live turn, and its task mail. Turns, tokens, and tasks.md boxes never feed progress.

**Causes are append-only, like X8.** `revision-control` adds a `hold` cause. An unknown cause renders its label verbatim.

### D11. Stalls, alerts, and the monitor

**`no-progress`** applies only to an agent-held stage with no named wait: an implement, fix, or update attempt whose instruction was delivered, or a review handoff awaiting its verdict.
- **Deadline.** 2 hours for an attempt and 1 hour for a review, counted from the latest of:
  - the instruction's delivery;
  - `lastProgress`;
  - `waitEndedAt`, the last time the monitor saw this change in a named wait.
- **Idle holder.** The deadline becomes 15 minutes, counted from the later of that anchor and the holder's last turn end, when the holder is idle. Idle means no turn running, no pending request, no running background task or worker, and no due direct mail. An archived or killed holder counts as idle.
- **The wait observation.** `waitEndedAt` lives in memory. At startup it is set to the startup time for every running change, so a restart can delay a stall by up to one deadline but never raise one early, or for a wait the server did not see.

**`repeating-failure`.** The two newest decided rounds of the change are consecutive failures with an equal `failureSignature`, and the change is not stopped. It applies whatever the change waits on (D10).
- The signature is the sorted names of the failing CI checks, flaky ones excluded, followed by `review:fail` when the round's review failed. A round that failed only its review has the signature `review:fail`.
- A carried round counts as its source does.
- Superseded rounds are skipped.

**Episodes and dedupe.** The episode key is durable:
- for `no-progress`, the ISO time of the latest of the delivery and `lastProgress`;
- for `repeating-failure`, the second round's id.

The in-memory wait time moves the deadline but never the key. A restart during a stall therefore finds the row and sends nothing, while new progress or a new delivery starts a new episode.

**Raising an alert.** One transaction inserts the `plan_stall_alerts` row and enqueues Kawai's mail:
- `from_kind: 'system'`, to the plan's `leadGroup`, with the Lead role's `allowed_profiles` and no task;
- tags `plan-stall` and `stall:<kind>`;
- the body names the plan, change, stage, holder (session, group, and profile), the last progress and activity, rounds with their outcomes and failing checks, and open cards;
- it suggests messaging the holder, recording a decision, or asking the owner with `decision_ask`, and it says Retry and Stop are the owner's.

With no Lead role, the row is written with a null `message_id` and no mail. Replies to the alert hit Kawai's reply guard.

**`SupervisionMonitor`** runs one per team.
- **Triggers.** A sweep runs:
  - at startup;
  - on plan, execution, landing, promotion, task, and mailbox notifications for the team;
  - on a 60-second timer, while the team has a running execution, a running promotion, or an open fix or correction task.
- **The sweep:**
  1. derives supervision for the newest execution of each plan;
  2. raises new stall alerts;
  3. creates and completes fix and correction tasks (D8);
  4. pushes `team-plan-detail` when a plan's derived view changed.
- **Failures.** A sweep is single-flight per team. An error is logged, and the next trigger retries.

*Why not the executor's tick:* supervision reads session and mailbox facts the executor does not need. It must never delay or change an execution transition, so a separate loop that only reads, alerts, and manages tasks keeps the executor's state machine unchanged.

### D12. The report

`planReport(supervision, content, decisions, candidates, impactDisposition)` is pure:
- **Stopped changes.** Each shows its reason label, mapped from the X8 list (`round-limit` reads "Failed 3 fix rounds", and an unknown reason reads verbatim), its detail, and the last round's evidence: failing checks with links, the flaky marks, and the findings summary. It also lists the blocked dependents, the transitive closure of unlanded changes over `dependsOn`, and the next action **Retry or stop execution**.
- **Partial delivery.** "Landed N of M", with the blocking changes. It never says the success criteria are met. When every change has landed, it reads "All M changes landed", and the success criteria stay listed for the owner to judge.
- **I1.** Failed and superseded candidates beside their change, with their checks and outside commits. A failed candidate is a failed round, so it raises no separate item.
- **C-I3.** The plan's effective disposition in the current strategy impact review, shown when it is not `continue`, with a link to the review.
- **M2.** "k of n Lead decisions overridden". *n* counts decisions of kind `answer` or `own-call` made by an agent of the card's addressed group, and *k* counts those a later override superseded.
- **M4.** For each override whose fix landed: the time from the override to the newest landing among the changes that landed naming its fix task (D8), flagged when any of those landings has `tree_verified = 0`.

M1, M3, M5, and M6 are not computed.

### D13. Attention sources and summary buckets

**The types.**
- `AttentionKind` gains `plan-stop`, `plan-stall`, `decision-question`, `plan-fix`, `plan-condition`, and `plan-promotion`. team-workspace D5's reserved comment (`'plan-hold' | 'stall' | 'lead-decision'`) is replaced by these six names when they land. The comment was a placeholder, never the contract.
- `AttentionLink.kind` gains `plan`, with an optional `planId` and `change` on every link. A `card` link is a decision card, as team-workspace D5 reserved it, and carries `planId`.

**The sources.** `planAttention.ts` registers one source per kind in `ATTENTION_SOURCES`, each pure over the supervision read:

| Kind | Item id | Owner | Next action | Clears when |
| --- | --- | --- | --- | --- |
| `plan-stop` | `plan-stop:<execution>:<change>:<generation>` | human | Retry or stop execution | Retry, Stop, or a landing |
| `plan-stall` | `plan-stall:<execution>:<change>:<episode>` | Lead group, else human | Unblock the holder | the stall ends |
| `decision-question` | `decision-question:<cardId>` | addressed group, else human | Answer the question | the card is decided |
| `plan-fix` | `plan-fix:<taskId>` | Lead group while planning; human when unassigned, awaiting approval, or approved and not running | Plan the fix / Assign / Approve revision N / Start execution | the task closes |
| `plan-condition` | `plan-condition:<execution>:<change>:<target>` | human | Resolve condition | the condition is resolved |
| `plan-promotion` | `plan-promotion:<promotionId>` | human | Promote again | a later promotion starts, or a correction task for it is open |

**The promotion item** is raised for a plan's newest failed promotion while no later promotion has started and no correction task for it is open. It therefore returns when a correction closes (D8), and it never sits beside an open correction.

**Fix-task phases.** A `plan-fix` item, for a fix or a correction task alike, reads its phase from `fixStatus`:
- planning: no submitted revision names the task;
- in review: a revision in review names it;
- approved: an approved revision names it and no execution of it runs;
- running.

Corrections share these phases because a correction's changes name it in `fixes` exactly as a fix's do (D2).

**The summary.** `MorningSummary` gains five durable buckets, read over team-workspace's summary window, the last 24 hours (its D8):
- `landings`: landing facts by `landed_at`;
- `stops`: change rows stopped, by `updated_at`;
- `stallAlerts`: alert rows by `raised_at`;
- `decisions`: rows of kind `answer` or `own-call`;
- `overrides`: rows of kind `override`.

None is `runtimeOnly`.

### D14. Usage per turn

- **The driver.** `turn_completed` gains an optional `usage: { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens }`, mapped from the result frame's per-turn `usage`. Missing fields read 0. The event stays additive, and replayed history without it is unchanged.
- **The source is pinned when the turn starts.** `ChatSessionManager` keeps, per session, the mail delivered while no turn ran. It reads this from the session mailbox's delivered hook, the same one `LimitOutcomes` uses. `turn_started` moves that mail onto the turn. A delivery during a running turn neither retargets that turn nor carries over to the next one.
- **The task a turn belongs to.** At `turn_completed`, two exclusive branches decide it:
  - a mail-started turn takes that mail's task. It writes nothing when the mail has none, even on a task-bound session;
  - any other turn takes the session's task (`records.get(sessionId)?.taskId`).

  A turn with no task writes nothing. The Lead's turns on task-less questions and alerts are therefore not attributed, and the view says so.

  *Why pin at turn start:* the delivered hook is last-write-wins per session. Reading it at `turn_completed` would hand the whole turn to an urgent or mid-turn delivery.
- **The record.** One row per turn, keyed by `(session_id, turn_id)`, so a duplicate event writes once. It holds the group, `claudeProfileId`, `model`, the four token counts, `num_turns`, and `ok`, beside the existing `turnEnds.record`.
- **The plan read.** It covers every task with `team_tasks.plan_id = P`, execution tasks included, plus P's `plan_fix_tasks`. Usage sums by `(group_id, profile_id)` and by change, where fix and correction tasks form their own rows. Turns are row counts, and steps are the sum of `num_turns`.
- **Coverage.** The result's `usage` covers the main agent loop only, so Task subagent and auxiliary calls are missing and plan usage understates subagent-heavy work. The view's note says so, beside the not-attributed note. Deriving per-turn deltas from the cumulative `modelUsage` would include them, but it inherits that field's resume and `/clear` lifecycle. It is an open question.
- **No currency.** `total_cost_usd` is cumulative per `query()` call rather than per turn, and for gateway profiles it applies list prices that do not apply. Showing it would mislead, and the strategy forbids a budget.
- **No pruning or backfill.** Usage starts when this ships.

### D15. Human protocol and the view

- **Messages.** `team-plan-decide` and `team-plan-override`, answered by `team-plan-result` with `decision`. Both are listed in `CHAT_CONNECTION_TYPES`.
- **The detail.** `team-plan-detail` gains:
  - `decisions: PlanDecisionCardView[]`, with decision history, fix status, and derived commits;
  - `supervision: PlanSupervisionView`, with each change's outcome, causes, progress, activity, stall, and the report;
  - `usage: PlanUsageView`.

  It is pushed after every decision, fix, or alert write, and after every monitor sweep that changed the derived view. The client ticks the elapsed times.
- **The store.** `teamPlanStore` keeps one command id per open Answer or Override dialog, minted at open and re-minted only when the compared payload changes. Every apply method has a dispatch caller.
- **Components:**
  - `PlanDecisionCard.tsx`: inline in the execution's change rows, and in a plan-level Decisions list for cards with no change;
  - `PlanDecisionDialog.tsx`: Answer, or Override showing the decision it replaces. The override requires a rationale;
  - `PlanReportSection.tsx`;
  - `PlanUsageSection.tsx`: a group × profile table, the per-change rows, and a note on what is not counted: task-less turns and Task subagent calls.

  Every control disables while disconnected, and refusals show inline.
- **Links.** `plan` and `card` attention links navigate to the Plans tab's plan detail (`#/team/<key>/plans/<planId>`), scrolled to the change or card.

### D16. Agent surface

- **Tools.** `decision_ask` and `decision_record` join the `kawai-team` server, allowed without cards. Rights are checked at each call (D4, D5).
- **`plan_get`** gains `decisions`, `supervision`, and `usage`.
- **The plan note** (`teamPrompt.ts`):
  - on plan work, ask decisions with `decision_ask`, not a question to the human;
  - in the plan's Lead role, decide with `decision_record`, giving a choice and a rationale, and record your own calls the same way;
  - replies to an open question are refused;
  - stall alerts come from Kawai, so act on them rather than replying;
  - only the owner answers for the owner, overrides, retries, or stops.
- **No agent tool** answers as the owner, overrides, retries, stops, or dismisses, and none may be added. `DecisionService` refuses agent callers on those paths.

### D17. Contracts consumed and published

Consumed:
- **plan-execution D2:** the system `TaskCaller`, modified by D7 (its `origin` and per-origin rights).
- **C1:** `PlanContent`, extended additively (D2).
- **C3:** `PlanService.reopen` gains its `within` variant.
- **C5:** fix tasks carry no link.
- **C6:** no new kinds; the reopen is the existing `reopened` kind.
- **C7:** the floor names in round evidence.
- **X1:** states, steps, and `executionProgress`.
- **X3:** effects as named waits.
- **X4:** CI with flaky marks, and verdicts in the evidence.
- **X7:** landing facts.
- **X8:** stop reasons mapped to labels, append-only.
- **V2:** carried conditions.
- **C-I3:** dispositions.
- **I1:** the candidate chain.
- **I2:** promotion outcomes.
- **team-workspace:** D5 sources and the `card` link, and D8 buckets.
- **team-waiting-reasons:** the staffing cause.
- **Others:** task results and findings, and `chat_turn_ends`.

Published:

| Contract | What it fixes | Bound by |
| --- | --- | --- |
| S1 Decision records | D3 cards and decisions; `currentDecision`; card states | `revision-control` (publishing direction from a decision), `execution-safety-recovery` (audit) |
| S2 Outcomes and causes | D10 `changeSupervision` and its append-only cause list | `revision-control` (`hold` as a cause), `execution-safety-recovery` (recovery states) |
| S3 Usage records | D14 `chat_turn_usage` and its attribution rule, pinned at turn start | a later team usage view, `execution-safety-recovery` (budgets, if ever) |
| S4 Forward fixes | D2 `fixes` naming fix and correction tasks, D7 `plan_fix_tasks`, D8 completion by landed revision, `fixStatus` | `revision-control` (a fix published into running work) |

## Risks / Trade-offs

- **[Agents bypass the record with `send_message` or AskUserQuestion]** → The prompt steers plan work to cards, the reply guard catches the natural path, and an undecided card stays in the attention queue. Intercepting AskUserQuestion is a non-goal; a spawned dev's question already flags `needs attention`.
- **[Stall deadlines are fixed]** → An alert changes no state. A false alarm costs one message, and its dedupe keeps it to one per episode. Configurable deadlines are an open question.
- **[A restart delays stall detection]** → This is conservative by design (D11), and it never alerts early.
- **[Usage attribution is approximate]** → A mail-started turn takes that mail's task, pinned at turn start, and nothing when the mail has none. Any other turn takes the session's task. Human-typed turns on a bound session count toward its task. Task-less Lead turns are unattributed, and Task subagent calls are missing from the result's usage. The view says both.
- **[Gateway profiles may report zero or approximate tokens]** → Usage is shown as reported, labeled by profile, never priced.
- **[The fix path is long: proposal, landing on base, revision, approval, Start]** → This is deliberate: the strategy requires fixes to pass the same checks. The fix status names the current phase and who owns it.
- **[Overrides while the affected change is still running]** → The running execution keeps its revision, as plan-execution requires, so the change may land with the superseded decision and the fix lands after it. Publishing into running work is `revision-control`'s.
- **[`plan-execution` must archive first]** → The `team-tasks` delta modifies a requirement that exists only in that change, so validation reports an informational note until it is archived.

## Migration Plan

- An additive migration creates the five tables; nothing is backfilled.
- `turn_completed.usage` and the new `team-plan-detail` fields are optional, so older clients ignore them.
- Rollback: the previous build ignores the tables. Fix and correction tasks remain ordinary tasks, created by Kawai.

## Open Questions

- Retention of `chat_turn_usage`. There is no pruning now.
- Whether per-turn deltas of the cumulative `modelUsage` should replace `usage`, so that Task subagent calls are counted (D14).
- Whether stall deadlines become per-team settings in `~/.kawai/teams.json`.
- Whether plan validation should warn about a plan with a Lead-addressed workflow but no `leadGroup`.
