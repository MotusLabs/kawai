// Execution completion (plan-execution D19, read under plan-revision-apply
// D4): a running execution completes when every change of its *current*
// revision has landed — the revision Apply advanced it to, not Start's.
// Changes an Apply removed are cancelled rows outside that content and are
// not counted; a change of the content that is cancelled (or has no row)
// keeps the execution running. Then the plan completes as the system when
// that revision is still the plan's current approved one (`completeBySystem`
// refuses otherwise and the plan stays open). Called after every landing
// fact and after an Apply commits — an Apply that removes the last unlanded
// change completes the run without any landing.
import { logger } from '../../logger'
import type { PlanService } from '../PlanService'
import type { PlanStore } from '../planStore'
import type { ExecutionStore } from './executionStore'

export interface CompletionDeps {
  executions: ExecutionStore
  plans: PlanStore
  plansService: PlanService
}

/** Whether every change of the execution's current revision has landed. */
export function currentRevisionLanded(deps: Pick<CompletionDeps, 'executions' | 'plans'>, executionId: string): boolean {
  const execution = deps.executions.execution(executionId)
  if (execution === null) return false
  const content = deps.plans.revision(execution.planId, execution.revision)?.content ?? null
  if (content === null || content.changes.length === 0) return false
  const rows = new Map(deps.executions.changes(executionId).map(row => [row.change, row]))
  return content.changes.every(entry => rows.get(entry.change)?.state === 'landed')
}

/** Completes a running execution whose current revision has fully landed, then the plan as the system. */
export function completeIfLanded(deps: CompletionDeps, executionId: string): boolean {
  const execution = deps.executions.execution(executionId)
  if (execution === null || execution.state !== 'running') return false
  if (!currentRevisionLanded(deps, executionId)) return false
  if (!deps.executions.finishExecution(executionId, 'completed')) return false
  const completed = deps.plansService.completeBySystem(execution.planId, executionId)
  if (!completed.ok) logger.info('plan_execution_plan_left_open', { executionId, reason: completed.reason, message: completed.message })
  return true
}
