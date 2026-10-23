// The owner's resolve command (revision-control 4.4-4.5, design D9 + A3's
// C-rows and A-rows): one decision per pause target, recorded as the
// `pause-resolved` event and the target's decision row in one transaction.
// This step implements 'continue' (C1-C19) and 'adapt' (A1r-A14r); the
// 'restart' choice (R1-R23r) lives beside it in pauseRestart.ts. The
// entry is async for L3's pre-transaction head read (A3.2): after the
// replay short-circuit it gathers origin's branch head for an adapted fix
// row's manifest — and for a restart's — through the `adaptHead` seam,
// outside the transaction; a failed read refuses `head-unreadable` (K7)
// inside `within`, after every earlier refusal. The
// checks run in order: decided (I1, naming the standing decision even on a
// closed pause — before the choice dispatch, so every choice names it), the
// closed pause (K6, undecided targets only), then the choice dispatch:
// 'continue' reads withdrawn before the state (C9), not-paused (C10),
// holder-gone (C11), then the stage branch; 'adapt' proceeds past a
// withdrawn target (A8r), refuses only still-pausing (A9r) and review
// targets (A10r), and never refuses a gone holder (A11r); 'restart' is
// D9's allowed-from exception (rev4 §10): it proceeds past withdrawn
// (R9/R15), still-pausing (R10-R15), gone holders (R16), and review
// targets (R17/R18r), so only I1, K6, and the not-implemented choices
// refuse before its stage branch. An attempt target
// under 'continue' takes C2's shape: the decision {holder, release 'never',
// assignmentId}, the ROUND RULE's conditional supersede of the newest
// passable round (supersedeRound + cancelLiveRoundEffects + the
// slot-releasing transition), O4's clear of a pending `redispatch` step, and
// one normal direct system plan-resume naming the newest revision and the
// newest checkpoint's commit. A review target takes C12-C14: a superseded
// handoff refuses (C13); a passable round pending a task revision records
// `revisionPending N` and sends nothing (C14, H5); otherwise the resume
// names the newest revision and the recorded notes' id, never a commit
// (C12, D3). No attempt row is minted under 'continue' (I4) — D9's own stage
// mints after the decision. 'adapt' on an attempt target takes A2r's shape:
// the task revision published under `pause:<commandId>` with its notices
// FIRST, the decision {release 'never'}, every passable round superseded
// (Adapt always — the ROUND RULE; the failed round never, A6r), the held
// assignment superseded through the stop branch after the notices (P-I2),
// the A13r move to `implementing`, O4's clear, ONE new kind-`fix` attempt
// row at revision N+1 (H3), and the dispatch inline when the gate — read
// after the decision — is open, else owed (H1). 'restart' takes R2's shape
// (pauseRestart.ts). Stop lands in its own step and refuses writing nothing
// until then. Refusals inside
// the transaction throw (§2) — PlanRefusal for the K-level reasons, the
// ResolveRefusal codes below — so a refused command writes nothing, not
// even the event.
import { createHash } from 'node:crypto'
import { PlanRefusal } from '../planCommands'
import type { ExecutionEventOutcome, PlanCaller } from '../PlanService'
import type { PauseStage } from '../../../shared/planRevisionControl'
import { revisionPending } from '../execution/executionRounds'
import type { ChangeRow } from '../execution/executionRows'
import type { AttemptManifest } from '../../../shared/planExecution'
import { manifestHashInput } from '../../../shared/planExecution'
import { holdGate, type OpenPauseTarget } from './holdGate'
import type { ActiveHold } from '../../../shared/planRevisionControl'
import { dispatchAdaptedFixWithin } from '../execution/executionAdaptDispatch'
import { restartTarget } from './pauseRestart'
import type { PlanPause, PlanPauseTarget } from '../../../shared/planRevisionControl'
import type { PauseServiceDeps } from './pauseService'

/** The tag the resume mail carries (D9). */
export const PLAN_RESUME_TAG = 'plan-resume'

/**
 * The resolve's own refusal codes (the checkpointTool precedent): thrown
 * inside the transaction so nothing is written, returned as the outcome's
 * reason. `review-target` belongs to adapt (A10r) and lands with its step.
 */
export type ResolveRefusalCode = 'target-withdrawn' | 'not-paused' | 'holder-gone' | 'review-superseded' | 'review-target' | 'head-unreadable'

/**
 * L3 (A3.2): the facts the resolve's pre-transaction git read gathers for an
 * adapted fix row's manifest — origin's branch head for the new startCommit.
 * `{ ok: false }` is a failed read (K7, refused `head-unreadable` inside
 * `within`, where it cannot mask I1/K6 or the review refusals); `null` (or
 * the seam unwired) leaves the manifest's old fallback to the newest
 * attempt's start commit.
 */
export type AdaptHeadFacts = { ok: true; startCommit: string; artifacts: Record<string, string> } | { ok: false }

/** A resolve-specific refusal: not a PlanRefusalReason, so it carries its own class and is caught at the resolve entry (§2). */
export class ResolveRefusal extends Error {
  constructor(readonly code: ResolveRefusalCode, message: string) {
    super(message)
  }
}

/** One resolve command (D9): the target's change, the choice, and whether
 *  releasing the hold follows the decision — the flag is recorded now so the
 *  replay compares it; the hold's release writes land in the release step. */
export interface ResolveInput {
  planId: string
  pauseId: string
  change: string
  choice: 'continue' | 'adapt' | 'restart' | 'cancelled'
  adapt?: string
  rationale: string
  releaseHold?: boolean
  commandId: string
}

/** One committed resolve; `result` is undefined on a replay (D3). The
 *  resolve-specific refusal codes ride `reason` beside PlanRefusalReason. */
export type PauseResolveOutcome = ExecutionEventOutcome<{ target: { change: string; decision: string } }> | { ok: false; reason: ResolveRefusalCode; message: string; result: undefined }

/**
 * The resume mail's body (D9, D3): the decision and the task revision in
 * force; an attempt target also names the newest checkpoint commit to
 * continue from, a review target the recorded notes' id — never a commit.
 */
export function resumeBody(plan: { id: string; title: string }, target: { change: string; stage: PauseStage },
  revision: { number: number; rationale: string | null }, checkpointCommit: string | null, notesId: string | null): string {
  const lines = [
    `Kawai: the owner resumed change ${target.change} of plan "${plan.title}" (${plan.id}).`,
    `Your work continues on the same task and branch. The task's direction is revision ${revision.number}${revision.rationale ? ` (${revision.rationale})` : ''}.`,
  ]
  if (target.stage === 'attempt' && checkpointCommit !== null) {
    lines.push(`Continue from checkpoint ${checkpointCommit}.`)
  }
  if (target.stage === 'review' && notesId !== null) {
    lines.push(`Your recorded review notes are checkpoint ${notesId}.`)
  }
  lines.push('Replies to this message are refused.')
  return lines.join('\n')
}

function forbidden(): PauseResolveOutcome {
  return { ok: false, reason: 'forbidden', result: undefined, message: 'Only the plan\'s owner may resolve a pause, from the Plans view; no agent tool can.' }
}

/**
 * The resolve command (K1-K6, then the C/A/R/S rows): rights first, then the
 * plan lookup, then the one transaction through `recordRevisionControlEvent`
 * — its replay never runs `within`, so a replayed resolve sends nothing and
 * supersedes nothing twice. A ResolveRefusal from `within` rolls the
 * transaction back and returns as the outcome's own reason code.
 */
export async function resolvePause(deps: PauseServiceDeps, caller: PlanCaller, input: ResolveInput): Promise<PauseResolveOutcome> {
  if (caller.kind !== 'human') return forbidden()
  const plan = deps.plans.forTeam(caller.team.teamId, input.planId)
  if (!plan) return { ok: false, reason: 'not-found', result: undefined, message: `Plan not found in this team: ${input.planId}` }
  if (deps.tasks === undefined || deps.checkpoints === undefined) {
    return { ok: false, reason: 'state', result: undefined, message: 'The resolve needs the task and checkpoint services wired.' }
  }
  // L3 (A3.2): the resolution's pre-transaction git read — origin's branch
  // head for the new startCommit — runs here, outside the transaction, after
  // the replay short-circuit (a replayed resolve returns its recorded
  // outcome and reads nothing). The read is a gather only: K7's refusal is
  // thrown inside `within` at the facts' consumption, where it cannot mask
  // I1/K6 or the stage refusals, and a failed read leaves nothing written.
  // 'adapt' and 'restart' both read (rev4 §10); a review-target restart
  // consumes no head facts, so its gather is spent harmlessly.
  let head: AdaptHeadFacts | null | undefined
  if ((input.choice === 'adapt' || input.choice === 'restart') && deps.adaptHead && deps.plans.eventByCommand(plan.id, input.commandId) === null) {
    const pause = deps.pauses.get(caller.team.teamId, input.pauseId)
    head = pause !== null && pause.planId === plan.id ? await deps.adaptHead(pause.executionId, input.change) : undefined
  }
  try {
    const outcome = deps.planService.recordRevisionControlEvent(plan.id, {
      kind: 'pause-resolved', commandId: input.commandId, pauseId: input.pauseId, change: input.change,
      choice: input.choice, adapt: input.adapt ?? null, rationale: input.rationale, releaseHold: input.releaseHold === true,
    }, () => resolveWithin(deps, caller, input, plan.id, head))
    if (outcome.ok && !outcome.replayed) {
      deps.wake?.(plan.teamId)
      // R2's release step (rev4 §4) runs after the commit: releaseNow
      // archives a session — an external effect that must not run inside
      // the resolve's SQLite transaction. The pending-release row for a
      // busy holder was already written inside it.
      if (input.choice === 'restart') await releaseRestartedHolder(deps, input.pauseId, input.change)
    }
    return outcome
  } catch (error) {
    if (error instanceof ResolveRefusal) {
      return { ok: false, reason: error.code, message: error.message, result: undefined }
    }
    throw error
  }
}

/** Everything `within` writes for one resolve, after the replay; `head` is the pre-transaction git read's gather (undefined when the seam is unwired or the pause is not found). */
function resolveWithin(deps: PauseServiceDeps, caller: PlanCaller & { kind: 'human' }, input: ResolveInput, planId: string, head: AdaptHeadFacts | null | undefined): { target: { change: string; decision: string } } {
  const pause = deps.pauses.get(caller.team.teamId, input.pauseId)
  if (pause === null || pause.planId !== planId) throw new PlanRefusal('not-found', `Pause not found on this plan: ${input.pauseId}`)
  const target = deps.pauses.target(pause.id, input.change)
  if (target === null) throw new PlanRefusal('not-found', `The pause ${pause.id} has no target for change ${input.change}`)
  // I1 first (C1, A1r, R1): a decided target refuses naming its standing
  // decision, even on a pause that decision has already closed — before the
  // choice dispatch, so every choice names it (lead ruling L1, N2).
  if (target.decision !== null) {
    throw new PlanRefusal('state', `Change ${target.change} is already decided (${target.decision}). Nothing was written.`)
  }
  // K6: a closed pause (every target decided, or the execution finished)
  // refuses; Stop is not this command (S2).
  const execution = deps.executions.execution(pause.executionId)
  const finished = execution !== null && execution.state !== 'running'
  if (pause.closedAt !== null || finished) {
    throw new PlanRefusal('state', `The pause ${pause.id} is closed; there is nothing left to resolve. Nothing was written.`)
  }
  // The choice dispatch (N2): Stop lands with its own step (rev4 §10);
  // 'restart' is implemented beside this module (pauseRestart.ts).
  if (input.choice !== 'continue' && input.choice !== 'adapt' && input.choice !== 'restart') {
    throw new PlanRefusal('state', `'${input.choice}' does not resolve yet; only 'continue', 'adapt' and 'restart' are implemented. Nothing was written.`)
  }
  // Withdrawn before the state (C9): 'continue' reads `target-withdrawn`
  // from Paused and Pausing alike, so the answer is the same across the
  // tick. 'adapt' proceeds (A8r — the withdraw recorded Paused; its
  // stop-branch writes below are no-ops on the already-superseded row),
  // and 'restart' proceeds too (R9/R15 — D9's allowed-from extension).
  if (target.withdrawn && input.choice === 'continue') {
    throw new ResolveRefusal('target-withdrawn', `Change ${target.change}'s instruction was withdrawn when the pause was placed; nothing resumes.`)
  }
  // C10 / A9r: still pausing — the executor has not recorded Paused yet.
  // 'restart' skips the state check (rev4 extends the allowed-from): R10-R15
  // resolve a Pausing target from its own causes.
  if (target.pausedAt === null && input.choice !== 'restart') {
    throw new ResolveRefusal('not-paused', `Change ${target.change} is still pausing, not Paused; resolve it once the pause records Paused.`)
  }
  const changeRow = deps.executions.change(pause.executionId, target.change)
  if (changeRow === null) throw new PlanRefusal('not-found', `The execution has no row for change ${target.change}.`)
  if (changeRow.taskId === null) throw new PlanRefusal('state', `Change ${target.change} has no task; a target always names one.`)
  const task = deps.tasks!.store.get(changeRow.taskId)
  if (task === undefined || task === null) throw new PlanRefusal('state', `The task of change ${target.change} is missing.`)
  if (input.choice === 'continue') {
    // C11 (Q-A5): judged from the target's holder and the session records at
    // call time, for review targets exactly as for attempt targets. Adapt
    // never refuses a gone holder (A11r — Q-A7): its publication needs no
    // live holder, and its notices dead-letter at enqueue.
    if (target.holderSession !== null && !deps.sessionExists(target.holderSession)) {
      throw new ResolveRefusal('holder-gone', `The holder of change ${target.change} is gone; the pause names it for your attention instead.`)
    }
    if (target.stage === 'review') return continueReview(deps, caller, input, pause, target, task)
    return continueAttempt(deps, caller, input, pause, target, changeRow, task)
  }
  if (input.choice === 'restart') {
    return restartTarget(deps, caller, input, pause, target, changeRow, task, head)
  }
  // A10r: a review target never adapts — the review's verdict, not a new
  // direction, decides a review.
  if (target.stage === 'review') {
    throw new ResolveRefusal('review-target', `Change ${target.change} is paused in review; adapt the direction after the review resolves, or restart the work instead.`)
  }
  return adaptAttempt(deps, caller, input, pause, target, changeRow, task, head)
}

/** C12-C14: the review target's Continue. The handoff the pause recorded
 *  decides — a superseded one refuses (C13); a passable round pending a task
 *  revision records `revisionPending N` and sends nothing (C14, H5);
 *  otherwise one resume naming the newest revision and the recorded notes'
 *  id, never a commit (C12, D3). Never a drop (H5). */
function continueReview(deps: PauseServiceDeps, caller: PlanCaller & { kind: 'human' }, input: ResolveInput, pause: PlanPause,
  target: PlanPauseTarget, task: { id: string; revision: number }): { target: { change: string; decision: string } } {
  const tasks = deps.tasks!
  const handoff = deps.assignments.listByTask(task.id).find(row => row.id === target.assignmentId)
  if (handoff === undefined || handoff.supersededBy !== null) {
    throw new ResolveRefusal('review-superseded', `The review handoff for change ${target.change} was superseded; dispatch a new review instead of resuming.`)
  }
  const newestRound = deps.executions.rounds(pause.executionId, target.change).at(-1) ?? null
  const pending = newestRound !== null && revisionPending({ tasks }, task.id, newestRound)
  const detail: Record<string, unknown> = { holder: target.holderSession, release: 'never', assignmentId: target.assignmentId }
  if (pending) detail.revisionPending = task.revision
  recordContinue(deps, input, pause, target, detail)
  if (!pending && target.holderSession !== null) {
    const plan = deps.plans.get(pause.planId)!
    const notes = deps.checkpoints!.newest(pause.id, target.change)
    const body = resumeBody(plan, { change: target.change, stage: 'review' }, revisionOf(tasks, task), null, notes?.kind === 'notes' ? notes.id : null)
    enqueueResume(deps, caller, plan, target, task.id, body)
  }
  return { target: { change: target.change, decision: 'continue' } }
}

/** C2-C8, C15-C17: the attempt target's Continue — the ROUND RULE's
 *  conditional supersede, O4's redispatch clear, the decision, one resume.
 *  No attempt row is minted here (I4): an owed row stays owed and dispatches
 *  once via the owed step (C3/C6); a failed round is never superseded (H2). */
function continueAttempt(deps: PauseServiceDeps, caller: PlanCaller & { kind: 'human' }, input: ResolveInput, pause: PlanPause,
  target: PlanPauseTarget, changeRow: ChangeRow, task: { id: string; revision: number }): { target: { change: string; decision: string } } {
  const tasks = deps.tasks!
  const rounds = deps.executions.rounds(pause.executionId, target.change)
  const passable = rounds.filter(round => round.outcome === null || round.outcome === 'pass').at(-1)
  if (passable !== undefined && revisionPending({ tasks }, task.id, passable)) {
    deps.executions.supersedeRound(passable.id)
    // The superseded round's live round-effect rows never run after it.
    deps.executions.cancelLiveRoundEffects(pause.executionId, passable.id)
    const fresh = deps.executions.change(pause.executionId, target.change)
    // The slot-releasing transition: leaving `landing` releases the slot. A
    // paused target never sits in `landing` (those changes are not targets),
    // so this is a guard; a `gating` update target stays gating (C17) — the
    // supersede alone is its drop.
    if (fresh !== null && fresh.state === 'landing') {
      deps.executions.transition(pause.executionId, target.change, fresh, { state: 'implementing', step: null })
    }
  }
  // O4: a pending `redispatch` step clears in the resolution's own
  // transaction — the resume answers the Retry, so no :retry: re-send follows.
  const after = deps.executions.change(pause.executionId, target.change)
  if (after !== null && after.step === 'redispatch') {
    deps.executions.transition(pause.executionId, target.change, after, { step: null })
  }
  recordContinue(deps, input, pause, target, { holder: target.holderSession, release: 'never', assignmentId: target.assignmentId })
  if (target.holderSession !== null) {
    // C2: one normal direct system plan-resume naming the newest revision
    // and the newest checkpoint's commit.
    const plan = deps.plans.get(pause.planId)!
    const checkpoint = deps.checkpoints!.newest(pause.id, target.change)
    const body = resumeBody(plan, { change: target.change, stage: 'attempt' }, revisionOf(tasks, task), checkpoint?.commitSha ?? null, null)
    enqueueResume(deps, caller, plan, target, task.id, body)
  }
  return { target: { change: target.change, decision: 'continue' } }
}

/** The guarded decision write (one per target, the database arbitrates) plus closeIfDecided. */
function recordContinue(deps: PauseServiceDeps, input: ResolveInput, pause: PlanPause, target: PlanPauseTarget, detail: Record<string, unknown>): void {
  recordResolution(deps, input, pause, target, 'continue', detail)
}

/** The guarded decision write, shared with the restart's branches (pauseRestart.ts). */
export function recordResolution(deps: PauseServiceDeps, input: ResolveInput, pause: PlanPause, target: PlanPauseTarget,
  decision: 'continue' | 'adapt' | 'restart', detail: Record<string, unknown>): void {
  const written = deps.pauses.recordDecision({ pauseId: pause.id, change: target.change, decision, detail, commandId: input.commandId.trim() })
  if (!written.written) {
    throw new PlanRefusal('state', `Change ${target.change} was decided while this command ran (${written.target?.decision ?? 'unknown'}). Nothing was written.`)
  }
  deps.pauses.closeIfDecided(pause.id)
}

/**
 * The stop branch (A2r, P-I2): the held instruction's mail cancels only
 * while queued or awaiting-request — a claimed (Paused) holder's mail is
 * never touched — and the assignment supersedes, so it derives `superseded`
 * and §5 cannot accept against it. Both writes are guarded no-ops for the
 * withdrawn target (A8r: already cancelled and superseded at the pause).
 * Shared with the restart's branches (pauseRestart.ts).
 */
export function supersedeHeldAssignment(deps: PauseServiceDeps, pause: PlanPause, target: PlanPauseTarget): void {
  const assignment = deps.assignments.byId(target.assignmentId)
  if (assignment !== null && assignment.messageId !== null) {
    const message = deps.mailbox.get(assignment.messageId)
    if (message !== null && (message.state === 'queued' || message.state === 'awaiting-request')) {
      deps.mailbox.cancel(assignment.messageId, { kind: 'system' }, `the resolution of pause ${pause.id} replaced the instruction`)
    }
  }
  deps.assignments.supersede(target.assignmentId, pause.id)
}

/**
 * A2r-A13r: the attempt target's Adapt. The publication (revision N+1 under
 * `pause:<commandId>`, its notices inside the publication's transaction)
 * lands FIRST, so the paused holder still gets its revision notice before
 * the stop branch supersedes its assignment; then the decision {release
 * 'never'}, every passable round superseded (Adapt always — the ROUND RULE;
 * the failed round never, A6r/H2), the stop-branch supersession, the A13r
 * move to `implementing`, O4's clear, and ONE new kind-`fix` attempt row at
 * revision N+1 (H3: the newest attempt's answers and update copied, its own
 * facts added — the pre-transaction branch head and the newest revision).
 * The dispatch is inline when the gate — read after the decision, so this
 * target no longer closes it — is open, else the row stays owed (H1, H6).
 */
function adaptAttempt(deps: PauseServiceDeps, caller: PlanCaller & { kind: 'human' }, input: ResolveInput, pause: PlanPause,
  target: PlanPauseTarget, changeRow: ChangeRow, task: { id: string; revision: number },
  head: AdaptHeadFacts | null | undefined): { target: { change: string; decision: string } } {
  const tasks = deps.tasks!
  const execution = deps.executions.execution(pause.executionId)
  if (execution === null) throw new PlanRefusal('not-found', `The execution of pause ${pause.id} is missing.`)
  const revision = deps.plans.revision(pause.planId, execution.revision)
  const entry = revision?.content.changes.find(candidate => candidate.change === target.change)
  if (revision === null || revision === undefined || entry === undefined) {
    throw new PlanRefusal('state', `The plan revision of change ${target.change} is missing; nothing was published.`)
  }
  if (tasks.store.notices === null) {
    throw new PlanRefusal('state', 'Revision notices are not available; the adaptation would leave the holder unwritten. Nothing was written.')
  }
  // 1. The publication (A2r): revision N+1 under the command's key, the
  //    notices written inside the publication's transaction.
  const requestKey = `pause:${input.commandId.trim()}`
  const publication = tasks.store.publish(task.id, {
    direction: input.adapt,
    rationale: input.rationale,
    requestKey,
    notify: true,
    within: (next, current) => {
      tasks.store.notices!.write(current, next, {
        requestKey,
        sender: { actor: { kind: 'human', sessionId: null }, fromGroup: null, originPath: caller.team.groupsRoot },
        sessionExists: deps.sessionExists,
      })
    },
  }, { kind: 'human', sessionId: null })
  if (publication === null) throw new PlanRefusal('state', `The task of change ${target.change} is missing.`)
  const taskRevision = publication.revision.revision
  const rationale = publication.revision.rationale ?? null
  // 2. The decision {release 'never'} (A2r): the resolution never releases
  //    the hold; the release step does.
  recordResolution(deps, input, pause, target, 'adapt', { release: 'never', taskRevision })
  // 3. Every passable round superseded — Adapt works from its own N+1, so
  //    the ROUND RULE's condition always holds (A7r, A12r, A13r); the failed
  //    round is never superseded (A6r, H2). The slot-releasing transition
  //    stays state-conditional and unreachable (N4's C15 note): a pause
  //    target never sits in `landing`.
  const passable = deps.executions.rounds(pause.executionId, target.change)
    .filter(round => round.outcome === null || round.outcome === 'pass').at(-1)
  if (passable !== undefined) {
    deps.executions.supersedeRound(passable.id)
    deps.executions.cancelLiveRoundEffects(pause.executionId, passable.id)
    const fresh = deps.executions.change(pause.executionId, target.change)
    if (fresh !== null && fresh.state === 'landing') {
      deps.executions.transition(pause.executionId, target.change, fresh, { state: 'implementing', step: null })
    }
  }
  // 4. The held assignment through the stop branch — after the publication's
  //    notices (A2r, P-I2).
  supersedeHeldAssignment(deps, pause, target)
  // 5. A13r: an update target (gating, its update row out) moves to
  //    `implementing` — the fix row's owed state. O4: a pending `redispatch`
  //    step clears in this same transaction.
  let fresh = deps.executions.change(pause.executionId, target.change)
  if (fresh !== null && fresh.state === 'gating') {
    if (!deps.executions.transition(pause.executionId, target.change, fresh, { state: 'implementing', step: null })) {
      throw new PlanRefusal('state', `Change ${target.change} moved while the resolution ran; nothing was written.`)
    }
    fresh = deps.executions.change(pause.executionId, target.change)
  }
  if (fresh !== null && fresh.step === 'redispatch') {
    deps.executions.transition(pause.executionId, target.change, fresh, { step: null })
    fresh = deps.executions.change(pause.executionId, target.change)
  }
  // 6. ONE new attempt row: kind `fix` (A13r copies the update row's
  //    `answers` and `update` at revision N+1), its own facts added. The
  //    git read itself ran pre-transaction (L3); a failed read refuses
  //    here — after every earlier refusal — as K7 (A3.2), retryable.
  const newest = deps.executions.attempts(pause.executionId, target.change).at(-1) ?? null
  const facts = head ?? null
  if (facts !== null && !facts.ok) {
    throw new ResolveRefusal('head-unreadable', `Change ${target.change}'s pre-transaction read of origin's branch head failed; nothing was written. Resolve again once the git read succeeds.`)
  }
  const startCommit = (facts !== null && facts.ok ? facts.startCommit : newest?.manifest.startCommit ?? changeRow.baselineCommit)
  if (startCommit === null) throw new PlanRefusal('state', `Change ${target.change} has no start commit; nothing was written.`)
  const manifest: AttemptManifest = {
    version: 1,
    plan: { id: execution.planId, revision: execution.revision, contentHash: execution.contentHash },
    execution: execution.id,
    task: { id: task.id, revision: taskRevision },
    validation: { reportId: execution.reportId, inputHash: execution.inputHash },
    baseline: changeRow.baselineCommit ?? '',
    startCommit,
    artifacts: facts !== null && facts.ok ? facts.artifacts : {},
    roleProfiles: revision.content.roles.find(role => role.group === entry.group)?.profiles ?? [],
    ...(newest?.manifest.answers !== undefined ? { answers: newest.manifest.answers } : {}),
    ...(newest?.manifest.update !== undefined ? { update: newest.manifest.update } : {}),
  }
  const manifestHash = createHash('sha256').update(manifestHashInput(manifest)).digest('hex')
  const attempt = deps.executions.insertAttempt({
    executionId: pause.executionId, change: target.change, kind: 'fix', assignmentId: null, manifest, manifestHash,
  })
  // 7. The dispatch (A2r): the gate is read AFTER the decision — this
  //    target no longer closes it; a covering hold or another open target
  //    still does, and the row stays owed for the owed step (H1, H6).
  const holds: ActiveHold[] = deps.holds.active(caller.team.teamId, pause.planId)
    .map(hold => ({ id: hold.id, scope: hold.scope, changes: hold.changes }))
  const openTargets: OpenPauseTarget[] = deps.pauses.forPlan(caller.team.teamId, pause.planId, true).flatMap(open =>
    deps.pauses.targets(open.id).map(row => ({ pauseId: open.id, change: row.change, decision: row.decision })))
  if (deps.assignmentService !== undefined && holdGate(holds, openTargets, target.change) === null) {
    const afterRow = deps.executions.change(pause.executionId, target.change)
    if (afterRow !== null) {
      dispatchAdaptedFixWithin({
        team: caller.team, execution, changeRow: afterRow, entry, content: revision.content,
        planTitle: deps.plans.get(pause.planId)?.title ?? pause.planId,
        taskId: task.id, attempt: { id: attempt.id, number: attempt.number, manifestHash },
        startCommit, taskRevision, rationale,
        executions: deps.executions, assignments: deps.assignmentService,
      })
    }
  }
  return { target: { change: target.change, decision: 'adapt' } }
}

/** The task revision in force, with its newest rationale, for the resume text. */
function revisionOf(tasks: NonNullable<PauseServiceDeps['tasks']>, task: { id: string; revision: number }): { number: number; rationale: string | null } {
  return { number: task.revision, rationale: tasks.store.revisions(task.id).at(-1)?.rationale ?? null }
}

/**
 * R2's after-commit release (rev4 §4): the decision detail recorded the
 * release bookkeeping; a spawned holder it found ready is released here,
 * outside the resolve's transaction (releaseNow archives a session — an
 * external effect a rollback could not undo). A release refused between the
 * decision and this step keeps the work durable with a pending-release row
 * instead; unwired seams never release.
 */
async function releaseRestartedHolder(deps: PauseServiceDeps, pauseId: string, change: string): Promise<void> {
  if (deps.releases === undefined) return
  const target = deps.pauses.target(pauseId, change)
  const detail = target?.decisionDetail as { holder?: unknown; release?: unknown } | undefined
  if (target === null || target === undefined || target.decision !== 'restart') return
  if (detail?.release !== 'now' || typeof detail.holder !== 'string') return
  try {
    await deps.releases.releaseNow(detail.holder, ` paused change ${change} restarted`)
  } catch {
    deps.releases.markPending(detail.holder, `paused change ${change} restarted; the release was refused`)
  }
}

/** The resume mail (C2/C12): one normal direct system message, enqueued inside the caller's transaction. */
function enqueueResume(deps: PauseServiceDeps, caller: PlanCaller & { kind: 'human' }, plan: { id: string; title: string },
  target: Pick<PlanPauseTarget, 'change' | 'stage' | 'holderSession'>, taskId: string, body: string): void {
  const holder = target.holderSession
  if (holder === null) return // U4: a Paused target always names a holder.
  const message = deps.mailbox.enqueue({
    teamId: caller.team.teamId, toKind: 'session', toId: holder, fromKind: 'system', fromSession: null, fromGroup: null,
    originPath: caller.team.groupsRoot, priority: 'normal', tags: [PLAN_RESUME_TAG], body, taskId, actor: 'system',
  })
  if (!deps.sessionExists(holder)) deps.mailbox.deadLetter(message.id, 'killed-recipient')
}




