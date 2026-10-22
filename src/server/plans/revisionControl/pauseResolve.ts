// The owner's resolve command (revision-control 4.4-4.5, design D9 + A3's
// C-rows): one decision per pause target, recorded as the `pause-resolved`
// event and the target's decision row in one transaction. This step
// implements 'continue' (C1-C17). The checks run in order: decided (I1,
// naming the standing decision even on a closed pause), closed pause (K6),
// withdrawn before the state (C9), not-paused (C10), holder-gone (C11),
// then the stage branch. An attempt target takes C2's
// shape: the decision {holder, release 'never', assignmentId}, the ROUND
// RULE's conditional supersede of the newest passable round (supersedeRound
// + cancelLiveRoundEffects + the slot-releasing transition), O4's clear of a
// pending `redispatch` step, and one normal direct system plan-resume naming
// the newest revision and the newest checkpoint's commit. A review target
// takes C12-C14: a superseded handoff refuses (C13); a passable round
// pending a task revision records `revisionPending N` and sends nothing
// (C14, H5); otherwise the resume names the newest revision and the recorded
// notes' id, never a commit (C12, D3). No attempt row is minted here (I4) —
// D9's own stage mints after the decision. 'adapt', 'restart' and Stop land
// in their own steps and refuse writing nothing until then. Refusals inside
// the transaction throw (§2) — PlanRefusal for the K-level reasons, the
// ResolveRefusal codes below — so a refused command writes nothing, not even
// the event.
import { PlanRefusal } from '../planCommands'
import type { ExecutionEventOutcome, PlanCaller } from '../PlanService'
import type { PauseStage } from '../../../shared/planRevisionControl'
import { revisionPending } from '../execution/executionRounds'
import type { ChangeRow } from '../execution/executionRows'
import type { PlanPause, PlanPauseTarget } from '../../../shared/planRevisionControl'
import type { PauseServiceDeps } from './pauseService'

/** The tag the resume mail carries (D9). */
export const PLAN_RESUME_TAG = 'plan-resume'

/**
 * The resolve's own refusal codes (the checkpointTool precedent): thrown
 * inside the transaction so nothing is written, returned as the outcome's
 * reason. `review-target` belongs to adapt (A10r) and lands with its step.
 */
export type ResolveRefusalCode = 'target-withdrawn' | 'not-paused' | 'holder-gone' | 'review-superseded' | 'review-target'

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
export function resolvePause(deps: PauseServiceDeps, caller: PlanCaller, input: ResolveInput): PauseResolveOutcome {
  if (caller.kind !== 'human') return forbidden()
  const plan = deps.plans.forTeam(caller.team.teamId, input.planId)
  if (!plan) return { ok: false, reason: 'not-found', result: undefined, message: `Plan not found in this team: ${input.planId}` }
  if (deps.tasks === undefined || deps.checkpoints === undefined) {
    return { ok: false, reason: 'state', result: undefined, message: 'The resolve needs the task and checkpoint services wired.' }
  }
  try {
    const outcome = deps.planService.recordRevisionControlEvent(plan.id, {
      kind: 'pause-resolved', commandId: input.commandId, pauseId: input.pauseId, change: input.change,
      choice: input.choice, adapt: input.adapt ?? null, rationale: input.rationale, releaseHold: input.releaseHold === true,
    }, () => resolveWithin(deps, caller, input, plan.id))
    if (outcome.ok && !outcome.replayed) deps.wake?.(plan.teamId)
    return outcome
  } catch (error) {
    if (error instanceof ResolveRefusal) {
      return { ok: false, reason: error.code, message: error.message, result: undefined }
    }
    throw error
  }
}

/** Everything `within` writes for one resolve, after the replay. */
function resolveWithin(deps: PauseServiceDeps, caller: PlanCaller & { kind: 'human' }, input: ResolveInput, planId: string): { target: { change: string; decision: string } } {
  const pause = deps.pauses.get(caller.team.teamId, input.pauseId)
  if (pause === null || pause.planId !== planId) throw new PlanRefusal('not-found', `Pause not found on this plan: ${input.pauseId}`)
  const target = deps.pauses.target(pause.id, input.change)
  if (target === null) throw new PlanRefusal('not-found', `The pause ${pause.id} has no target for change ${input.change}`)
  if (input.choice !== 'continue') {
    // Only 'continue' resolves in this step; adapt, restart and Stop land
    // with their own ones (rev4 §10).
    throw new PlanRefusal('state', `'${input.choice}' does not resolve yet; only 'continue' is implemented. Nothing was written.`)
  }
  // I1 first (C1): a decided target refuses naming its standing decision,
  // even on a pause that decision has already closed.
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
  // Withdrawn is checked before the state, so the answer is the same across
  // the tick (C9): it reads `target-withdrawn` from Paused and Pausing alike.
  if (target.withdrawn) {
    throw new ResolveRefusal('target-withdrawn', `Change ${target.change}'s instruction was withdrawn when the pause was placed; nothing resumes.`)
  }
  // C10: still pausing — the executor has not recorded Paused yet.
  if (target.pausedAt === null) {
    throw new ResolveRefusal('not-paused', `Change ${target.change} is still pausing, not Paused; resolve it once the pause records Paused.`)
  }
  // C11 (Q-A5): judged from the target's holder and the session records at
  // call time, for review targets exactly as for attempt targets.
  if (target.holderSession !== null && !deps.sessionExists(target.holderSession)) {
    throw new ResolveRefusal('holder-gone', `The holder of change ${target.change} is gone; the pause names it for your attention instead.`)
  }
  const changeRow = deps.executions.change(pause.executionId, target.change)
  if (changeRow === null) throw new PlanRefusal('not-found', `The execution has no row for change ${target.change}.`)
  if (changeRow.taskId === null) throw new PlanRefusal('state', `Change ${target.change} has no task; a target always names one.`)
  const task = deps.tasks!.store.get(changeRow.taskId)
  if (task === undefined || task === null) throw new PlanRefusal('state', `The task of change ${target.change} is missing.`)
  if (target.stage === 'review') return continueReview(deps, caller, input, pause, target, task)
  return continueAttempt(deps, caller, input, pause, target, changeRow, task)
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
  const decision = deps.pauses.recordDecision({ pauseId: pause.id, change: target.change, decision: 'continue', detail, commandId: input.commandId.trim() })
  if (!decision.written) {
    throw new PlanRefusal('state', `Change ${target.change} was decided while this command ran (${decision.target?.decision ?? 'unknown'}). Nothing was written.`)
  }
  deps.pauses.closeIfDecided(pause.id)
}

/** The task revision in force, with its newest rationale, for the resume text. */
function revisionOf(tasks: NonNullable<PauseServiceDeps['tasks']>, task: { id: string; revision: number }): { number: number; rationale: string | null } {
  return { number: task.revision, rationale: tasks.store.revisions(task.id).at(-1)?.rationale ?? null }
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




