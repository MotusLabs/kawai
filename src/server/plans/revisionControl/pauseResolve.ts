// The owner's resolve command (revision-control 4.2, design D9; rev4 §1–§2):
// one decision per pause target, recorded as the `pause-resolved` event and
// the target's decision row in one transaction. This skeleton carries
// 'continue' — the decision, H″ O4's clear of a pending redispatch step, the
// H5 drop of a passable round that pends a task revision (no attempt minted
// here; D9's fix mints after the decision), and one normal direct system
// plan-resume mail to the holder. 'adapt' and 'restart' land in their own
// steps; every other choice refuses writing nothing. Refusals inside the
// transaction throw PlanRefusal (§2), so a refused command writes nothing —
// not even the event.
import type { PlanCommandOutcome } from '../planCommands'
import type { ExecutionEventOutcome, PlanCaller } from '../PlanService'
import type { PauseStage } from '../../../shared/planRevisionControl'
import type { PauseServiceDeps } from './pauseService'

/** The tag the resume mail carries (D9). */
export const PLAN_RESUME_TAG = 'plan-resume'

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

/** One committed resolve; `result` is undefined on a replay (D3). */
export type PauseResolveOutcome = ExecutionEventOutcome<{ target: { change: string; decision: string } }>

/**
 * The resume mail's body (D9): the decision, the task revision in force,
 * and — for an attempt target only — the newest checkpoint commit to
 * continue from. A review target is never named a commit.
 */
export function resumeBody(plan: { id: string; title: string }, target: { change: string; stage: PauseStage },
  revision: { number: number; rationale: string | null }, checkpointCommit: string | null): string {
  const lines = [
    `Kawai: the owner resumed change ${target.change} of plan "${plan.title}" (${plan.id}).`,
    `Your work continues on the same task and branch. The task's direction is revision ${revision.number}${revision.rationale ? ` (${revision.rationale})` : ''}.`,
  ]
  if (target.stage === 'attempt' && checkpointCommit !== null) {
    lines.push(`Continue from checkpoint ${checkpointCommit}.`)
  }
  lines.push('Replies to this message are refused.')
  return lines.join('\n')
}

function forbidden(): PlanCommandOutcome & { result: undefined } {
  return { ok: false, reason: 'forbidden', result: undefined, message: 'Only the plan\'s owner may resolve a pause, from the Plans view; no agent tool can.' }
}

/**
 * Pre-oracle stub (task rev 3): the acceptance oracles for 4.4–4.5 are not
 * binding yet, so no resolve behavior exists. The command refuses writing
 * nothing; the implementation lands with its oracle tests once the lead
 * records the oracles as binding.
 */
export function resolvePause(deps: PauseServiceDeps, caller: PlanCaller, input: ResolveInput): PauseResolveOutcome {
  void deps
  void input
  if (caller.kind !== 'human') return forbidden()
  return { ok: false, reason: 'state', result: undefined, message: 'Resolve lands after the acceptance oracles (4.4\u20134.5) bind.' }
}
