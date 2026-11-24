// The durable send of an attempt row (plan-revision-apply P4/A7, review F1).
// A row's manifest names the revision current when it was minted; its
// assignment may commit only while that is still the execution's revision.
// The guard, the synchronous dispatch, and the stamp run in one transaction,
// so no await separates them: an Apply that commits first leaves the row
// unsent, and the next pass's owed step mints its successor at the current
// revision (DC1, owedSuccessor.ts) and sends that once. No lease or epoch
// (I4): the execution row itself is the arbiter.
import { handoffInstruction } from '../../team/TaskResultService'
import type { AssignmentService } from '../../team/AssignmentService'
import type { SystemCaller } from '../../team/systemCaller'
import type { TaskStore } from '../../team/taskStore'
import type { TeamTaskAssignment } from '../../../shared/teamTasks'
import type { ExecutionStore } from './executionStore'

/**
 * Send the attempt through `send` and stamp it, inside one transaction that
 * first checks the execution still runs on the attempt's pinned revision and
 * content hash, still owns the change, and the attempt is still the change's
 * newest row. False when it was not: nothing is written. A stamped row may
 * send again (a Retry's new generation key); its stamp stays the first. A
 * refusal thrown by `send` rolls the transaction back and propagates.
 */
export function commitAttemptSend(executions: ExecutionStore, input: { executionId: string; change: string }, attemptId: string,
  send: () => string): boolean {
  return executions.db.transaction(() => {
    const execution = executions.execution(input.executionId)
    const change = executions.change(input.executionId, input.change)
    const newest = executions.attempts(input.executionId, input.change).at(-1)
    if (execution === null || execution.state !== 'running' || change === null || change.state === 'cancelled' || change.state === 'landed') return false
    if (newest === undefined || newest.id !== attemptId) return false
    if (newest.manifest.plan.revision !== execution.revision || newest.manifest.plan.contentHash !== execution.contentHash) return false
    executions.setAttemptAssignment(attemptId, send())
    return true
  })()
}

/**
 * Kawai's fix handoff committed synchronously: the same assignment row,
 * instruction text, and request-key payload `TaskResultService.handoff`
 * writes for a system caller with no worker choice (the cross-model filter
 * applies to review handoffs only), through the group dispatch that runs
 * inside the caller's transaction.
 */
export function fixHandoffWithin(deps: { assignments: Pick<AssignmentService, 'dispatchWithin'>; store: TaskStore }, caller: SystemCaller, taskId: string, request: {
  resultId: string; group: string; instructions: string; requestKey: string; allowedProfiles?: string[]
}): TeamTaskAssignment {
  const result = deps.store.results.get(request.resultId)
  if (!result || result.taskId !== taskId) throw new Error(`Result ${request.resultId} is not a result of task ${taskId}`)
  const instructions = request.instructions.trim()
  if (!instructions) throw new Error('A handoff needs instructions')
  return deps.assignments.dispatchWithin(caller, {
    taskId, target: { kind: 'group', id: request.group },
    instruction: handoffInstruction('fix', result, instructions, null),
    requestKey: request.requestKey,
    handoff: { kind: 'fix', resultId: result.id, expectedResponse: null },
    ...(request.allowedProfiles ? { allowedProfiles: request.allowedProfiles } : {}),
  }).assignment
}
