// The attempt lifecycle's one enforcement point (plan-revision-apply P4/A7,
// invariants AL and AL2; reviews F1, F6, F7): every field an attempt insert
// or send writes is computed inside the committing transaction from rows it
// re-reads there — the execution, its revision, the change (groupOverride,
// generation), the task, the newest round and the newest attempt. Only the
// revision-independent git facts (start commit, artifacts) and the round's
// own facts (failing checks, findings, update conflict) cross an await. A
// send commits only while the row is the newest, its manifest names the
// execution's revision, and its manifest's role profiles are the ones that
// revision assigns the change's group now; it builds the instruction, the
// target group, allowedProfiles and the request key from those rows. An
// insert that follows git reads appends only while the row, round, and task
// revision it was decided on are still current, and pins the manifest — the
// revision and the route's profiles — at commit. A caller's group is a
// precondition, never written: a send whose caller group differs from the
// re-derived one yields, and the owed step sends the row later. No lease or
// epoch (I4): the rows themselves are the arbiter.
import { createHash } from 'node:crypto'
import { manifestHashInput, type AttemptKind, type AttemptManifest } from '../../../shared/planExecution'
import type { PlanChange, PlanContent } from '../../../shared/plans'
import { effectiveExtraChecks } from '../../../shared/planExecutionGates'
import type { PlanStore } from '../planStore'
import { handoffInstruction } from '../../team/TaskResultService'
import type { AssignmentService } from '../../team/AssignmentService'
import type { SystemCaller } from '../../team/systemCaller'
import type { TaskStore } from '../../team/taskStore'
import type { TeamTask, TeamTaskAssignment } from '../../../shared/teamTasks'
import type { ExecutionStore } from './executionStore'
import type { AttemptRow, ChangeRow, ExecutionRow, RoundRow } from './executionRows'
import { instructionContract, type ImplementInstructionInput } from './instructions'

/** The rows a send re-reads in its transaction, and everything derived from them. */
export interface SendContext {
  execution: ExecutionRow
  content: PlanContent
  entry: PlanChange
  change: ChangeRow & { worktree: string; branch: string; baselineCommit: string; taskId: string }
  task: TeamTask | null
  attempt: AttemptRow
  /** The change's newest round, re-read. */
  round: RoundRow | null
  group: string
  /** `{ allowedProfiles }` when the route restricts profiles, else empty. */
  profiles: { allowedProfiles?: string[] }
  requestKey: string
  /** The instruction fields every kind shares, from these rows; `head` is the caller's. */
  base: (head: string) => ImplementInstructionInput
}

/** The change's route under `content`: a pending Reassign's group, else its override, else the entry's; and that group's role profiles. */
export function routeOf(content: PlanContent, change: Pick<ChangeRow, 'change' | 'groupOverride'>, reassign?: string | null): { group: string; profiles: string[] } | null {
  const group = reassign ?? change.groupOverride ?? content.changes.find(entry => entry.change === change.change)?.group ?? null
  if (group === null) return null
  return { group, profiles: content.roles.find(role => role.group === group)?.profiles ?? [] }
}

const sameList = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((value, index) => value === b[index])

export interface AttemptSendDeps {
  executions: ExecutionStore
  plans: Pick<PlanStore, 'revision' | 'get'>
  tasks: Pick<TaskStore, 'get'>
}

/**
 * Send the attempt through `send` and stamp it, inside one transaction that
 * re-reads every row the payload names (AL2). False, writing nothing, when
 * the execution is not running on the attempt's pinned revision and content
 * hash, does not own the change, the attempt is not the newest row, the
 * change lacks its dispatch facts, the re-derived group is not the caller's
 * `group`, or the manifest's role profiles are not what the revision assigns
 * that group. A stamped row may send again (a Retry's new generation key);
 * its stamp stays the first. A refusal thrown by `send` rolls the
 * transaction back and propagates.
 */
export function commitAttemptSend(deps: AttemptSendDeps, input: { executionId: string; change: string; group?: string; reassign?: string | null }, attemptId: string,
  send: (context: SendContext) => string): boolean {
  return deps.executions.db.transaction(() => {
    const execution = deps.executions.execution(input.executionId)
    const change = deps.executions.change(input.executionId, input.change)
    const attempt = deps.executions.attempts(input.executionId, input.change).at(-1)
    if (execution === null || execution.state !== 'running' || change === null || change.state === 'cancelled' || change.state === 'landed') return false
    if (attempt === undefined || attempt.id !== attemptId) return false
    if (attempt.manifest.plan.revision !== execution.revision || attempt.manifest.plan.contentHash !== execution.contentHash) return false
    const { worktree, branch, baselineCommit, taskId } = change
    if (worktree === null || branch === null || baselineCommit === null || taskId === null) return false
    const content = deps.plans.revision(execution.planId, execution.revision)?.content
    const entry = content?.changes.find(candidate => candidate.change === input.change)
    if (content === undefined || entry === undefined) return false
    const route = routeOf(content, change, input.reassign)
    if (route === null || (input.group !== undefined && input.group !== route.group)) return false
    if (!sameList(attempt.manifest.roleProfiles, route.profiles)) return false
    const task = deps.tasks.get(taskId)
    const planTitle = deps.plans.get(execution.planId)?.title ?? execution.planId
    const context: SendContext = {
      execution, content, entry, change: { ...change, worktree, branch, baselineCommit, taskId }, task, attempt,
      round: deps.executions.rounds(input.executionId, input.change).at(-1) ?? null,
      group: route.group,
      profiles: route.profiles.length > 0 ? { allowedProfiles: route.profiles } : {},
      requestKey: `exec:${input.executionId}:${input.change}:attempt:${attempt.number}:${change.generation}`,
      base: head => ({
        planTitle, revision: execution.revision, change: input.change, worktree, branch, baseline: baselineCommit, head,
        acceptance: [...entry.acceptance, ...content.acceptanceRules],
        extraChecks: effectiveExtraChecks(content, entry).map(check => check.name),
        guidance: entry.guidance, taskId, manifestHash: attempt.manifestHash,
        integrationBranch: execution.landingMode === 'integration-branch' ? execution.baseBranch : null,
        contract: instructionContract(task),
      }),
    }
    deps.executions.setAttemptAssignment(attemptId, send(context))
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
 * is cancelled or landed or has no route, or the newest attempt, the newest
 * round, or the task revision differs from `read`; else the row is inserted
 * with the execution's current revision, content hash, validation report,
 * and the role profiles that revision assigns the change's route now (a
 * pending Reassign's group, else the override, else the entry's).
 */
export function commitAttemptInsert(deps: { executions: ExecutionStore; plans: Pick<PlanStore, 'revision'>; taskRevisionOf: (taskId: string) => number | null },
  input: { executionId: string; change: string; kind: AttemptKind; reassign?: string | null }, read: AttemptInsertRead, facts: AttemptInsertFacts,
): { id: string; number: number; manifestHash: string } | null {
  return deps.executions.db.transaction(() => {
    const execution = deps.executions.execution(input.executionId)
    const change = deps.executions.change(input.executionId, input.change)
    if (execution === null || change === null || change.state === 'cancelled' || change.state === 'landed') return null
    if ((deps.executions.attempts(input.executionId, input.change).at(-1)?.id ?? null) !== read.newestId) return null
    if ((deps.executions.rounds(input.executionId, input.change).at(-1)?.id ?? null) !== read.roundId) return null
    if (deps.taskRevisionOf(facts.taskId) !== read.taskRevision) return null
    const content = deps.plans.revision(execution.planId, execution.revision)?.content
    const route = content === undefined ? null : routeOf(content, change, input.reassign)
    if (route === null) return null
    const { taskId, ...rest } = facts
    const manifest: AttemptManifest = {
      version: 1,
      plan: { id: execution.planId, revision: execution.revision, contentHash: execution.contentHash },
      execution: input.executionId,
      task: { id: taskId, revision: read.taskRevision },
      validation: { reportId: execution.reportId, inputHash: execution.inputHash },
      baseline: rest.baseline, startCommit: rest.startCommit, artifacts: rest.artifacts,
      roleProfiles: route.profiles,
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
