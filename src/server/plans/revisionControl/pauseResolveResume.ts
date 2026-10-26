// The resolve's resume mail (revision-control 4.4, D9/C2/C12), split from
// pauseResolve.ts so the releaseHold overlay keeps that file under 500
// lines. Pure text and one enqueue helper; no state of its own.
import type { PlanCaller } from '../PlanService'
import type { PauseStage, PlanPauseTarget } from '../../../shared/planRevisionControl'
import type { PauseServiceDeps } from './pauseService'

/** The tag the resume mail carries (D9). */
export const PLAN_RESUME_TAG = 'plan-resume'

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

/** The task revision in force, with its newest rationale, for the resume text. */
export function revisionOf(tasks: NonNullable<PauseServiceDeps['tasks']>, task: { id: string; revision: number }): { number: number; rationale: string | null } {
  return { number: task.revision, rationale: tasks.store.revisions(task.id).at(-1)?.rationale ?? null }
}

/** The resume mail (C2/C12): one normal direct system message, enqueued inside the caller's transaction. */
export function enqueueResume(deps: PauseServiceDeps, caller: PlanCaller & { kind: 'human' }, plan: { id: string; title: string },
  target: Pick<PlanPauseTarget, 'change' | 'stage' | 'holderSession'>, taskId: string, body: string): void {
  const holder = target.holderSession
  if (holder === null) return // U4: a Paused target always names a holder.
  const message = deps.mailbox.enqueue({
    teamId: caller.team.teamId, toKind: 'session', toId: holder, fromKind: 'system', fromSession: null, fromGroup: null,
    originPath: caller.team.groupsRoot, priority: 'normal', tags: [PLAN_RESUME_TAG], body, taskId, actor: 'system',
  })
  if (!deps.sessionExists(holder)) deps.mailbox.deadLetter(message.id, 'killed-recipient')
}
