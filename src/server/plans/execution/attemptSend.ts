// The attempt lifecycle's one enforcement point (plan-revision-apply P4/A7,
// invariant AL; reviews F1 and F6): an attempt row is inserted or sent only
// in one transaction that re-reads the execution, the change, its newest
// attempt and round, and the task revision — never on state read before an
// await. A send commits only while the row is the newest and its manifest
// names the execution's revision; an Apply that commits first leaves it
// unsent, and the owed step's successor (DC1, owedSuccessor.ts) goes once.
// An insert that follows git reads appends only while the row, round, and
// task revision it was decided on are still current — a row an Apply
// minted (Restart's, Adapt's) or a direction it republished wins — and pins
// the manifest to the execution's revision at commit. No lease or epoch
// (I4): the execution row itself is the arbiter.
import { createHash } from 'node:crypto'
import { manifestHashInput, type AttemptKind, type AttemptManifest } from '../../../shared/planExecution'
import type { PlanStore } from '../planStore'
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

/** What an insert after awaits read first: the newest attempt, the newest round, and the task's revision. */
export interface AttemptInsertRead { newestId: string | null; roundId: string | null; taskRevision: number }

/** The manifest's facts gathered before the transaction (git reads); the pins are taken at commit. */
export type AttemptInsertFacts = Pick<AttemptManifest, 'baseline' | 'startCommit' | 'artifacts' | 'answers' | 'update'> & { taskId: string }

/**
 * Insert an attempt row whose facts were gathered across awaits. One
 * transaction: null, writing nothing, when the execution is gone, the change
 * is cancelled or landed, or the newest attempt, the newest round, or the
 * task revision differs from `read`; else the row is inserted with the
 * execution's current revision, content hash, validation report, and the
 * current revision's role profiles for `group`.
 */
export function commitAttemptInsert(deps: { executions: ExecutionStore; plans: Pick<PlanStore, 'revision'>; taskRevisionOf: (taskId: string) => number | null },
  input: { executionId: string; change: string; group: string; kind: AttemptKind }, read: AttemptInsertRead, facts: AttemptInsertFacts,
): { id: string; number: number; manifestHash: string } | null {
  return deps.executions.db.transaction(() => {
    const execution = deps.executions.execution(input.executionId)
    const change = deps.executions.change(input.executionId, input.change)
    if (execution === null || change === null || change.state === 'cancelled' || change.state === 'landed') return null
    if ((deps.executions.attempts(input.executionId, input.change).at(-1)?.id ?? null) !== read.newestId) return null
    if ((deps.executions.rounds(input.executionId, input.change).at(-1)?.id ?? null) !== read.roundId) return null
    if (deps.taskRevisionOf(facts.taskId) !== read.taskRevision) return null
    const revision = deps.plans.revision(execution.planId, execution.revision)
    const { taskId, ...rest } = facts
    const manifest: AttemptManifest = {
      version: 1,
      plan: { id: execution.planId, revision: execution.revision, contentHash: execution.contentHash },
      execution: input.executionId,
      task: { id: taskId, revision: read.taskRevision },
      validation: { reportId: execution.reportId, inputHash: execution.inputHash },
      baseline: rest.baseline, startCommit: rest.startCommit, artifacts: rest.artifacts,
      roleProfiles: revision?.content.roles.find(role => role.group === input.group)?.profiles ?? [],
      ...(rest.answers !== undefined ? { answers: rest.answers } : {}),
      ...(rest.update !== undefined ? { update: rest.update } : {}),
    }
    const manifestHash = createHash('sha256').update(manifestHashInput(manifest)).digest('hex')
    const attempt = deps.executions.insertAttempt({ executionId: input.executionId, change: input.change, kind: input.kind, assignmentId: null, manifest, manifestHash })
    return { id: attempt.id, number: attempt.number, manifestHash }
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
