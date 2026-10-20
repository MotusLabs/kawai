// Where a decision card belongs (plan-supervision design D4), resolved from
// the asking session — never from a task id the caller supplies, so nobody
// attaches a card to someone else's work:
// 1. a task linked to a plan: that plan, the task's change, and the revision
//    the task works from (its Kawai execution's, else the current approved);
// 2. a fix or correction task (`plan_fix_tasks`): that plan, no change;
// 3. else the Lead role naming `plan_id`: no task, no change, no revision.
// Anything else is refused with D4's message; another team's plan reads as
// not found. `leadOf` reads the Lead role off the current approved revision.
import type { Database } from 'bun:sqlite'
import type { ChatSessionRecord } from '../../db'
import type { Plan } from '../../../shared/plans'
import type { PlanStore } from '../planStore'
import type { TaskStore } from '../../team/taskStore'
import type { DecisionStore } from './decisionStore'
import { DecisionRefusal } from './decisionInputs'

export const NEEDS_PLAN_WORK = 'decision_ask needs plan work: a task linked to a plan, a plan\'s fix or correction task, or the Lead role naming plan_id'

export interface CardScope {
  plan: Plan
  revision: number | null
  change: string | null
  taskId: string | null
}

export interface ScopeDeps {
  db: Database
  plans: PlanStore
  taskStore: TaskStore
  decisions: DecisionStore
}

/** The current approved revision's Lead group, or null. */
export function leadOf(plans: PlanStore, planId: string): string | null {
  return plans.approvedRevision(planId)?.content.leadGroup ?? null
}

/** A plan of the team, or a not-found refusal. */
export function teamPlan(plans: PlanStore, teamId: string, planId: string): Plan {
  const plan = plans.forTeam(teamId, planId)
  if (!plan) throw new DecisionRefusal('not-found', `Plan not found in this team: ${planId}`)
  return plan
}

/** The revision a Kawai execution task works from: its newest execution's. */
function executionRevision(db: Database, taskId: string): number | null {
  const row = db.prepare(`SELECT e.revision AS revision FROM plan_execution_changes c JOIN plan_executions e ON e.id = c.execution_id
    WHERE c.task_id = ? ORDER BY e.started_at DESC, e.rowid DESC LIMIT 1`).get(taskId) as { revision: number } | null
  return row?.revision ?? null
}

function refuseOtherPlan(own: string, taskId: string, planId: string | undefined) {
  if (planId && planId !== own) {
    throw new DecisionRefusal('invalid', `This session works on task ${taskId} of plan ${own}; plan_id ${planId} names another plan. Omit plan_id or name ${own}.`)
  }
}

export function cardScope(deps: ScopeDeps, teamId: string, session: ChatSessionRecord, planId: string | undefined): CardScope {
  const task = session.taskId ? deps.taskStore.get(session.taskId) : null
  if (task && task.teamId === teamId) {
    if (task.planId) {
      refuseOtherPlan(task.planId, task.id, planId)
      const plan = teamPlan(deps.plans, teamId, task.planId)
      return { plan, revision: executionRevision(deps.db, task.id) ?? plan.currentApprovedRevision, change: task.planChange ?? null, taskId: task.id }
    }
    const fix = deps.decisions.fixTask(teamId, task.id)
    if (fix) {
      refuseOtherPlan(fix.planId, task.id, planId)
      const plan = teamPlan(deps.plans, teamId, fix.planId)
      return { plan, revision: plan.currentApprovedRevision, change: null, taskId: task.id }
    }
  }
  if (planId) {
    const plan = teamPlan(deps.plans, teamId, planId)
    const lead = leadOf(deps.plans, plan.id)
    if (lead !== null && session.groupId === lead) return { plan, revision: null, change: null, taskId: null }
  }
  throw new DecisionRefusal('forbidden', NEEDS_PLAN_WORK)
}
