# Design

## Context

See proposal.md for motivation. This change carries Apply out of `revision-control` (split proposed 2026-11-18). Its decisions D2–D4 are revision-control's D10–D12, moved; D3 corrects one obsolete step.

### Current inventory (source pin `f52963d0`)

Landed by revision-control and reused here:
- `src/server/plans/revisionControl/revisionDelta.ts`: the pure `revisionDelta(from, to, landed, provisioned)` (D2), unit-tested in `src/server/__tests__/revisionControlDelta.test.ts`. No production module imports it.
- `src/server/plans/revisionControl/executionRevisionStore.ts`: `record` and `recordAt` append a revision row with its publication rows; a primary-key collision becomes `ExecutionRevisionConflict('execution-revision-unchanged')`. Start writes seq 1 in its transaction (`ExecutionService.ts`).
- Migration 17 (`revisionControlSchema.ts`) created `plan_execution_revisions` and `plan_execution_publication_changes`.
- `PlanService.recordRevisionControlEvent` (`PlanService.ts:407`) with the `revision-applied` kind and its compared payload (`revisionControl/events.ts:14`): a replay returns the prior outcome and never runs `within`.
- The synchronous task publication: `TaskStore.publish(taskId, { direction, rationale, requestKey, notify, within }, actor)`, with notices written inside it, as Adapt of a pause uses it (`pauseResolve.ts:377-391`, request key `pause:<commandId>`).
- `TaskService.prepareStatus` (async) and its `PreparedTaskStatus.commit` (synchronous, throws `StaleTaskStatus`) at `TaskService.ts:431-450`, used by Stop (`ExecutionService.ts:419-445`) and the executor (`executor.ts:372`).
- Readers of an execution's revision read the stored row each time (`executionDispatch.ts:67`, `diagnosisOpen.ts:74`, `diagnosisStage.ts:179`, `executionView.ts:57`), so an updated row is what later dispatches read.
- The recovery matrix already has a gap row "R4 — Apply crash" owned by revision-control (`docs/recovery-matrix.md:68`).

Missing: `ApplyService`, `APPLY_PRECONDITIONS`, the per-change writes, the preview, the two messages, executions' revisions in `team-plan-detail` and `plan_get`, the dialog, the store slot, and the browser step.

Size limits: `ExecutionService.ts` is 479 lines and `executor.ts` 499, so Apply's logic lives in new modules.

## Goals / Non-Goals

**Goals:**
- Apply a newer approved revision to a running execution in place, with a recorded per-change classification and an atomic publication.
- Never redefine landed work; point every refusal to a forward fix.
- A crash at any point leaves either nothing or the whole Apply, and a retry never publishes twice.

**Non-Goals:**
- Holds, pauses, and their views (revision-control).
- Leases, epochs, or fencing tokens (execution-safety-recovery D11 rules them out); the database arbitrates races.
- Applying a revision that drops a landed change while keeping its landing as history (refused now; revision-control's open question).
- Agent-side Apply.

## Decisions

### D1. Modules and ownership

- `applyPreconditions.ts`: the pure, append-only `APPLY_PRECONDITIONS` list (D3), each entry a named check over the prepared reads and the transaction's fresh rows.
- `applyWrites.ts`: the per-change writes of D3, called only inside the transaction.
- `applyService.ts`: `preview` (reads only) and `apply` (prepare, then one transaction through `recordRevisionControlEvent`). It refuses a non-human caller first.
- `applyConnections.ts`: the two messages, composed in `planComposition.ts`.

Writers stay single: `ExecutionRevisionStore` writes the two revision tables, `PlanService` writes `plan_events`, `TaskStore.publish` writes task revisions and notices, the execution store writes change rows and effects, and `PreparedTaskStatus.commit` writes task status. The executor alone dispatches, after commit.

### D2. The revision delta (revision-control D10, unchanged)

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

### D3. Apply (revision-control D11, corrected)

**`team-plan-execution-apply-preview { executionId, revision }`** returns the delta, the choices it needs, the generated Adapt texts, and the precondition standing.

**`team-plan-execution-apply { executionId, expectedRevision, revision, contentHash, choices, adaptations?, rationale, commandId }`** follows D3.

**Reads (the prepare phase, async, writing nothing):**
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

- for each removed, unlanded change whose task is open: `TaskService.prepareStatus(system, taskId, 'cancelled', note)` with the execution origin.

**The transaction** (synchronous, inside `PlanService.recordRevisionControlEvent`'s `within`, so a replay never runs it) inserts the next `plan_execution_revisions` row and updates the execution's revision columns. Then, per change:
- **unchanged:** a publication row only;
- **metadata:** the row, with the landed change's `dependsOn` and `fixes` read from the new revision;
- **changed, `continue`:** the row; the running attempt keeps its manifest, and later attempts and handoffs read the execution's new revision;
- **changed, `adapt`:** the human publishes the task's next revision with notify through the `within` publication (request key `apply:<commandId>:<change>`), recording the task revision. The shipped notice goes to the outstanding claimant, and plan-execution D9 follows after commit;
- **changed, `restart`:** the row, no task revision. The standing assignment is superseded, an open or passed round is superseded, the change returns to `implementing`, and one owed attempt row of the newest attempt's kind (an update restarts as `fix`) is minted with a manifest naming the new revision; the executor's owed step dispatches it after commit (resolved in the blind reading, CH5);
- **added:** a change row in `waiting` at its content position (or `landed` with `owns = 0` when a landing fact exists), scheduled by the executor;
- **removed, unlanded:** state `cancelled`, `owns = 0`. Pending effects are cancelled, the slot is given up, and Kawai cancels its task with the `PreparedTaskStatus` the prepare phase made, calling its synchronous `commit` here, exactly as Stop does (`ExecutionService.ts:419-445`). The old text named `TaskService.setStatus(system, …, 'cancelled')` with `alsoWithin`; that is async and cannot run inside a synchronous SQLite transaction, so it is obsolete: an async call started inside a synchronous `db.transaction` finishes after the transaction commits, outside it.

Positions follow the target's content order. The `revision-applied` event closes the transaction.

**Atomicity and crashes (R17).** The revision row, the publication rows, the task revisions with their notices, the cancellations, and the event commit together. The command id replays the whole command, and each task publication's request key replays inside it, so a retry after a crash publishes nothing twice. The notices are mailbox rows, under shipped delivery and receipt recovery.

**Forward fixes (S4, plan-supervision at 645d02d).** `PlanChange.fixes` names the fix or correction task (`task-<uuid>`, a `plan_fix_tasks` row). A revision that adds changes naming such a task joins the running execution through Apply, and `fixStatus` then reads running for that execution. S4 closes a fix task once a change naming it has landed and no change in the current approved revision naming it is unlanded. Each landing is judged by the revision it landed under (`plan_change_landings.execution_id`). Apply never removes a landed change (`landed-unchanged`), so it never strands a fix. A removed, unlanded fix change is cancelled like any other, and the fix task stays open until a change naming it lands.

**Stale preparation.** A prepared cancel whose task status moved since the prepare phase throws `StaleTaskStatus` inside the transaction, which rolls back everything. Apply then prepares again, at most 3 times as Stop does (`STOP_ATTEMPTS`, `ExecutionService.ts:475`), and otherwise refuses `state` naming the task, with nothing written.

**After commit:** wake the executor and push `team-plan-detail`. Dispatches (restart's new attempt, adapt's fix attempt per plan-execution D9, added changes' provisioning) follow from stored state on the executor's next tick, so they are never part of the transaction and are idempotent across a crash.

### D4. What a running execution's revision now means (revision-control D12, unchanged)

- **Approval still changes nothing.** Only Apply moves an execution to a newer revision, and only forward.
- **Manifests are immutable.** An attempt's manifest names the revision current at its dispatch. Attempts dispatched after an Apply name the new one.
- **Readers of the revision** (`planSteps`, the task-link check for added tasks, completion in plan-execution D19) read the execution's current revision.
- **Completion.** The execution completes when every change of its current revision has landed. Removed changes are cancelled and not counted. The plan completes by the system when that revision is still the plan's current approved one, as before.
- **History.** `plan_execution_revisions` keeps every revision the run held, with its publication rows. `team-plan-detail` and `plan_get` list them.


### D5. Preview

`team-plan-execution-apply-preview { teamPath, executionId, revision }` returns the delta, the changes that need a choice, the generated Adapt text per changed change, and every precondition's standing. It takes no command id and writes nothing. The dialog shows it and sends Apply with the choices; Apply recomputes everything, so a stale preview can only be refused, never applied.

### D6. Human protocol, view, and agent surface

- Messages `team-plan-execution-apply-preview` and `team-plan-execution-apply`, answered by `team-plan-result`, addressed by `teamPath` through the shared resolver, listed in `CHAT_CONNECTION_TYPES`.
- `team-plan-detail` and `plan_get` gain each execution's `revisions` (seq, revision, content hash, applied at, rationale) with their publication rows; the detail is pushed after every Apply.
- `PlanApplyRevisionDialog.tsx` opens from the execution section: the delta by class, a choice per changed change with a task, the generated Adapt texts, the standing, and a required rationale. `teamPlanStore` keeps one command id per open dialog, minted at open, re-minted when the compared payload changes, retired on success.
- No agent tool applies a revision, and none may be added (revision-control D15).

### D7. Recovery

Apply adds no startup reconciliation: nothing is partial, because every write is in one transaction. It adds two replay keys: the command id (`plan_events`' `UNIQUE (plan_id, command_id)`) and each Adapt publication's request key `apply:<commandId>:<change>`, disjoint from Adapt-of-a-pause's `pause:<commandId>`. The implementation replaces the matrix's gap row with its tests.

### D8. Interplay with holds and pauses

Apply is not refused by a hold. The dispatches it causes go through `planSteps`, so under a hold they wait at the gate like any other (revision-control D5). An adapted change that is an undecided pause target gets its revision recorded and dispatches nothing until the pause decision, as a revision published during a pause does (plan-pause "A paused change gets no new work until decided"). This follows from landed behavior and changes no scenario.

## Acceptance oracles

Hazards consulted (`docs/oracle-hazards.md`): M1 (an oracle behind a hand-built harness), B1 (the superseded actor's later writes), and "a key input no fixture varies". The async-call-in-a-transaction risk of the old D11 is not in the catalog; I2 and AK6 guard it here. Apply is a command over a state machine with recovery, so the tables get a blind second reading before code (task 1.1).

### Preconditions (AP)

Each row makes exactly one entry fail on an otherwise valid Apply. Result: refused naming that entry, nothing written (no revision row, publication row, task revision, notice, cancellation, or event).

| id | Failing entry | Input |
| --- | --- | --- |
| AP1 | `plan-open` | the plan is closed |
| AP2 | `execution-running` | the execution stopped or completed |
| AP3 | `execution-revision-unchanged` | `expectedRevision` is not the execution's current revision |
| AP4 | `revision-current` | `revision`/`contentHash` is not the plan's current approved revision |
| AP5 | `revision-newer` | `revision` is not greater than the execution's |
| AP6 | `validation-current` | the target's report is out of date (V5's message) |
| AP7 | `start-conditions-resolved` | the target report carries an unresolved `start` condition |
| AP8 | `strategy-impact` | the impact gate refuses the target |
| AP9 | `landing-unchanged` | the landing mode or integration branch differs (names the old and new landing, points to a forward fix change) |
| AP10 | `landed-unchanged` | a landed change's acceptance differs (names it, suggests a forward fix) |
| AP11 | `merge-quiet` | a changed or removed change has a merge or fast-forward running |
| AP12 | `choices-complete` | a changed change with a task has no choice, or an Adapt text is empty (an omitted text takes the generated one, D5; an explicitly empty one fails), names the change |
| AP13 | `changes-unclaimed` | an added change's task id is claimed elsewhere |
| AP14 | `changes-on-base` | an added, adapted, or restarted change's artifacts are not on the base |
| AP15 | `roles-routable` | an unlanded change's group under the target's roles has no routable worker |
| AP16 | several entries | refused naming every failing entry in list order |
| AP17 | none | accepted |

### Command shape (AK)

| id | Input | Result |
| --- | --- | --- |
| AK1 | an agent caller, or a direct service call with an agent caller | refused `forbidden` before any read; nothing written |
| AK2 | the same command id and payload after a success | the prior result; no second row, task revision, or notice |
| AK3 | the same command id, a different payload | refused naming the first differing field |
| AK4 | two different command ids on the same execution revision, concurrently | one commits; the other is refused `execution-revision-unchanged` naming the new revision |
| AK5 | the same command id and the same payload sent twice concurrently (a different payload is AK3) | one commits; the other resolves as its replay |
| AK6 | a prepared cancel goes stale three times (D3 "Stale preparation": at most 3 prepares, as Stop) | refused `state` naming the task; nothing written |

### Classification (DL), through `revisionDelta`

| id | Change | Class / finding |
| --- | --- | --- |
| DL1 | only in the target | added |
| DL2 | only in the running revision, unlanded | removed |
| DL3 | only in the running revision, landed | removed, with finding `landed-changed` naming it (refusal) |
| DL4 | in both, unlanded, a compared field differs, has a task | changed, needs a choice |
| DL5 | as DL4 but still waiting with no task | changed, choice `none` |
| DL6 | landed, differs only in `dependsOn` or `fixes` | metadata, no choice |
| DL7 | landed, differs in any other compared field | changed, with finding `landed-changed` naming it (refusal) |
| DL8 | landing mode or integration branch differs | finding `landing-changed` |
| DL9 | plan-wide rules or extra checks differ, something landed | finding `plan-rules-changed` |
| DL10 | plan-wide rules differ, nothing landed | every unlanded change changed, fields `planAcceptanceRules` / `planExtraChecks` (D2's effective fields) |
| DL11 | a role's profiles differ | unlanded changes whose implementing or effective review group is that role's changed, field `roles` (D2); never `landed-changed` |
| DL12 | only `leadGroup` differs | every change unchanged; informational `lead-changed` |
| DL13 | identical | unchanged |

### Choices on success (CH)

| id | Class, choice | Rows written in the transaction | After commit |
| --- | --- | --- | --- |
| CH1 | unchanged | publication row | nothing |
| CH2 | metadata | publication row; the change reads the target's `dependsOn` and `fixes` | nothing |
| CH3 | changed, continue | publication row; the running attempt's manifest unchanged | later attempts and handoffs read the new revision |
| CH4 | changed, adapt | publication row with the task revision; one task revision with notify under `apply:<commandId>:<change>`; its notice to the outstanding claimant | plan-execution D9: with a round gating or landing, the round is superseded and a fix attempt names that revision; while implementing with no round, no attempt, the notice carries it (main spec "Direction changed while implementing"); waits under a hold or an undecided pause, D8 |
| CH5 | changed, restart | publication row; no task revision; the standing assignment superseded, an open or passed round superseded, the change back to `implementing`, and one owed attempt row of the newest attempt's kind (an update restarts as `fix`) whose manifest names the new revision | the executor's owed step dispatches that attempt once |
| CH6 | changed, choice `none` (no task) | publication row | the new definition applies at provisioning |
| CH7 | added, no landing fact | change row `waiting` at its content position | scheduled by its dependencies |
| CH8 | added, landing fact exists | change row `landed`, `owns = 0` | nothing |
| CH9 | removed, unlanded, task open | state `cancelled`, `owns = 0`; effects cancelled; slot given up; the prepared cancel committed | nothing |
| CH10 | removed, unlanded, task already closed or no task | as CH9 without a task write (a closed task keeps its status) | nothing |

Every success also writes the next `plan_execution_revisions` row, updates the execution's revision columns to equal it, and writes the `revision-applied` event, all in the same transaction.

### Crash and replay (CR, multi-agent R17)

Boundaries: B0 before the prepare phase; B1 after it, before the transaction; B2 inside the transaction (a crash or a thrown write); B3 after commit, before the wake and push; B4 after them. After a restart, the owner retries with the same command id.

| id | Crash at | State after restart | Retry |
| --- | --- | --- | --- |
| CR1 | B0 or B1 | no revision row, publication row, task revision, notice, cancellation, or event from this Apply | runs as a first Apply against the current state (refused if a precondition now fails) |
| CR2 | B2 | as CR1 (the transaction rolled back) | as CR1 |
| CR3 | B3 | the whole Apply committed; nothing dispatched yet; notices delivered under shipped receipt recovery | replays; the executor's startup tick dispatches from stored state once |
| CR4 | B4 | committed and dispatched | replays; nothing new |

Completeness: the boundaries B0–B4 cover every point of the command's path, and each maps to one row. Across the other tables, AP1–AP15 are single-failure rows and AP16 their combination; DL1–DL7 and DL13 classify each change name (presence × landed × differing fields × task), while DL8–DL12 are execution-wide findings layered over them, so the completeness test expands the per-change axes and the execution-wide axes separately; CH1–CH10 partition the per-change classes and choices of an accepted Apply. Unreachable: a partial transaction (SQLite atomicity); a notice without its task revision (both in one `TaskStore.publish` inside the transaction).

### Properties

- **P1, one history.** For every execution, revision rows are contiguous from seq 1, at most one per seq, and the execution's revision columns equal the newest row. Generator: seeded sequences over one plan of approvals, Applies with fresh or replayed command ids, concurrent pairs on one base, Stops, and a crash at each of B0–B4 with restart. Seams: the real `ApplyService`, `PlanService`, stores, and `TaskStore` on a fresh test database; git reads through a stub that checks its arguments. Seed `0x4A99`, 200 cases through `propertyCases`.
- **P2, publish once.** Across the same sequences, each adapted change has exactly one task revision and one notice per Apply command id, whatever retries and crashes occur.
- **P3, landed work stays.** No accepted Apply changes a landed change other than its `dependsOn` and `fixes`, removes it, or changes plan-wide rules after a landing. Generator: random content edits over plans with random landed sets; seam: `revisionDelta` plus the real precondition list; seed `0x4A9A`, 500 cases through `propertyCases`.
- **P4, manifests keep their revision.** Every attempt manifest names the revision current at its dispatch; an Apply never rewrites one. Same generator and seams as P1, with the real executor ticking between commands; seed `0x4A9B`, 200 cases through `propertyCases`.

Model-based test: the CR table and the CH table run as the reference model over P1's sequences, comparing stored rows after every step.

### Production composition (PC)

PC1: through the composed server (`planComposition` with the real executor and connection router), the owner sends `team-plan-execution-apply` for a running execution with one change chosen continue and one adapted; the result carries the new revision, the adapted task has one new revision with its notice, the executor dispatches the fix attempt naming it, and the next `team-plan-detail` lists both revision rows. Mutants: the type left out of `CHAT_CONNECTION_TYPES`, `applyConnections.ts` not composed, the executor wake after commit removed, and the detail push removed each fail PC1. Every piece PC1 uses lands in task 2.2. PC2: the same path with AP3's stale `expectedRevision` is refused with nothing written.

### Forward fixes (FX, plan-supervision S4)

FX1: a change whose `fixes` names a fix task is added by Apply and lands; `fixStatus` reads running, then the fix task closes once no change of the current approved revision naming it is unlanded. FX2: a fix change removed before landing is cancelled and its fix task stays open. FX3: a `fixes`-only difference on a landed change applies as metadata with no choice.

### Preserved workflows

Start's seq-1 row (`executionComposition.test.ts`), Stop, a pause's Adapt publication (request-key namespaces stay disjoint), the hold gate, and completion keep their tests passing unchanged.

## Risks / Trade-offs

- [Strict landed refusals block plan-wide rule edits after the first landing] → The owner adds a forward fix, or stops and starts a new execution. Silent reinterpretation of landed evidence would break P10.
- [Continue keeps the old task direction for a changed change] → It is the owner's recorded choice; the publication row shows it, and Adapt is one click away.
- [A prepared cancel races a human closing the task] → `StaleTaskStatus` rolls the whole transaction back; Apply prepares again (AK6).
- [Apply and revision-control's remaining slice touch the same protocol, detail, store, and view files] → The proposed graph orders them by shared path: this change's 2.2–2.4 and 3.1 after revision-control 9.1–9.2, its 3.2–3.3 after revision-control 9.4–9.5; 1.1 and 2.1 run in parallel.

## Migration Plan

No migration: the tables exist (migration 17). The new `team-plan-detail` field is optional, so older clients ignore it. Rollback: the previous build ignores the history rows beyond seq 1, and a running execution keeps running whatever revision its row names.

## Execution checkpoints

1. Task 1.1: the blind second reading of AP, AK, DL, CH, and CR (inputs-only commit, a cross-model advisor fills the outputs, the author's outputs, a diff resolved in the tables), recorded by the Lead as binding before code.
2. After task 2.2: PC1 and PC2 green at a pinned commit, reviewed before the remaining rows. 2.2 carries every piece PC1 uses (the Apply message and whitelist entry, the composed handler, the continue and adapt writes, the post-commit wake, and the revision rows in the detail push), so the checkpoint runs the real router → transaction → executor → push path, never a harness.
3. After task 2.4: the full tables, P1–P4, and the CR model green, with the named mutants killed.
4. Task 3.1 (preview message, publication rows, `plan_get`) after revision-control 9.1–9.2; tasks 3.2–3.3 (view and the browser step) after revision-control 9.4–9.5.

## Implementation contract

### Acceptance

- A1: Apply refuses exactly as AP1–AP17 and AK1–AK6 state, naming every failing entry and writing nothing on any refusal.
- A2: Every change is classified as DL1–DL13 state, and a choice is required exactly for changed changes that have a task.
- A3: An accepted Apply writes, in one transaction, the next revision row, the execution's revision columns, a publication row per change, the CH1–CH10 writes, and one `revision-applied` event; the dispatches follow after commit.
- A4: A crash at B0–B4 leaves the state of CR1–CR4, and a retry under the same command id publishes no second revision row, task revision, or notice (multi-agent R17).
- A5: Properties P1–P4 hold over their declared cases, and the CR/CH model-based test passes.
- A6: PC1 and PC2 pass through the composed server, and FX1–FX3 hold.
- A7: `team-plan-detail` and `plan_get` list each execution's revision history with publication rows, and attempt manifests keep the revision current at their dispatch.
- A8: The Apply dialog asks a choice only for changed changes with tasks, reuses one command id while the payload is unchanged, renders every failing check, and disables while disconnected; a fixture-gated browser walkthrough applies a revision with one adapted change.

### Invariants

- I1: No agent tool or agent-callable path applies a revision.
- I2: A removed change's task is cancelled only through `prepareStatus` before the transaction and the synchronous `commit` inside it; no async status call runs inside the transaction.
- I3: Landed changes are never redefined, removed, or reinterpreted by an Apply.
- I4: No lease, epoch, or fencing token is added; the database's keys arbitrate concurrent Applies.
- I5: Attempt manifests are never rewritten.
- I6: `ExecutionService.ts` and `executor.ts` stay under 500 lines.

### Scope

- `openspec/changes/plan-revision-apply/**`
- `src/server/plans/revisionControl/apply*.ts`
- `src/server/plans/revisionControl/revisionDelta.ts`
- `src/server/plans/revisionControl/executionRevisionStore.ts`
- `src/server/plans/revisionControl/events.ts`
- `src/server/plans/execution/**`
- `src/server/plans/planComposition.ts`
- `src/server/plans/planConnections.ts`
- `src/server/plans/supervision/planSupervisionDetail.ts`
- `src/server/plans/decisions/**`
- `src/server/chat/chatConnectionTypes.ts`
- `src/shared/planMessages.ts`
- `src/shared/planRevisionControl.ts`
- `src/client/stores/teamPlanStore.ts`
- `src/client/components/team/PlanApplyRevisionDialog.tsx`
- `src/client/components/team/PlanExecutionSection.tsx`
- `src/server/__tests__/**`
- `src/client/__tests__/**`
- `tests/e2e/chat-plan-revision-apply.spec.ts`
- `AGENTS.md`
- `docs/architecture/plans.md`
- `docs/architecture/plan-execution.md`
- `docs/recovery-matrix.md`

### Verification

- V1: AP, AK, DL, CH, CR, and FX rows are committed verbatim as table-driven tests, after the blind second reading recorded binding by the Lead.
- V2: P1–P4 run at their seeds with the declared counts, the full counts under `--full-properties`, and the CR/CH model-based test runs crashes at each boundary.
- V3: PC1 and PC2 pass through the composed server; the wiring mutants of task 2.2 (type not whitelisted, handler not composed, post-commit wake removed, detail push removed) each fail PC1; mutants dropping the CAS (AK4), keeping a failed entry out of the list (AP16), writing the event outside the transaction (CR2), and publishing without the request key (P2) each fail their row.
- V4: The recovery matrix's "R4 — Apply crash" row cites this change and its CR tests, and `src/server/__tests__/recoveryMatrix.test.ts` passes.
- V5: Component tests cover A8's dialog rules; the fixture spec passes in CI's fixture step, run only through the private fixture path, never `bun run test:e2e`.
- V6: A citation preflight over the result's map reports zero unresolved; `openspec validate plan-revision-apply --strict` and `bun run check --full-properties` pass on the clean committed head under the pinned Bun; `scripts/verify-result.ts` reports the head.

### Excluded

- X1: Holds, pauses, their messages, views, causes, and attention items (revision-control's remaining slice).
- X2: Dropping a landed change while keeping its landing as history.
- X3: Any change to approval, validation standing, or Start's own preconditions.
- X4: Archiving; the change archives after it lands, with revision-control.
