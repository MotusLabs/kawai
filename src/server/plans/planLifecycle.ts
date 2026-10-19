// Human withdrawal and closing (durable-plans design D7/D8), split from
// PlanService. Each command replays by command id over its compared payload
// (`planCommands.ts`) and records one append-only event. Withdrawal marks an
// in-review revision `withdrawn` (approved and superseded ones cannot be
// withdrawn) or discards a draft, recording its id and last hash. Closing
// stores only the lifecycle: complete needs an approved revision, plus a
// reason while any of its changes is not done; cancel always needs a
// reason; reopen returns either closed state to `open`. None of them touches
// a linked task, a revision's content, or a draft beyond the one discarded.
import type { PlanEvent } from '../../shared/plans'
import { planProgress } from '../../shared/plans'
import type { PlanStore } from './planStore'
import { PlanRefusal, requireCommandId, runPlanCommand, type PlanCommandOutcome } from './planCommands'

export interface PlanWithdrawInput {
  planId: string
  /** Exactly one of `revision` and `draftId`. */
  revision?: number
  draftId?: string
  commandId: string
}

export interface PlanCloseInput {
  planId: string
  outcome: 'completed' | 'cancelled'
  reason?: string | null
  commandId: string
}

const HUMAN = { kind: 'human' as const, sessionId: null }

function resolve(store: PlanStore, teamId: string, planId: string, commandId: unknown): { planId: string; commandId: string } | PlanCommandOutcome {
  const id = requireCommandId(commandId)
  if (typeof id !== 'string') return id
  const plan = store.forTeam(teamId, planId)
  if (!plan) return { ok: false, reason: 'not-found', message: `Plan not found in this team: ${planId}` }
  return { planId: plan.id, commandId: id }
}

export function withdrawPlan(store: PlanStore, teamId: string, input: PlanWithdrawInput): PlanCommandOutcome {
  const target = resolve(store, teamId, input.planId, input.commandId)
  if ('ok' in target) return target
  const { planId, commandId } = target
  if ((input.revision === undefined) === (input.draftId === undefined)) {
    return { ok: false, reason: 'invalid', message: 'Withdraw names either a revision or a draft id.' }
  }
  if (input.draftId !== undefined) {
    const draftId = input.draftId
    const payload = { command: 'withdraw' as const, draftId }
    return runPlanCommand(store, planId, commandId, payload, (): PlanEvent => {
      const draft = store.getDraft(planId, draftId)
      if (!draft) throw new PlanRefusal('state', `Draft "${draftId}" does not exist on this plan (it may already be discarded).`)
      store.deleteDraft(planId, draftId)
      store.touch(planId)
      return store.insertEvent(planId, { kind: 'draft-discarded', contentHash: draft.contentHash, actor: HUMAN, commandId, payload })
    })
  }
  const revisionNumber = input.revision!
  const payload = { command: 'withdraw' as const, revision: revisionNumber }
  return runPlanCommand(store, planId, commandId, payload, (): PlanEvent => {
    const revision = store.revision(planId, revisionNumber)
    if (!revision) throw new PlanRefusal('state', `Revision ${revisionNumber} does not exist.`)
    if (revision.status !== 'in_review') {
      throw new PlanRefusal('state', `Revision ${revisionNumber} is ${revision.status}; only a revision in review can be withdrawn.`)
    }
    store.setRevisionStatus(planId, revisionNumber, 'withdrawn')
    store.touch(planId)
    return store.insertEvent(planId, { kind: 'withdrawn', revision: revisionNumber, contentHash: revision.contentHash, actor: HUMAN, commandId, payload })
  })
}

export function closePlan(store: PlanStore, teamId: string, input: PlanCloseInput): PlanCommandOutcome {
  const target = resolve(store, teamId, input.planId, input.commandId)
  if ('ok' in target) return target
  const { planId, commandId } = target
  if (input.outcome !== 'completed' && input.outcome !== 'cancelled') {
    return { ok: false, reason: 'invalid', message: `Unknown close outcome: ${String(input.outcome)}` }
  }
  // Compared after the same trimming the event stores, so a resend replays (D7).
  const reason = input.reason?.trim() || null
  const payload = { command: 'close' as const, outcome: input.outcome, reason }
  return runPlanCommand(store, planId, commandId, payload, (): PlanEvent => {
    const plan = store.get(planId)!
    if (plan.lifecycle !== 'open') throw new PlanRefusal('state', `The plan is already ${plan.lifecycle}.`)
    if (input.outcome === 'cancelled' && !reason) {
      throw new PlanRefusal('invalid', 'Cancelling a plan needs a reason.')
    }
    if (input.outcome === 'completed') {
      const approved = store.approvedRevision(planId)
      if (!approved) throw new PlanRefusal('state', 'Completing a plan needs an approved revision.')
      const unfinished = planProgress(approved.content, store.linkedTasks(planId)).changes.filter(change => change.status !== 'done')
      if (unfinished.length > 0 && !reason) {
        throw new PlanRefusal('invalid', `Changes not done: ${unfinished.map(change => change.change).join(', ')}. Completing anyway needs a reason.`)
      }
    }
    store.setLifecycle(planId, input.outcome)
    return store.insertEvent(planId, { kind: input.outcome, actor: HUMAN, reason, commandId, payload })
  })
}

/**
 * Reopen a closed plan. `within` (plan-supervision D6: an override reopening
 * a completed plan) runs after the event in the same transaction, so its
 * writes and the reopen commit or roll back together; a replay never runs it.
 */
export function reopenPlan(store: PlanStore, teamId: string, input: { planId: string; commandId: string }, within?: () => void): PlanCommandOutcome {
  const target = resolve(store, teamId, input.planId, input.commandId)
  if ('ok' in target) return target
  const { planId, commandId } = target
  const payload = { command: 'reopen' as const }
  return runPlanCommand(store, planId, commandId, payload, (): PlanEvent => {
    const plan = store.get(planId)!
    if (plan.lifecycle === 'open') throw new PlanRefusal('state', 'The plan is already open.')
    store.setLifecycle(planId, 'open')
    const event = store.insertEvent(planId, { kind: 'reopened', actor: HUMAN, commandId, payload })
    within?.()
    return event
  })
}
