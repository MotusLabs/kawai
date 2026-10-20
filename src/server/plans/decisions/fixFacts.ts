// The plan facts a fix or correction task's status and completion read
// (plan-supervision design D8, D13): every revision with its content, the
// current approved revision, the team's executions of the plan, and every
// landing fact. One builder, so the detail's fix status and the monitor's
// completion judge a task by the same rule (`fixLandings`). Reads only.
import type { FixPlanFacts } from '../../../shared/planDecisions'
import type { Plan } from '../../../shared/plans'
import type { ExecutionStore } from '../execution/executionStore'
import type { PlanStore } from '../planStore'

export interface FixFactReads {
  plans: Pick<PlanStore, 'revisions'>
  executions: Pick<ExecutionStore, 'executionsOf' | 'landings'>
}

export function fixPlanFacts(reads: FixFactReads, teamId: string, plan: Pick<Plan, 'id' | 'currentApprovedRevision'>): FixPlanFacts {
  return {
    revisions: reads.plans.revisions(plan.id).map(revision => ({ revision: revision.revision, status: revision.status, content: revision.content })),
    currentApprovedRevision: plan.currentApprovedRevision,
    executions: reads.executions.executionsOf(plan.id).filter(row => row.teamId === teamId).map(row => ({ id: row.id, revision: row.revision, state: row.state })),
    landings: reads.executions.landings(plan.id).map(row => ({ change: row.change, executionId: row.executionId, mergeSha: row.mergeSha, landedAt: row.landedAt, treeVerified: row.treeVerified })),
  }
}
