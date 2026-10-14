// The plan-change link on tasks (durable-plans design D9, contract C5): a
// task may name, at creation, a plan of its team and one change of that
// plan's current approved revision — both or neither. Checked with the
// task's other references, before anything is written; the link is
// immutable afterwards. Another team's plan reads exactly like an unknown id.
import type { PlanStore } from './planStore'

export interface PlanLink {
  planId: string
  planChange: string
}

/** The validated link, null when neither half is given; throws naming the bad reference. */
export function resolvePlanLink(plans: PlanStore | undefined, teamId: string, planId?: string | null, planChange?: string | null): PlanLink | null {
  const id = planId?.trim() || ''
  const change = planChange?.trim() || ''
  if (!id && !change) return null
  if (!id || !change) throw new Error('A plan link needs both plan_id and plan_change (or neither).')
  const plan = plans?.forTeam(teamId, id)
  if (!plan) throw new Error(`Plan not found in this team: ${id}`)
  if (plan.lifecycle !== 'open') throw new Error(`Plan "${plan.title}" (${plan.id}) is ${plan.lifecycle}; only an open plan takes new tasks.`)
  const approved = plans!.approvedRevision(plan.id)
  if (!approved) throw new Error(`Plan "${plan.title}" (${plan.id}) has no approved revision; tasks link to the changes of an approved revision.`)
  if (!approved.content.changes.some(entry => entry.change === change)) {
    const names = approved.content.changes.map(entry => entry.change).join(', ')
    throw new Error(`Change "${change}" is not in plan "${plan.title}" revision ${approved.revision} (its changes: ${names}).`)
  }
  return { planId: plan.id, planChange: change }
}
