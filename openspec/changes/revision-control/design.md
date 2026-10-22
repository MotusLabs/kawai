# Design

## Context

Several shipped or designed pieces are in place:
- **`durable-plans`:** owner-approved, immutable plan revisions; `PlanService` is the only plan writer, replaying commands by `(plan_id, command_id)` (C1–C7).
- **`plan-validation`:** gives a revision standing against exact inputs (V1).
- **`plan-execution`:** runs one revision as Kawai-owned tasks, attempts with immutable manifests, rounds, effects, a landing slot, and landing facts (X1–X8). A new task revision supersedes the round before merge and dispatches a fix attempt naming it (its D9).
- **`integration-candidates`:** adds integration branches and human promotions that hold the same slot (I1, I2).
- **`plan-supervision`:** adds decision cards, overrides, forward fixes, causes, and attention items (S1–S4).
- **`task-revision-publication` (shipped):** publishes task revisions with notices to the outstanding claimant in one transaction.
- **`team-member-release` (shipped):** defines when a member is ready (idle, no pending request, no worker or background task, no claimed or parked mail, no due direct mail).

What is missing is the owner's way to change course without throwing work away. Three levers are needed: hold the affected work, pause it with a checkpoint the owner can trust, and apply a newer approved revision to the run in place. The multi-agent design's "Publication, holds, and checkpoint protocol" and tests R01, R10, R11, R17, and R18 fix the guarantees.

### Name reconciliation (task 1.1, against master 9c5af1e8, 2026-10-20)

Read against the merged designs and code. No rename touches another change's spec or a shipped contract; the names above stand, with these anchors:

- **plan-execution** (archived `2026-10-18-plan-execution`; `src/server/plans/execution/`): `planSteps(snapshot, now)` is `executionPlanner.ts` and returns `{ transitions, effects, dispatches, stages, fixes }`. The decide/dispatch split D5 needs lands there: a failed round's outcome is a guarded transition (the decision, recorded under a hold), while the fix attempt is the `fixes` entry / a later dispatch, still owed in stored state until the gate opens. `START_PRECONDITIONS` (`startPreconditions.ts`, append-only) gains `no-hold`; `plan_landing_slots` is migration 8's table; the effect kinds are the `EffectKind` union in `src/shared/planExecution.ts` and their inspectors live in `effectInspectors.ts` — `push-checkpoint` (D7) is a new change-level kind added to that union, with its own `ls-remote` inspector; `AttemptManifest` (same file, `version: 1`) already carries an optional field (`answers?`), so the optional `checkpoint: { id, commit }` follows that precedent with no version bump; `recordExecutionEvent` is `PlanService.recordExecutionEvent`, the model `recordRevisionControlEvent` follows (`runPlanCommand` + `store.insertEvent`, compared payloads in `CommandPayload.command`'s union, which gains the six command names); `TaskService.setStatus(caller, taskId, status, note?, alsoWithin?)` is as named; D11's removed-change cancel does not go through it — it follows Stop (`ExecutionService.ts` `stopAs`, `executor.ts`): `TaskService.prepareStatus` first, then `commit` inside Apply's synchronous transaction, never the async `setStatus(…, alsoWithin)` (D11).
- **integration-candidates** (archived `2026-10-20-integration-candidates`): the candidate fast-forward is the non-forced `fast-forward` effect kind (`integrationMechanism.ts`); `PROMOTE_PRECONDITIONS` (`promotionPreconditions.ts`, append-only) gains `no-hold`; the promotion steps are D10's pure `planPromotionStep(input)` (`src/server/plans/landing/integration/promotionPlanner.ts`) — the `held` wait this design adds is a new step the runner reaches before its merge, and release re-runs its up-to-date step, which is step 4 there.
- **plan-supervision** (`openspec/changes/plan-supervision/`): the running-stage named waits are `SupervisionWait` in `src/shared/planSupervision.ts` — today effect, uncertain-delivery, staffing, parked, request, decision-card, ci, member-release, condition, landing-slot; `paused`, `pausing`, `hold` join after `effect` in that order, before `uncertain-delivery` (D13), under S2's append-only rule, with `repeating-failure` still ahead of them. `fixStatus` is `src/shared/planDecisions.ts`. The system caller's origins are `execution | override | promotion` (`src/server/team/systemCaller.ts`); this change adds none — Kawai's writes here use the `execution` origin. The attention sources live in `ATTENTION_SOURCES` in `src/server/team/workspaceRead.ts`; the proposal's Impact names a `planAttention.ts` that does not exist — the three sources of D13 are added at the shipped location (a `planAttention.ts` module is created only if the 500-line bound demands the split). Items link with the `plan` link plan-supervision D13 shipped.
- **Shipped:** `TaskService`'s publication path takes a `requestKey` and writes its notices through a `within` hook (`src/server/team/TaskService.ts`); the proposal's "`within` variant" — a whole publication inside a caller's transaction, for Adapt and Apply — does not exist yet and is added by this change's groups 4–5, modeled on `PlanService.reopenWithin`. `MemberRelease.readiness(sessionId)` and `releaseNow` are as named, with the durable `team_member_releases` pending row for Restart; its single readiness `reason` (`{ ready: true } | { ready: false; reason: string }`) reaches `PauseTargetFacts.readiness`'s `reasons: string[]` through a one-entry adapter.

## Goals / Non-Goals

**Goals:**
- Owner-only holds on a plan or named changes that stop new work and every landing path, without interrupting turns or discarding results.
- Pause with a durable, pushed checkpoint. It is never reported as Paused before the commit is on `origin` and the holder is ready.
- Continue, Adapt, Restart, or Cancel per paused change.
- Apply a newer approved revision to a running execution, with a recorded per-change classification and atomic publication.
- Every new record and state readable by agents through `plan_get`, and visible as supervision causes and attention items.

**Non-Goals:**
- **Owned by `execution-safety-recovery`:** the outbound-action audit log, the crash and fault matrix, leases, epochs and fencing, backups, and budgets. This change publishes R1–R5 for it.
- **Contract work:** typed relations, contract registries, and archive automation.
- **Agent-side controls:** no agent places, releases, or extends a hold, pauses, resolves a pause, or applies a revision.
- **Voluntary checkpoints** outside a requested pause belong to `execution-safety-recovery`.
- **Holds and pauses outside plans**, and forced termination of holders.

## Decisions

### D1. Module layout and actors

`src/server/plans/revisionControl/` holds:
- `holdStore.ts`, `pauseStore.ts`, `checkpointStore.ts`, and `executionRevisionStore.ts`: the only SQL writers of the D2 tables;
- `holdService.ts`, `pauseService.ts`, and `applyService.ts`: the human commands, all refusing non-human callers first;
- the pure `holdGate.ts` (D5), `pauseState.ts` (D8), `revisionDelta.ts` (D10), and `applyPreconditions.ts` (D11);
- `checkpointTool.ts` (D7);
- `revisionControlConnections.ts` (D14).

`src/shared/planRevisionControl.ts` holds the types and view shapes.

**Actors.**
- Every command here is the human's (`{ kind: 'human' }`), the plan's owner.
- Kawai's writes that follow from them use plan-execution's system caller with the execution origin (D2 and plan-supervision D7): cancelling removed changes' tasks, dispatching attempts, and pushing checkpoints.
- Task revisions that Adapt publishes are the human's, because the owner authored them. They go through `TaskService`'s publication path with the human actor and a `within` transaction (D9, D11). The system caller never publishes a task revision, and plan-execution D2's human-only rule is unchanged.

### D2. Records

An additive migration in `revisionControlSchema.ts`:

```sql
CREATE TABLE plan_holds (
  id TEXT PRIMARY KEY,                 -- hold-<uuid>
  team_id TEXT NOT NULL, plan_id TEXT NOT NULL,
  scope TEXT NOT NULL,                 -- plan | changes
  rationale TEXT NOT NULL,
  deadline TEXT NOT NULL,              -- review deadline; extended in place, history in plan_events
  cites_kind TEXT, cites_id TEXT,      -- impact-review | decision-card
  created_at TEXT NOT NULL, command_id TEXT NOT NULL,
  released_at TEXT, release_reason TEXT, release_command_id TEXT,
  UNIQUE (plan_id, command_id)
);
CREATE INDEX plan_holds_active ON plan_holds(plan_id) WHERE released_at IS NULL;

CREATE TABLE plan_hold_changes (       -- scope = changes only
  hold_id TEXT NOT NULL, change TEXT NOT NULL,
  released_at TEXT, release_command_id TEXT,
  PRIMARY KEY (hold_id, change)
);

CREATE TABLE plan_pauses (
  id TEXT PRIMARY KEY,                 -- pause-<uuid>
  team_id TEXT NOT NULL, plan_id TEXT NOT NULL, execution_id TEXT NOT NULL, hold_id TEXT NOT NULL,
  deadline TEXT NOT NULL, note TEXT,
  created_at TEXT NOT NULL, command_id TEXT NOT NULL, closed_at TEXT,
  UNIQUE (plan_id, command_id)
);

CREATE TABLE plan_pause_targets (
  pause_id TEXT NOT NULL, change TEXT NOT NULL,
  stage TEXT NOT NULL,                 -- attempt | review
  attempt_id TEXT, assignment_id TEXT NOT NULL,
  holder_session TEXT,                 -- the claimant at request time; null when withdrawn
  message_id TEXT,                     -- the pause mail
  withdrawn INTEGER NOT NULL DEFAULT 0,  -- the instruction was unclaimed and Kawai superseded it
  paused_at TEXT, checkpoint_id TEXT,  -- recorded Paused, never derived
  decision TEXT,                       -- continue | adapt | restart | cancelled
  decision_detail_json TEXT, decided_at TEXT, decision_command_id TEXT,
  PRIMARY KEY (pause_id, change)
);

CREATE TABLE plan_checkpoints (
  id TEXT PRIMARY KEY,                 -- checkpoint-<uuid>
  execution_id TEXT NOT NULL, change TEXT NOT NULL, pause_id TEXT NOT NULL,
  attempt_id TEXT, session_id TEXT NOT NULL,
  kind TEXT NOT NULL,                  -- commit | result | notes
  commit_sha TEXT, baseline_commit TEXT, manifest_hash TEXT, result_id TEXT,
  summary TEXT NOT NULL, unfinished TEXT, errors_tests TEXT, next_steps TEXT NOT NULL,
  effect_id TEXT,                      -- the effect of kind push-checkpoint; set only for checkpoint kind commit
  superseded_by TEXT, created_at TEXT NOT NULL
);

CREATE TABLE plan_execution_revisions (
  execution_id TEXT NOT NULL, seq INTEGER NOT NULL,   -- 1 is the revision Start recorded
  revision INTEGER NOT NULL, content_hash TEXT NOT NULL,
  report_id TEXT NOT NULL, input_hash TEXT NOT NULL,
  rationale TEXT, command_id TEXT, payload_json TEXT, -- null for seq 1
  applied_at TEXT NOT NULL,
  PRIMARY KEY (execution_id, seq)
);

CREATE TABLE plan_execution_publication_changes (
  execution_id TEXT NOT NULL, seq INTEGER NOT NULL, change TEXT NOT NULL,
  class TEXT NOT NULL,                 -- unchanged | changed | added | removed
  choice TEXT,                         -- continue | adapt | restart | none (changed, no task yet)
  fields_json TEXT,                    -- the changed C1 fields
  task_id TEXT, task_revision INTEGER, -- the revision Adapt published
  PRIMARY KEY (execution_id, seq, change)
);
```

**What is stored and what is derived:**
- `plan_executions.revision`, `content_hash`, `report_id`, and `input_hash` always equal the newest `plan_execution_revisions` row. Apply updates both in one transaction.
- Hold activity is stored: a release has a row.
- Paused is stored (`paused_at`).
- Pausing, its causes, and the overdue items are derived (D8, D13).

**The database arbitrates the races:**
- `UNIQUE (plan_id, command_id)` on holds and pauses, and on `plan_events`, replays commands;
- the execution revision primary key makes two concurrent Applies on the same base collide, and the loser maps to `execution-revision-unchanged`;
- guarded `UPDATE … WHERE paused_at IS NULL` and `WHERE decision IS NULL` record Paused and decisions once.

The backfill inserts `seq = 1` for every execution from its row. Start inserts seq 1 in its transaction; the migration's backfill covers executions started before migration 17.

### D3. Commands, replay, and plan events

`PlanService` stays the only writer of `plan_events` (C3). It gains `recordRevisionControlEvent(planId, event, within)` with the new kinds (C6, append-only):

| Kind | Compared payload |
| --- | --- |
| `hold-placed` | `scope`, sorted `changes`, trimmed `rationale`, `deadline`, `cites` |
| `hold-released` | `holdId`, sorted `changes`, sorted `retain`, trimmed `reason` |
| `hold-extended` | `holdId`, `deadline`, trimmed `reason` |
| `pause-requested` | `holdId`, `deadline`, trimmed `note` |
| `pause-resolved` | `pauseId`, `change`, `choice`, `adapt` text, trimmed `rationale`, `releaseHold` |
| `revision-applied` | `executionId`, `expectedRevision`, `revision`, `contentHash`, `choices`, `adaptations`, trimmed `rationale` |

Every command follows one shape, as plan-execution's Start does:
1. **Reads,** writing nothing.
2. **One transaction:**
   - replay (the same payload returns the prior result; a different one is refused naming the first differing field);
   - named checks, refusing with every failure and writing nothing;
   - the writes;
   - the event.
3. **After commit,** wake the executor and push `team-plan-detail`.

A command retried after a crash replays and never writes a second hold, pause, decision, revision row, or task revision (R17).

### D4. Holds

**`place`** checks:
- the plan is open;
- the deadline is in the future and at most 30 days away;
- the rationale is not empty;
- for scope `changes`, every name is a change of the plan's current approved revision or of its running execution, and no name repeats;
- a cited impact review belongs to the team's strategy and lists the plan;
- a cited decision card belongs to the plan.

Several holds may be active on one plan. A change is held while any active hold covers it.

**`release`** names the hold and a reason:
- With no `changes`, the whole hold is released.
- With `changes` on a changes-scoped hold, only those rows are released. The hold is released when none remain.
- With `retain` on a plan-scoped hold, one transaction releases it and places a changes-scoped hold over `retain`, with the same rationale, cites, and deadline. That hold's id derives from the command (`hold-<commandId>-narrowed`), so the narrowing replays. This is the design's "use a temporary whole-plan hold when impact is unknown, then narrow it deliberately".

**`extend`** sets a later deadline, at most 30 days from now, with an optional reason.

The deadline never releases anything (D13).

**Closing a plan** leaves its holds as they are. Attention reads only open plans, so a closed plan's holds go quiet, and they apply again if it is reopened. Stop leaves holds too: they belong to the plan, not the execution, and they cover a later execution's changes as well.

### D5. The hold gate

`holdGate(activeHolds, openTargets, change) → { holdIds, scope, pauseId } | null` is pure. It closes for a change covered by an active hold, and also for a change with an open pause target that is undecided (Pausing or Paused, D8). The pause part is what keeps a task revision published outside Adapt from dispatching D9's fix attempt while the change is paused (D9). The gate is consulted at every step that would advance held work:

| Where | What waits |
| --- | --- |
| executor `planSteps` | provisioning; dispatching an implement, fix, update, or restart attempt; the review handoff; the fix handoff after a failed round; D9's fix attempt for a new task revision; a Retry's dispatch |
| direct and integration landing (X6) | taking the landing slot; the merge; the candidate fast-forward |
| `PromotionService` (I2) | Promote (`no-hold`); a running promotion's step before its merge |
| Start (X5) | `no-hold`, for a whole-plan hold only |

**Decisions are split from dispatches.** A transition that both decides and dispatches, such as a failed round and its fix handoff, still records the decision under a hold. The dispatch stays due in stored state and runs once the gate opens: the hold release wakes the executor. Tasks 1.1 reconciles this split with the merged `planSteps`.

**The slot.** A held change that holds the slot, with no merge effect created yet, gives it up in one guarded transition and returns to its pre-slot step. A running merge or fast-forward settles, and so does a promotion already merging. The hold applies from the next step. A running promotion that reaches a held step before its merge gives up the slot and waits at step `held`. Once released, it takes the slot again and re-runs its up-to-date step.

**Results under a hold (R10).** Submission is never refused for a hold. The round is recorded and pushed, and CI runs. Pushing a change's own branch is not landing. The review handoff, the slot, and the merge wait. When the gate opens, the result's round proceeds from where it stopped, unless a new task revision superseded it (D9 of plan-execution).

**Promotion.** `no-hold` is appended to `PROMOTE_PRECONDITIONS`. It refuses while a whole-plan hold is active or any change the promotion would carry is held, naming the holds.

**Start.** `no-hold` is appended to `START_PRECONDITIONS`. It refuses while a whole-plan hold is active, naming it. Changes-scoped holds do not refuse Start: their changes wait under the gate.

*Why gate steps rather than add a change state:* a held change keeps its real stage, so release resumes exactly there. Supervision shows the hold as the cause (D13). A new X1 state would need a stored return point for every stage.

### D6. Pause

**`team-plan-pause { planId, holdId, deadline, note?, commandId }`.** Its checks:
- the hold is active;
- the plan has a running execution;
- no open pause covers the same hold;
- the deadline is in the future.

Its targets are the held changes of the running execution whose current stage is agent-held, read in the transaction:

| Current stage | Target |
| --- | --- |
| attempt instruction claimed or delivered | `stage: attempt`; holder = the claimant, following forwards to the successor |
| review handoff claimed or delivered | `stage: review`; holder likewise |
| instruction or handoff `queued` or `awaiting-request` | `withdrawn`: Kawai supersedes it through reassignment's stop branch, which cancels the mail. The assignment derives `superseded`, never `instruction-failed` (plan-execution D12). The target is recorded Paused at once, with no checkpoint. |
| instruction `spawning` | `stage` as above; its pause mail is sent once the spawn's claim is recorded |
| Kawai-held steps (CI, conditions, slot, the up-to-date step) and `waiting` changes | not targets; the pause lists them as "no active work" |
| a merge or fast-forward effect has started | not a target; listed as "landing in progress" and left to settle per plan-execution D12 (landed if the merge completed) |

**The pause mail.** In the same transaction, for each target with a holder, Kawai enqueues one urgent direct system mail (`from_kind: 'system'`) on the change's task, tagged `plan-pause`. Its body:
- names the hold's rationale and the pause deadline;
- asks the holder to stop at a safe point;
- for an attempt: commit all work in progress on the change branch, leaving `git status` clean, and call `task_checkpoint`;
- for a review: submit nothing further and stop;
- says that replies to Kawai are refused (D18 guidance).

Urgent direct semantics are unchanged: the interrupt waits for pending approvals and questions, which stay unresolved (R11), and a parked holder receives the mail when its resume arrives.

*Why urgent:* a safe stop needs the holder to read the request during its turn, not after it. The interrupt is the shipped, confirmed path, and it never touches a pending card.

**Parked and cooling holders.**
- The cooling refusal for urgent direct mail is a rule of the agent `send_message`/`reply` paths. Kawai's system mail is enqueued by `PauseService`, not through those tools, so it is never refused for a cooling profile.
- Like any mail, it reaches a holder only when that holder can take it. A parked holder receives it after its parked work's resume delivers, so the pause mail never jumps ahead of the work it pauses.
- Meanwhile the target reads Pausing with the cause `provider-limit`, naming the profile and its reset time (the cooldown computed from `profile_limit_events`).
- The pause deadline still applies, and Restart stays available (D9).

*Why not deliver to a parked holder at once:* parked work is held by the provider limit. An interrupting turn would hit the same limit and could add a park to the same work, so the pause would only add risk.

### D7. `task_checkpoint` and the `push-checkpoint` effect

`task_checkpoint { task_id, commit?, summary, unfinished?, errors_tests?, next_steps }` joins the `kawai-team` server. It is allowed without cards, and identity is bound to the caller.

**Refusals,** each with its fix:
- the task is not owned by a running execution;
- the caller is not the current claimant of a Pausing target of that change (`no-pause-requested`);
- an attempt target without a commit;
- the commit is not the head of `refs/heads/<change>` in the change's worktree;
- `git status --porcelain` there is not empty, listing the paths (ignored files are excluded, and the reply says so);
- the commit does not contain the branch's head on `origin`;
- Kawai is writing the branch (the D9 `updating` and `merging` steps of plan-execution).

**On success, one transaction:**
- inserts the checkpoint, with kind `commit`, the attempt's baseline, and its manifest hash;
- supersedes the target's earlier checkpoint;
- enqueues the `push-checkpoint` effect with key `<execution>:<change>:push-checkpoint:<checkpointId>:<generation>`. The checkpoint id occupies the round-or-attempt slot of plan-execution D14's key shape, so each recorded checkpoint gets its own key.

The effect runs `git push origin <commit>:refs/heads/<change>`, never forced. Its inspector is `ls-remote`: the head contains the commit means done, otherwise it runs again. Effect failures follow plan-execution D14's classes, except that a failed `push-checkpoint` never stops the change. The target reads Pausing with cause `checkpoint-push-failed`, and the holder may record again.

A review target may call the tool without a commit to leave notes (kind `notes`). Notes are optional.

**This modifies plan-execution D14 (X3).** X3's extension clause lets a mechanism add execution-level effect kinds; `push-checkpoint` is a change-level kind, so this change records it as an addition to D14's kind list: its key (above), its `ls-remote` inspector, and its failure rule (never a stop, no X8 entry). X3's bound-by gains `revision-control`. plan-execution archives first, so its design stays the record of D14 as written, and this decision records the addition.

**Retrying a failed push.** Another `task_checkpoint` call records a new checkpoint, and so gets a new effect key. A failed `push-checkpoint` is never a stop reason (no X8 entry).

**Never round evidence.** A checkpoint commit is not a round. Plan-execution D10 reads CI only for a round's commit, so CI that a checkpoint push starts on the branch never counts as any round's evidence. A later round includes the checkpoint and is evaluated on its own commit.

**Outside a pause.** Without a requested pause for the caller's change, the refusal guides the caller to keep working and submit with `task_submit_result`.

**A result counts.** A result submitted while its target is Pausing is a round as usual. Once that round's push effect is done, Kawai records a `result` checkpoint pointing at the result. The holder does not need to call the tool as well.

*Why Kawai pushes:* plan-execution tells agents not to push change branches (D18), and every outbound write is an audited effect (X3). The agent commits and Kawai pushes, so both rules hold, and execution-safety-recovery's audit sees the checkpoint push like any other.

### D8. Pausing and Paused

`pauseTargetState(target, facts)` is pure and returns one of three states.

**Paused**: `paused_at` is set, a recorded fact.

**Decided**: a decision is recorded, or the execution finished, in which case the decision reads `cancelled`.

**Pausing**: everything else. A Pausing target always carries its causes:
- `awaiting-delivery`: the pause mail is not delivered yet.
- `starting`: the spawn has not claimed.
- `request`: a pending approval or question.
- `busy`: a turn or background work is running.
- `provider-limit`: the holder is parked or its profile is cooling; names the profile and the reset (D6).
- `no-checkpoint`: no checkpoint is recorded yet.
- `checkpoint-pushing`: the checkpoint's push effect has not settled.
- `checkpoint-push-failed`: the push failed; the holder may record again (D7).
- `holder-killed`: the holder session was killed before its work reached `origin`.
- The readiness reasons that member release reports.

Some causes mean the pause cannot complete without the owner: `holder-killed`, `checkpoint-push-failed`, and any cause still standing at the pause deadline (for example `no-checkpoint` from a holder that ignores the mail). They are named so. Restart and Stop are available from every Pausing state (D9), so the owner is never left with Stop alone.

**Recording Paused.** The executor's tick records Paused in a guarded transaction (`WHERE paused_at IS NULL`) when both of these hold:
- **The work is on `origin`.** The target is a review, or its newest checkpoint is a `result`, or it is a `commit` whose effect is done.
- **The holder is ready.** `MemberRelease.readiness(holder)` reports ready. An archived holder counts as ready. A killed holder counts as ready only once its checkpoint reached `origin`; otherwise it is `holder-killed`.

Nothing else records Paused. A pause is closed (`closed_at`) when every target is decided or the execution finished.

**Restart (R18).** Nothing about a pause lives only in memory:
- The pause mail is a mailbox row under shipped receipt recovery.
- An unknown `push-checkpoint` effect is inspected before anything else for its change.
- Pausing is re-derived from stored rows.

So a restart never resumes the holder blindly, and never shows a Paused state that was not recorded. A paused execution survives restart with its pause, targets, checkpoints, and attempts (R01).

**Deadline.** One target never raises two items. A target still Pausing after the pause deadline for a cause other than `holder-killed` or `checkpoint-push-failed` raises only `plan-pause-overdue` (D13), whose next action offers unblocking the holder, Restart, or Stop. A Paused target, or a Pausing one as `holder-killed` or `checkpoint-push-failed`, raises only `plan-checkpoint-decision`, before or after the deadline. Nothing is killed, and the pause stays open.

### D9. The owner's choices

`team-plan-pause-resolve { planId, pauseId, change, choice, adapt?, rationale?, releaseHold?, commandId }`. One transaction records the decision and its event, then applies the choice:

| Choice | Allowed from | Effect | Refused when |
| --- | --- | --- | --- |
| `continue` | Paused | Kawai enqueues normal direct system mail to the holder, tagged `plan-resume`. It names the checkpoint commit and the task's newest revision. An archived holder is restored by direct mail. No attempt is created. | The target was withdrawn, or is a review whose handoff was superseded; the holder was killed (`holder-gone`) |
| `adapt` | Paused | The human publishes the task's next revision with notify (`TaskService` publication, `within`, request key `pause:<commandId>`), with the dialog's direction and acceptance and the rationale. Plan-execution D9 then supersedes the round and dispatches a fix attempt naming that revision. The attempt continues from the branch head, which includes the checkpoint. | A review target: Adapt applies to the change's work, and a review's direction is its result |
| `restart` | Paused, or Pausing with any cause; without a checkpoint on `origin` the dialog carries the "may predate" note | See **Restart** below. | — |

**Restart.**
1. A spawned holder that is ready is released first, through member release's `releaseNow`, journaled as Kawai. The new attempt then starts in a fresh session. A spawned holder that is not ready (busy, awaiting a request, holding mail) is marked pending release under member release's durable pending row and released once ready.
2. A human-created holder is never released. The dialog says the attempt may reach that session.
3. The attempt's dispatch waits for the worktree like any dispatch (worktree staffing). A busy holder, or a human-created one, may keep the worktree meanwhile, and the dialog says so.
4. Kawai supersedes the held assignment through the stop branch, which never cancels claimed work. From then on, D9's ownership checks refuse the old holder's submissions and checkpoints for the change.
5. Kawai dispatches a new attempt of the stage's kind (implement, fix, or update), or a new review handoff.
6. The attempt starts from the newest checkpoint commit on `origin`, or else from the branch head on `origin`. In the second case the dialog and the instruction say that head may predate the holder's work.
7. Its manifest carries the optional `checkpoint: { id, commit }`, and its instruction carries the checkpoint package.

**This modifies plan-execution D8 (X2).** `AttemptManifest` v1 gains an optional `checkpoint: { id, commit }`, omitted when absent, so the canonical serialization and hash of every manifest without it are unchanged and no version bump is needed. X2's bound-by gains `revision-control`. Continue stays Paused-only; Restart is the way forward from a Pausing target.

**Cancel** is plan-execution's Stop, linked from the dialog. Stop decides every open target as `cancelled` in its own transaction and closes the pause. Stop stays available from every state, so a refused Continue always leaves Restart and Stop.

**Under a standing hold.**
- Continue resumes the same attempt, so the hold does not block it. The hold still blocks the next handoff and landing (D5).
- Adapt and Restart dispatch new attempts, which the hold blocks. The resolution is recorded at once, and its dispatch shows as waiting on `hold`.
- The dialog therefore offers **Also release this change from hold <id>** (`releaseHold`). It writes the `hold-released` event for that change in the same transaction, under the compared payload.
- `releaseHold` applies only to a changes-scoped hold. For a whole-plan hold the dialog points to narrowing first, because that hold also refuses Start and covers changes the plan may add, and dropping one change from it is a deliberate narrowing (D4).
- Other active holds that cover the change stay, and the dialog names them.
- Releasing a hold on its own never resolves a pause.

**A task revision published outside Adapt.** The owner may publish a task revision on a paused change from the task view. While the target is undecided, the pause closes the gate (D5), so plan-execution D9's fix dispatch waits. When the decision is recorded, the pending D9 dispatch is dropped if the resolution covers it:
- Continue's resume mail names the newest revision, and the holder already has its notice.
- Adapt publishes its own, newer revision.
- Restart's attempt names the newest revision.

Every resolution therefore works from the newest revision, and nothing is dispatched twice.

*Why Restart continues from the checkpoint commit:* Kawai never forces a branch, and a restart from the baseline would need a rewrite. The new holder gets the checkpoint as history and decides what to keep. That is the UX design's "new attempt linked to history".


**Acceptance oracles (4.4–4.5).** The resolve/restart surface is accepted against the oracles below: A1 held the inputs (every output `?`); A2 filled the outputs; A3 (this commit) applies the lead's binding amendments (note-cb984944) — the ROUND RULE, the D1–D6 disagreements, the decided UNDECIDED items, and the G1–G7 gaps. A MiMo advisor filled A1's outputs blind from the spec alone and the two were diffed; each disagreement is resolved in the table before any of §10 (3)–(7) is coded. Derivation sources, in precedence order when they disagree: the binding INVARIANT H as amended (H″ O1–O4, O3′) and I1–I6; then CP1 rev 4 (§1–§9); then this D9 as written. Recorded where a source wins: **(a)** H3 wins over D9's Adapt/Restart effects — the resolution mints its own attempt row inside its transaction (never `ensureFixAttempt`'s reuse) and dispatches per H1, inline when the hold gate leaves the change unheld, else owed and dispatched once by the generalized owed step on release; **(b)** the H5 deviation wins over D9's Restart step 5 for a review target whose passable round pends a revision (steps 1–4 only, no new row, `revisionPending N` in the detail) and over D9's Continue for that same review cell (no drop, no resume — the detail records `revisionPending N` there too, D2); **(c)** O4 wins silently — every accepted resolution clears a pending `redispatch` step; **(d)** rev4 §1 extends D9's Restart allowed-from column to the withdrawn cells. Target states are `pauseState.ts:75–115`'s; the newest-attempt-row axis is `attemptStatus`'s (H″ O1).

*Axes.* **State:** `decided` (a decision stands, or the execution finished → `cancelled`) · `paused` (not withdrawn, holder alive) · `paused·withdrawn` (withdrawn, Paused recorded) · `pausing·withdrawn` (withdrawn, not yet Paused, causes `[]`) · `pausing·no-checkpoint` · `pausing·checkpoint-pushing` · `pausing·checkpoint-push-failed` · `pausing·holder-killed` · `pausing·other` (awaiting-delivery | starting | request | busy | provider-limit | readiness — `*` among these) · `paused·gone` (Paused, the holder's session record is gone). **Resolution:** `continue` · `adapt` · `restart` · `stop` (plan-execution's Stop, the dialog's Cancel). **Hold:** `—` (none covers the change) · `active` · `active→released` (the resolution carries `releaseHold: true`; the release lands in the same transaction under `<commandId>:release-hold`). **Newest attempt row:** `—` (none exists) · `<kind> owed` · `<kind> out` · `<kind> answered` for kind ∈ implement|fix|update; `answered(*)` = any kind, on a review target; `answered·rev↗` = answered and the round's result pins an older task revision than the task's current one (the H5 pending-revision input). The completeness test expands every kind over owed/out/answered and `answered` over plain vs rev↗ (the update kind: `out` is the update target C17/A13r/R21r; its owed and answered values are unreachable, U1/U7).

*The ROUND RULE (binding, note-cb984944; one rule behind D1, G2 and G3).* At the decision, a resolution supersedes the target's passable round (outcome null or pass, H2) if and only if the round's pinned revision is older than the revision the resolution works from: Adapt works from its own N+1, so it always supersedes; Continue and Restart work from the task's newest revision, so they supersede only an `answered·rev↗` round. The supersede is supersedeRound + cancelLiveRoundEffects + the slot-releasing transition, inside the resolution's transaction. Review targets keep the H5 exception: no drop, and D9 runs after the decision. Why: a passable round left below Adapt's N+1 would be superseded by D9 after the decision, minting a second fix beside H3's row — that breaks T4 and P-H″.

*Command-level preconditions (before any state is read), all resolutions:*

| ID | Caller | Plan/pause/change | commandId history | Hold | Row | Outcome | Rows written | Mail sent | Dispatches |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| K1 | agent | * | * | * | * | refused `forbidden` (rights first) | none | none | none |
| K2 | human | unknown plan, pause, or change | * | * | * | refused `not-found` | none | none | none |
| K3 | human | known | same commandId, same payload | * | * | replayed - the prior outcome returns; `within` never runs | none | none | none |
| K4 | human | known | same commandId, different payload | * | * | refused naming the first differing field | none | none | none |
| K5 | human | known | same commandId, concurrent double submit | * | * | one wins and commits; the loser rolls back and resolves as the winner's replay | one decision + one event total | the winner's mail only | the winner's dispatch only |
| K6 | human | known, pause closed (every target decided or the execution finished) | fresh | * | * | refused `state` (the pause is closed) - covers continue, adapt and restart; Stop is not refused here (S2) | none | none | none |

*Decision rows. `*` = the column does not change this row's outcome (the completeness test expands `*` over the axis's remaining values):*

| ID | State | Resolution | Hold | Newest attempt row | Outcome | Rows written | Mail sent | Dispatches |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| C1 | decided | continue | * | * | refused, naming the standing decision (I1) | none | none | none |
| C2 | paused | continue | * | — | accepted | decision `continue` {holder, release 'never', assignmentId} + the ROUND RULE's conditional drop (the newest passable round superseded only when it pins an older revision than the task's newest) + a pending `redispatch` step cleared (O4) + `pause-resolved` event + closeIfDecided | one `plan-resume` (normal, direct, system) naming the newest revision and the newest checkpoint's commit | none |
| C3 | paused | continue | * | implement owed | accepted; the owed row is untouched (Q-A3, with G4's caveat: reachable only through a row minted owed after the pause's creation — H7 reads an owed newest row noActiveWork, so the pause never names one; e.g. a round failing CI under the gate mints applyFix's row owed) | as C2 | as C2 | the owed row dispatches once via the owed step when the gate opens |
| C4 | paused | continue | * | implement out | accepted | as C2 | as C2 | none |
| C5 | paused | continue | * | implement answered (plain) | accepted; no drop (the round pins the task's newest revision, so the ROUND RULE's condition fails) | as C2 | as C2 | none |
| C6 | paused | continue | * | fix owed | accepted; the owed row is untouched (Q-A3, with G4's caveat as C3's) | as C2 | as C2 | the owed row dispatches once via the owed step when the gate opens |
| C7 | paused | continue | * | fix out | accepted | as C2 | as C2 | none |
| C8 | paused | continue | * | fix answered (plain) | accepted; no drop (the round pins the task's newest revision, so the ROUND RULE's condition fails) | as C2 | as C2 | none |
| C9 | withdrawn (paused·withdrawn or pausing·withdrawn — withdrawn is checked before the state, so the answer stays the same across the tick) | continue | * | * | refused `target-withdrawn` | none | none | none |
| C10 | pausing·* (every pausing sub-state), not withdrawn | continue | * | * | refused `not-paused` | none | none | none |
| C11 | paused·gone | continue | * | * | refused `holder-gone` | none | none | none |
| C12 | review target (gating, reviewing), handoff stands | continue | * | answered (plain) | accepted | decision + detail + event; no drop (the ROUND RULE's condition fails) | one `plan-resume` naming the task's newest revision AND the recorded notes' id, never a commit | none |
| C13 | review target, handoff superseded | continue | * | answered(*) | refused `review-superseded` (a gone holder reads `holder-gone` first, C11) | none | none | none |
| C14 | review target, handoff stands, passable round `answered·rev↗` (H5) | continue | * | answered·rev↗ | accepted (H5) | decision `continue` + detail `revisionPending N` (D2) + event; no drop | none - no resume, no drop | none; after the decision D9 (H2) dispatches the round's fix per H1 |
| C15 | paused (attempt stage) | continue | * | implement answered·rev↗ | accepted; the passable round superseded (the ROUND RULE) | as C2 + supersedeRound + cancelLiveRoundEffects + the slot-releasing transition | as C2 | none |
| C16 | paused (attempt stage) | continue | * | fix answered·rev↗ | accepted; the passable round superseded (the ROUND RULE) | as C15 | as C15 | none |
| C17 | paused (update target: gating, update row out) | continue | * | update out | accepted (G1: as C2) | as C2 - the out row untouched, the change stays gating | as C2 | none |
| A1r | decided | adapt | * | * | refused, naming the standing decision (I1) | none | none | none |
| A2r | paused (attempt stage) | adapt | * | — | accepted | publish N+1 (requestKey `pause:<commandId>`) + its notices + decision `adapt` {release 'never'} + ONE new attempt row (kind fix, task revision N+1, startCommit the branch head read before the transaction) + every passable round superseded (the ROUND RULE: Adapt works from its own N+1, so it always supersedes; supersedeRound + cancelLiveRoundEffects + the slot-releasing transition) + the held assignment superseded through the stop branch (only queued/awaiting-request mail cancelled — after the publication's notices, so the paused holder still gets its revision notice) + a pending `redispatch` step cleared (O4) + event | the publication's revision notices | inline when the gate is open, else owed - dispatched once by the owed step on release |
| A3r | paused (attempt stage) | adapt | * | implement owed | accepted; the older owed row never dispatches (H6) (G4's caveat as C3's) | as A2r | the publication's notices | the new row, per the hold |
| A4r | paused (attempt stage) | adapt | * | implement out | accepted; the held assignment superseded through the stop branch (the A2r shape names it) | as A2r | the publication's notices | the new row, per the hold |
| A5r | paused (attempt stage) | adapt | * | fix owed | accepted (G4's caveat as C3's) | as A2r | the publication's notices | the new row, per the hold |
| A6r | paused (attempt stage) | adapt | * | fix out (claimed failed-round fix) | accepted; the failed round is NOT superseded (H2: passable rounds only); the held assignment superseded through the stop branch | as A2r | the publication's notices | the new row, per the hold |
| A7r | paused (attempt stage) | adapt | * | fix answered (plain or rev↗) | accepted; every passable round superseded (the ROUND RULE — plain and rev↗ alike) | as A2r | the publication's notices | the new row, per the hold |
| A8r | paused·withdrawn (attempt stage) | adapt | * | * | accepted - the withdraw recorded Paused; publishes; the stop-branch supersession is a no-op (the assignment is already superseded), so no live holder is notified | as A2r | the publication's notices | the new row, per the hold |
| A9r | pausing·* | adapt | * | * | refused `not-paused` | none | none | none |
| A10r | review target | adapt | * | * | refused `review-target` | none | none | none |
| A11r | paused·gone (attempt stage) | adapt | * | * | accepted - no holder-gone refusal; the notices to the gone session dead-letter at enqueue (Q-A7) | as A2r | the publication's notices (dead-lettered for the gone holder) | the new row, per the hold |
| A12r | paused (attempt stage) | adapt | * | implement answered (plain or rev↗) | accepted; every passable round superseded (the ROUND RULE — as A7r) | as A2r | the publication's notices | the new row, per the hold |
| A13r | paused (update target: gating, update row out) | adapt | * | update out | accepted (G1, per O4); the ROUND RULE supersedes the update's round (Adapt always supersedes) | as A2r, except the new attempt row is kind `fix` copying `answers` and `update` from the update row at revision N+1, and the change moves to `implementing` (the fix row's owed state) | the publication's notices | one dispatch of the new fix row, per the hold |
| R1 | decided | restart | * | * | refused, naming the standing decision (I1) | none | none | none |
| R2 | paused (attempt stage) | restart | * | — | accepted | decision `restart` {holder, release 'now'/'pending' when not ready/'never' for human-created or archived, assignmentId} + ONE new attempt row (kind = the newest row's kind, else the stage's kind; `manifest.checkpoint {id, commit}` when the F4 containment read finds this pause target's own newest done checkpoint on origin - never an earlier pause's (D5) - startCommit that commit, else startCommit origin's branch head + the may-predates note; newest revision) + the ROUND RULE's conditional supersede (the newest passable round superseded only when it pins an older revision than the task's newest; supersedeRound + cancelLiveRoundEffects + the slot-releasing transition) + the held assignment superseded through the stop branch (only queued/awaiting-request mail cancelled) + a pending `redispatch` step cleared (O4) + event; a spawned ready holder released first (releaseNow, journaled Kawai), a spawned busy one marked pending release, archived nothing, human-created never | none - the attempt's instruction rides its dispatch | per the hold: inline when the gate is open, else owed once on release; the dispatch waits for the worktree |
| R3 | paused (attempt stage) | restart | * | implement owed | accepted; the older owed row never dispatches (H6) (G4's caveat as C3's) | as R2 | none | the new row, per the hold |
| R4 | paused (attempt stage) | restart | * | implement out | accepted | as R2 | none | the new row, per the hold |
| R5 | paused (attempt stage) | restart | * | implement answered (plain) | accepted; no drop (the round pins the task's newest revision, so the ROUND RULE's condition fails) | as R2 | none | the new row, per the hold |
| R6 | paused (attempt stage) | restart | * | fix owed | accepted; the older owed row never dispatches (H6) (G4's caveat as C3's) | as R2 | none | the new row, per the hold |
| R7 | paused (attempt stage) | restart | * | fix out | accepted | as R2 | none | the new row, per the hold |
| R8 | paused (attempt stage) | restart | * | fix answered (plain) | accepted; no drop (the round pins the task's newest revision, so the ROUND RULE's condition fails) | as R2 | none | the new row, per the hold |
| R9 | paused·withdrawn | restart | * | * | accepted | as R2 | none | the new row, per the hold |
| R10 | pausing·no-checkpoint | restart | * | * | accepted; nothing on origin - the may-predates note in dialog and instruction | as R2 (startCommit origin's head) | none | the new row, per the hold |
| R11 | pausing·checkpoint-pushing | restart | * | * | accepted; the containment read decides checkpoint vs may-predates | as R2 | none | the new row, per the hold |
| R12 | pausing·checkpoint-push-failed | restart | * | * | accepted; a failed/unknown push is not on origin - may-predates | as R2 (startCommit origin's head) | none | the new row, per the hold |
| R13 | pausing·holder-killed | restart | * | * | accepted; the start point is always origin's branch head + the may-predates note - a holder-killed cause never left a checkpoint on origin (D8:297-298), so the containment read's checkpoint branch is unreachable here (U8) | as R2 (startCommit origin's head) | none | the new row, per the hold |
| R14 | pausing·other | restart | * | * | accepted; a busy spawned holder is marked pending release | as R2 | none | the new row, per the hold; the dispatch waits for the worktree |
| R15 | pausing·withdrawn | restart | * | * | accepted (rev4 extends D9's allowed-from) | as R2 | none | the new row, per the hold |
| R16 | paused·gone | restart | * | * | accepted | as R2 | none | the new row, per the hold |
| R17 | review target, `answered·rev↗` (H5 exception) | restart | * | answered·rev↗ | accepted; H5 exception - steps 1-4 only | decision `restart` with revisionPending N in the detail + the held assignment superseded through the stop branch + event; NO new attempt row | none | none; after the decision D9 (H2) dispatches the round's fix per H1 |
| R18r | review target | restart | * | answered(*) | accepted; steps 1-4 as R2 (the handoff-standing condition does not restrict it, Q-A2); D9's steps 6-7 (start point, manifest) apply to attempts only, so no attempt row and no new manifest (D4, H3's scope) | decision `restart` + the held assignment superseded through the stop branch + R2's release bookkeeping + event - NO attempt row (D4) | none | ONE new review handoff: same round, same result, same head commit, its own fresh request key (the superseded handoff's key would replay it), dispatched per the hold; its instruction adds the paused reviewer's recorded notes' id when one exists |
| R19r | paused (attempt stage) | restart | * | implement answered·rev↗ | accepted; the passable round superseded (the ROUND RULE) | as R2 | none | the new row, per the hold |
| R20r | paused (attempt stage) | restart | * | fix answered·rev↗ | accepted; the passable round superseded (the ROUND RULE) | as R2 | none | the new row, per the hold |
| R21r | paused (update target: gating, update row out) | restart | * | update out | accepted (G1, per O4) | as R2, except the new attempt row is kind `update` (re-minted from the update row, so the update re-runs) and the change stays `gating` with step null and passedAt null | none | the new row, per the hold |
| S1 | any state with ≥1 open target | stop | * | * | accepted | every open target decided `cancelled` + the pause closed + the event | none | none |
| S2 | all targets decided (pause closed) | stop | * | * | not this change's resolution - Stop with every target decided is plan-execution's own Stop (R4:7, available from every state); it writes nothing to the pause, and this change refuses nothing (the closed-pause `state` refusal covers continue, adapt and restart only, K6) | none | none | none |

*releaseHold overlay (composes with every row above whose Hold is `active→released`):*

| ID | Input | Outcome | Rows written | Mail sent | Dispatches |
| --- | --- | --- | --- | --- | --- |
| H1r | accepted resolution, releaseHold, changes-scoped active hold | additionally the `hold-released` release in the same transaction under `<commandId>:release-hold`; other covering holds stay and are named | composes with the row's own writes | none extra | the row's dispatch, now unblocked by this hold |
| H2r | any resolution, releaseHold, whole-plan hold | refused with the narrowing guidance - nothing written, the resolution included (Q-A4) | none | none | none |
| H3r | any resolution, releaseHold, hold already released | refused (the hold is already released) - nothing written | none | none | none |
| H4r | other active holds also cover the change | accepted; the other holds stay and are named | the release for the named hold only | none | still gated by the remaining holds |

*Unreachable combinations (with their reasons):*

- **U1.** An `update` newest row `owed` (any stage), and an `update` row `out` on an `implementing` change — an owed update row reads noActiveWork (O3/H7), so a pause never names one; and an update row is `out` only in `gating` with no step and no passed round (H″ O1) — which is the update attempt target O3 defines, not an attempt-stage one.
- **U2.** An absent, owed, or out newest row on a review target — a standing review implies the reviewed round exists with its result recorded, so the newest row is answered (plain or rev↗).
- **U3.** A row owed and answered at once — `attemptStatus`'s statuses are exclusive (a round recording the row wins).
- **U4.** A non-withdrawn `paused` target with no holder — the executor records Paused only for a known holder; the no-holder cell is the withdrawn one (recorded Paused at once, D6).
- **U5.** `paused·gone` and `decided` together — decided wins at `pauseState`'s first branch; the gone-holder state only enumerates undecided targets.
- **U6.** `pausing·checkpoint-pushing` (R11's cell) while the holder is killed and nothing of its work is on origin — a Pausing target always carries its causes, re-derived whole each tick (D8:297–298), and a killed holder counts as ready only once its checkpoint reached `origin`, `holder-killed` until then, with Paused recorded only on work on `origin` plus readiness (D8:310–313). The killed-holder window always presents `holder-killed` (R13); R11's cell belongs to the live-holder push window.
- **U7.** An `answered` (plain or rev↗) `update` newest row as any resolution's axis value — `agentHeldStage` returns `attempt` for an update row only while it is `out` (O3); an answered update row reads no active work, so no pause target names one.
- **U8.** `pausing·holder-killed` with this pause target's checkpoint already on `origin` — the on-origin rule records Paused once the killed holder's checkpoint reached `origin` (D8:297–298, :310–313), so the target never presents `holder-killed` over work already on `origin` (D5).

*Property oracles (one per invariant; generators are a small seeded helper in the test tree, no new dependency):*

- **P-I1 (decided once).** After any accepted resolution, every later resolve on the target either replays (same commandId+payload: prior outcome, no rows, no mail) or is refused naming the standing decision; two concurrent same-commandId commands leave exactly one decision row and one `pause-resolved` event. Generator varies: choice, fresh vs replayed ids, mutated payloads, submit order. Seams: `PauseService.resolve` over the bench stores (no real threads — sequential double calls). Seed `20261022`, 40 cases.
- **P-I2 (claimed work never cancelled; the old holder refused from rows).** After Restart, no mail in state claimed/delivered is cancelled (the stop branch cancels only queued/awaiting-request), and the old holder's `task_submit_result`, `task_submit_findings`, and `task_checkpoint` are refused in both windows — before the new dispatch (services rebuilt over the same database) and after it — each judged from the rows. Generator varies: mail state at restart, window, submission kind, holder type (spawned/human-created/archived). Seams: the bench stores, `ExecutionOwnership.checkResult`, `MemberRelease.readiness`. Seed `20261022`, 24 cases.
- **P-I3 (the hold gates dispatch, never recording).** Under an active hold every accepted resolution records its rows and mail and mints no dispatch; on release the owed dispatch is issued exactly once, through `holdGate`, with no second check. Generator varies: resolution, hold placed/released between steps, releaseHold flag, crash boundary. Seams: `HoldStore`, the executor's `planSteps`, the owed step. Seed `20261022`, 40 cases.
- **P-I4 (Continue's shape).** Any accepted Continue creates no attempt row and enqueues at most one `plan-resume`; none for the H5 review cell; an attempt owed before the pause dispatches exactly once when the gate opens, unless Adapt or Restart minted a newer row; `holder-gone` and withdrawn targets are refused. Generator varies: stage, pending revision, owed row kind, holder aliveness, review-handoff state. Seams: the pause store, the mailbox, `attemptStatus`. Seed `20261022`, 40 cases.
- **P-I5 (atomicity).** Every refusal writes nothing — no event, no decision, no round supersede, no step clear, no mail; every accepted resolution commits its rows and mail in one transaction, and an injected throw at any point inside the transaction leaves none of them. Generator varies: refusal reason, resolution, injection point (decision write, supersede, mail enqueue, event insert). Seams: `PlanRefusal`, the stores' transaction scopes. Seed `20261022`, 40 cases.
- **P-I6 (recovery derives from rows).** For any recorded decision, rebuilding every service over the same database re-derives the same observable state: a Paused target's work is on origin (R01), and across any number of restarts the resume/owed dispatch is issued at most once (R18). Generator varies: crash boundary (before/after the decision, the supersede, the dispatch, the release), rebuild count. Seams: fresh service construction over one SQLite file. Seed `20261022`, 30 cases.
- **P-H″ (one writer per next instruction).** At every observation point at most one of {owed step, fixes step, resolution-inline dispatch} sends an instruction for the change; a delivered instruction is re-sent only under a `:retry:` key; every accepted resolution clears a pending `redispatch` step (O4); while the newest row is owed no other stage mints for that change. Generator varies: command sequences mixing resolutions, Retries, holds, crashes, and fresh vs replayed ids. Seams: the executor's steps over the bench stores. Seed `20261022`, 60 cases.

*Verify mapping (each bullet names its oracle ids and one mutant each must kill):*

| Verify bullet (tasks.md 4.4/4.5) | Oracles | Mutant killed |
| --- | --- | --- |
| Continue sends one `plan-resume`, creates no attempt; refused for killed holder and withdrawn target | C2–C11, P-I4 | a second resume enqueued on replay → P-I1 |
| Adapt publishes one revision with its notice, and D9's fix attempt follows | A2r–A8r, P-I3 | Adapt mints through `ensureFixAttempt`'s reuse → T4/A-rows |
| Restart supersedes without cancelling claimed work; the manifest names the checkpoint | R2–R8, P-I2 | the stop branch cancels claimed mail → P-I2 |
| Restart releases a ready spawned holder first, never a human-created one | R2–R8, P-I2 | `markPending` drops the spawned/archived guard → P-I2 |
| Restart starts from origin's head with the "may predate" note when no checkpoint reached origin | R10–R13 | the containment read accepts a not-on-origin commit → R10–R13 |
| Restart allowed from every Pausing state (incl. `no-checkpoint`); the old holder's later submissions and checkpoints refused | R10–R15, P-I2 | a Pausing-state refusal added → R10–R15 |
| Restart of a busy spawned holder marks it pending release; the dispatch waits for the worktree | R14, P-I2 | release attempted while not ready → P-I2 |
| A refused Continue leaves Restart and Stop | C10/C13, S1 | a Continue refusal thrown non-`PlanRefusal` → P-I5 |
| Adapt and Restart under an active hold record at once and dispatch only after release | A2r–A8r, R2–R8, P-I3 | a `!held` guard added → P-I3 |
| `releaseHold` releases in the same transaction; whole-plan hold refused with the narrowing guidance | H1r–H4r | the release written in a second transaction → P-I5 |
| Continue resumes under a hold | C2–C8, P-I3 | Continue refused under a hold → C-rows |
| A task revision published while undecided dispatches nothing; the following resolution names the newest revision, no second dispatch | C14, R17, P-I4 | the revision stage fires under an open pause target → C14 |
| An old manifest's hash is unchanged by the optional field | §6 serialize test | a `null` checkpoint in `manifestHashInput` → hash test |
| R01: restart with a Paused target keeps execution, attempt, checkpoint; Continue creates no attempt | P-I6, C2 | a restart dropping the checkpoint row → P-I6 |
| R18: restart after the pause mail and before any checkpoint re-derives Pausing, records no Paused, sends no resume | P-I6, R10 | a resume re-sent after rebuild → P-I6 |

*Enumeration questions the blind reading resolves (numbered Q-A1…; each names where the sources fell short). A3 (note-cb984944) records their resolutions: Q-A1–Q-A7 bind as answered, with Q-A3's noActiveWork caveat (G4) and Q-A6's plain-vs-rev↗ split:*

- **Q-A1.** Stop is plan-execution's own command; the table carries only its pause-side contract (S1–S2). Confirm its execution-side stops stay under plan-execution's oracles, not duplicated here.
- **Q-A2.** `review-superseded` (C13) refuses only Continue. Adapt refuses reviews as `review-target` (A10r) and Restart is allowed from every state — so a Restart over a review target with a superseded handoff is allowed (R18r with a superseded handoff). Confirm the handoff-standing column does not further restrict R18r.
- **Q-A3.** On an attempt target whose newest row is owed (C3/C6), does Continue's H5 drop still read the newest *round* (which the owed row did not produce), leaving the owed row owed — so after Continue both the resume and the owed dispatch may reach the holder? (Reading of rev4 §3 H5 + I4: yes; the owed row is untouched by Continue and dispatches once when the gate opens.) Caveat (G4): H7 reads an owed newest row noActiveWork, so the pause never names one — the cell is reachable only through a row minted owed after the pause's creation, e.g. a round failing CI under the gate (applyFix mints it owed).
- **Q-A4.** A refused resolution with `releaseHold: true` (e.g. C10 + releaseHold) releases nothing — the refusal writes nothing, so the overlay's writes are refused with the resolution (H2r/H3r's refusals likewise). Confirm no partial release.
- **Q-A5.** `holder-gone` is judged from `target.holderSession` + the session records at call time, for review targets (the reviewer) exactly as for attempt targets (C11). Confirm.
- **Q-A6.** C5/C8 (newest row answered on an attempt target) is the window between the holder's result submission and the pipeline's next tick. Confirm the row stays reachable-as-inputs (the outputs refuse nothing special) rather than being merged into C4/C7. Split (A3): plain answered stays C5/C8 with no drop (the round pins the task's newest revision, so the ROUND RULE's condition fails); answered·rev↗ rows separately as C15/C16, where the ROUND RULE supersedes the round.
- **Q-A7.** A11r (Adapt over a `paused·gone` target): no source names a holder-gone refusal for Adapt, and its publication needs no live holder — expected allowed, with the notices enqueued to the gone session dead-lettering at enqueue (D6's killed-recipient path). Confirm.

*Executable oracles (from §10 (3) on, per the digest):* each step commits its table rows verbatim as `test.each` rows; from (3) on a completeness test expands the axes over the table and the unreachable list (no gap, no overlap); from (3) on growing model-based tests run the table as an executable reference model — a seeded generator produces command sequences (resolutions with fresh or replayed ids, a hold placed or released, a killed holder, the old holder's checkpoint or result, a crash with recovery at each transaction boundary) against the real service on an in-memory database, comparing observable state with the model after every step, seeds and case counts fixed within the runner's 20 s timeout; a failing seed found on the way becomes a named table row.

### D10. The revision delta

`revisionDelta(from: PlanContent, to: PlanContent, landed: Set<string>, provisioned: Set<string>)` is pure. It returns per-change classes and execution-wide findings.

**Per change, by name:**
- `added`: only in `to`.
- `removed`: only in `from`.
- `changed`: present in both, with the differing fields listed. The compared fields are `dependsOn`, `fixes` (plan-supervision D2), the implementing and review groups, acceptance, extra checks, and guidance, and the effective review group when the plan's review group changes.
- `metadata`: a landed change whose only differences are `dependsOn` or `fixes`. Apply updates them and offers no choice, so a forward fix can name a task on a change that already landed.
- `unchanged`: otherwise.

**Execution-wide findings (refusals, D11):**
- `landing-changed`: the landing mode or integration branch differs;
- `plan-rules-changed`: the plan-wide acceptance rules or extra checks differ and any change has landed;
- `landed-changed`: a landed change differs in a field other than `dependsOn` and `fixes`, or is `removed`;
- `lead-changed`: `PlanContent.leadGroup` (plan-supervision D2) differs. It is informational, never a refusal: Apply takes it, and cards raised afterwards go to the new lead group.

A change of plan-wide rules with nothing landed, or of roles at any time, marks every unlanded change `changed` through the effective fields. A role entry counts through its `profiles`, in preference order — the change's implementing group's and its effective review group's, looked up by group name — and only unlanded changes compare roles, so a role change never produces `landed-changed`.

**Choices.** A `changed` change that has a task needs a choice. One still `waiting`, with no task, is recorded with choice `none` and picks up the new definition when provisioned.

### D11. Apply

**`team-plan-execution-apply-preview { executionId, revision }`** returns the delta, the choices it needs, the generated Adapt texts, and the precondition standing.

**`team-plan-execution-apply { executionId, expectedRevision, revision, contentHash, choices, adaptations?, rationale, commandId }`** follows D3.

**Reads:**
- `ValidationService.prepareStanding(planId, revision)` (V1);
- the group files;
- the landing probe's base head;
- the blob reads of `changes-on-base` for the added changes and for the changed changes chosen `adapt` or `restart`.

**`APPLY_PRECONDITIONS`** run in order and are append-only like X5:

| Entry | Checks |
| --- | --- |
| `plan-open` | the plan is open |
| `execution-running` | the execution is running |
| `execution-revision-unchanged` | `expectedRevision` is the execution's current revision (the CAS) |
| `revision-current` | `revision` and `contentHash` are the plan's current approved revision |
| `revision-newer` | `revision` is greater than the execution's |
| `validation-current` | V5's entry, unchanged |
| `start-conditions-resolved` | the target report's `start` conditions (V2) |
| `strategy-impact` | `ImpactService.gate(planId, revision)` (C-I1) |
| `landing-unchanged` | no `landing-changed` |
| `landed-unchanged` | no `landed-changed`, and no `plan-rules-changed`. The message names each change and points to a forward fix: "add a change that corrects it (plan-supervision S4)" |
| `merge-quiet` | no changed or removed change has a merge or fast-forward effect running |
| `choices-complete` | exactly the changed changes with a task have a choice; Adapt texts are not empty |
| `changes-unclaimed` | Start's entry, for the added changes |
| `changes-on-base` | Start's entry, for the added changes and the adapted or restarted ones |
| `roles-routable` | Start's entry, for the unlanded changes under the target's roles |

**The transaction** inserts the next `plan_execution_revisions` row and updates the execution's revision columns. Then, per change:
- **unchanged:** a publication row only;
- **metadata:** the row, with the landed change's `dependsOn` and `fixes` read from the new revision;
- **changed, `continue`:** the row; the running attempt keeps its manifest, and later attempts and handoffs read the execution's new revision;
- **changed, `adapt`:** the human publishes the task's next revision with notify through the `within` publication (request key `apply:<commandId>:<change>`), recording the task revision. The shipped notice goes to the outstanding claimant, and plan-execution D9 follows after commit;
- **changed, `restart`:** the row. The executor supersedes the assignment and dispatches a new attempt of the stage's kind under the new revision, as in D9 here;
- **added:** a change row in `waiting` at its content position (or `landed` with `owns = 0` when a landing fact exists), scheduled by the executor;
- **removed, unlanded:** state `cancelled`, `owns = 0`. Pending effects are cancelled, the slot is given up, and Kawai cancels its task through `TaskService.setStatus(system, …, 'cancelled')` with `alsoWithin`, exactly as Stop does for one change.

Positions follow the target's content order. The `revision-applied` event closes the transaction.

**Atomicity and crashes (R17).** The revision row, the publication rows, the task revisions with their notices, the cancellations, and the event commit together. The command id replays the whole command, and each task publication's request key replays inside it, so a retry after a crash publishes nothing twice. The notices are mailbox rows, under shipped delivery and receipt recovery.

**Forward fixes (S4, plan-supervision at 645d02d).** `PlanChange.fixes` names the fix or correction task (`task-<uuid>`, a `plan_fix_tasks` row). A revision that adds changes naming such a task joins the running execution through Apply, and `fixStatus` then reads running for that execution. S4 closes a fix task once a change naming it has landed and no change in the current approved revision naming it is unlanded. Each landing is judged by the revision it landed under (`plan_change_landings.execution_id`). Apply never removes a landed change (`landed-unchanged`), so it never strands a fix. A removed, unlanded fix change is cancelled like any other, and the fix task stays open until a change naming it lands.

### D12. What a running execution's revision now means

- **Approval still changes nothing.** Only Apply moves an execution to a newer revision, and only forward.
- **Manifests are immutable.** An attempt's manifest names the revision current at its dispatch. Attempts dispatched after an Apply name the new one.
- **Readers of the revision** (`planSteps`, the task-link check for added tasks, completion in plan-execution D19) read the execution's current revision.
- **Completion.** The execution completes when every change of its current revision has landed. Removed changes are cancelled and not counted. The plan completes by the system when that revision is still the plan's current approved one, as before.
- **History.** `plan_execution_revisions` keeps every revision the run held, with its publication rows. `team-plan-detail` and `plan_get` list them.

### D13. Supervision causes and attention

**Causes (S2, append-only).** `changeSupervision` gains `paused` (naming the pause and the awaited decision), `pausing` (naming the pause and its D8 causes), and `hold` (naming the holds, their scope, and their deadlines). They join the running-stage named waits right after `effect`, in the order `paused`, `pausing`, `hold`, and before `uncertain-delivery`. With plan-supervision D10's order, the running-stage named waits read: effect, paused, pausing, hold, uncertain-delivery, staffing, parked/cooling, request, decision-card, ci, member-release, condition, landing-slot. S2's outcome order (plan-supervision at 645d02d) puts `repeating-failure` at position 5, ahead of every named wait, and that is unchanged: a held change whose last two rounds failed alike reads `repeating-failure`, with `hold` listed as also applying. The other applicable waits are listed as also applying. A change in one of these named waits is never a `no-progress` stall.

**Attention sources** go in `ATTENTION_SOURCES` through `planAttention.ts`, with the `plan` link of plan-supervision D13:

| Kind | Item id | Owner | Next action | Clears when |
| --- | --- | --- | --- | --- |
| `plan-hold-overdue` | `plan-hold-overdue:<holdId>:<deadline>` | human | Release or extend the hold | the hold is released or extended |
| `plan-pause-overdue` | `plan-pause-overdue:<pauseId>:<change>` | human | Unblock the holder, or restart or stop | the target is Paused or decided |
| `plan-checkpoint-decision` | `plan-checkpoint:<pauseId>:<change>` | human | Continue, adapt, restart, or stop for a Paused target; restart or stop for one Pausing as `holder-killed` or `checkpoint-push-failed` | a decision, or the execution finishes |

Each is derived only while its plan is open. None changes state. A target past its deadline that is Pausing for another cause raises only `plan-pause-overdue`, which offers Restart and Stop as well, so one target never raises two items.

### D14. Human protocol and the view

**Messages,** each answered by `team-plan-result`:
- `team-plan-hold-place`, `team-plan-hold-release`, and `team-plan-hold-extend`;
- `team-plan-pause` and `team-plan-pause-resolve`;
- `team-plan-execution-apply-preview` and `team-plan-execution-apply`.

They are addressed by `teamPath` through the shared resolver and listed in `CHAT_CONNECTION_TYPES`. `team-plan-detail` gains `holds`, `pauses` (targets with state, causes, checkpoints, and decisions), and per execution `revisions` with their publication rows. It is pushed after every write here and after every Paused recording.

**Components:**
- `PlanHoldsSection.tsx`: active and released holds, with Release (whole, some changes, narrow) and Extend;
- `PlanHoldDialog.tsx`: scope, changes, rationale, deadline, and cite;
- `PlanPauseSection.tsx`: targets with Pausing causes, checkpoints, and "no active work" changes;
- `PlanCheckpointDecisionDialog.tsx`: the checkpoint package, the four choices, Adapt's texts, and a link to Stop;
- `PlanApplyRevisionDialog.tsx`: the delta by class, a choice per changed change, the generated Adapt texts, the standing, and the required rationale.

Hold, Pause, and Apply open from the plan detail and the execution section.

**The store.** `teamPlanStore` keeps one command id per open dialog, minted at open, re-minted when the compared payload changes, and retired on success, as for durable-plans' dialogs. Every control disables while disconnected, and refusals show inline with every failing check.

### D15. Agent surface

- `plan_get` gains `holds`, `pauses`, and each execution's `revisions`.
- `task_checkpoint` (D7) is the only new tool.
- The plan note (`teamPrompt.ts`) adds:
  - a `plan-pause` mail asks you to stop at a safe point: commit everything on the change branch, leaving the worktree clean, then call `task_checkpoint`;
  - Kawai pushes the checkpoint;
  - wait for the owner's decision;
  - a held change's work may continue, but nothing lands until the owner releases it.
- No tool places, releases, or extends a hold, pauses, resolves a pause, or applies a revision, and none may be added. The services refuse an agent caller on those paths.

### D16. Contracts consumed and published

Consumed:
- **C1:** `PlanContent`, compared field by field (D10).
- **C2:** the pin of the applied revision, through `revision-current` and `strategy-impact`.
- **C3:** `PlanService.recordRevisionControlEvent`, the only `plan_events` writer.
- **C5:** added tasks linked at the execution's new revision.
- **C6:** six new kinds.
- **V1:** `prepareStanding` and `standing` of the target revision.
- **V2:** the target report's carried conditions.
- **V5:** the `validation-current` entry.
- **X1:** change states, steps, and owner rows; added and cancelled rows.
- **X2:** manifests stay immutable; the optional `checkpoint`, registered as a D8 addition (D9).
- **X3:** the new change-level `push-checkpoint` kind and inspector, registered as a D14 addition (D7).
- **X4:** CI evidence bound to a round's commit, which keeps checkpoint commits out of evidence (D7, Risks).
- **X5:** `no-hold` appended.
- **X6:** giving up the slot.
- **X7:** landing facts decide `landed-changed`.
- **X8:** no new stop reasons.
- **plan-execution D9, D10, D12, D14, and D18:** new task revisions and the ownership checks; CI read per round commit (D7's "never round evidence"); Stop and supersession; the effect failure classes and the startup inspection of `unknown` effects (D7, D8); and the reply guidance.
- **I1 and I2:** candidate fast-forwards and promotions gated, with `no-hold` appended to `PROMOTE_PRECONDITIONS`.
- **C-I1 and C-I3:** the gate, and holds citing a review.
- **S1** (plan-supervision at 645d02d): decision cards bind only as hold citations. Adapt publishes the dialog's text, never a card's.
- **S2:** the three causes join the running-stage named waits after `effect` (D13); `repeating-failure` keeps position 5. plan-supervision D10 names only `hold` as an incoming cause; `paused` and `pausing` are added under S2's append rule.
- **S4:** forward fixes whose `fixes` name fix or correction task ids, joining running work as added changes or through a `fixes` difference (D10).
- **plan-supervision D13:** attention sources and the `plan` link.
- **Modifications of plan-execution,** recorded here because plan-execution archives first: D14 gains the change-level `push-checkpoint` kind (X3, D7), and D8's `AttemptManifest` v1 gains the optional `checkpoint` (X2, D9). Both bound-by lists gain `revision-control`.
- **Shipped:** task-revision-publication (publication `within`, notices, request keys); member release's readiness; the mailbox's urgent direct semantics, system mail, and receipt recovery; and task assignment's supersession through the stop branch.

Published:

| Contract | What it fixes | Bound by |
| --- | --- | --- |
| R1 Holds | D2 hold tables; D4 scope, narrowing, and deadline rules; D5 `holdGate` and the gated step list | `execution-safety-recovery` (the recovery matrix covers hold writes; no fencing, per its D11) |
| R2 Pauses and checkpoints | D2 pause, target, and checkpoint tables; D8 `pauseTargetState` and the Paused rule; D7 `push-checkpoint` and its inspector; D9 choices | `execution-safety-recovery` (matrix rows for Paused across restart and the `push-checkpoint` inspector; `task_checkpoint` stays pause-only, per its D12) |
| R3 Execution revisions and publications | D2 `plan_execution_revisions` and publication rows; D10 `revisionDelta`; D11 `APPLY_PRECONDITIONS`, append-only | `execution-safety-recovery` (audit and the crash matrix of Apply), later plan changes |
| R4 Command events | D3 kinds and compared payloads | `execution-safety-recovery` (audit) |
| R5 Causes and attention | D13 causes and their order, and attention kinds | `execution-safety-recovery` (recovery states beside them) |

## Risks / Trade-offs

- **[A holder ignores the pause mail]** → The target stays Pausing with its cause, the deadline raises attention, and the owner can Restart from that Pausing state or Stop. Restart supersedes the attempt, so the old holder's later submissions are refused. Readiness without fencing proves only that the holder is idle, not that it cannot write later. execution-safety-recovery adds no fencing (its D11): the D9 submission checks and the hold gate keep a late write from landing.
- **[Urgent pause mail interrupts a turn mid-edit]** → The holder is asked to commit whatever it has. A torn edit stays in the checkpoint commit and is visible to whoever continues. The pending-card rule is unchanged.
- **[A checkpoint push triggers CI on the branch]** → CI evidence is bound to a round's commit (X4), so a checkpoint commit's CI is never a round's evidence.
- **[Strict landed refusals block plan-wide rule edits after the first landing]** → The owner adds a forward fix or starts a new execution after Stop. Silent reinterpretation of landed evidence would break P10.
- **[Continue keeps the old task direction for a changed change]** → That is the owner's recorded choice. The publication row shows it, and Adapt is one click away.
- **[`plan-execution`, `integration-candidates`, and `plan-supervision` must land first]** → The `plan-execution` delta modifies a requirement that exists only in that unarchived change, so validation shows an informational note until it is archived. Names are reconciled in tasks 1.1.

## Migration Plan

- An additive migration creates the seven tables and backfills `plan_execution_revisions` seq 1 from every existing execution.
- The new `team-plan-detail` fields are optional, so older clients ignore them.
- Rollback: the previous build ignores the tables. A running execution then runs whatever revision its row names, and holds stop applying, so the owner should release holds and resolve pauses before a rollback.

## Open Questions

- Whether the 30-day deadline bound should be a per-team setting in `~/.kawai/teams.json`. Recommendation: keep the constant until a team asks.
- Whether Apply should also accept a revision that drops a landed change by keeping its landing fact as history. Recommendation: refuse now (`landed-unchanged`) and revisit with typed relations.
