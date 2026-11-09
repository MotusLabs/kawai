// Re-gate a refuted review (review-findings-ledger D8, table RG). When the
// change's newest round failed on its review alone, every finding it failed
// on (the round's recorded `blockingIds`) now reads rejected by a decision,
// nothing blocks or is disputed, the round's result is the change's newest
// and pinned to the task's current revision, and the fix attempt answering
// that round is still out, Kawai gates the same result again: one passing
// round with the failed round's commit, CI, review, and verdict, answering
// the fix attempt. In the same transaction the change moves back to gating
// as passed (the fix count resets), the fix handoff is superseded by the
// new round, the implementer is mailed, and the task journals it.
// `regate_of` is UNIQUE, so the step runs at most once; a crash before the
// commit leaves nothing and the next tick (or the startup tick) re-runs it.
import { blocking, foldLedger, pendingDisputes, type LedgerRow } from '../../../shared/findingsLedger'
import type { MailboxStore } from '../../team/mailboxStore'
import type { TaskStore } from '../../team/taskStore'
import type { TeamIdentity } from '../../team/teamIdentity'
import { SYSTEM_ACTOR } from '../../../shared/team'
import { attemptStatus, type AttemptStatus } from './attemptStatus'
import type { ChangeRow, RoundRow } from './executionRows'
import type { ExecutionStore } from './executionStore'

/** The facts table RG reads, gathered from the rows now. */
export interface RegateFacts {
  newest: Pick<RoundRow, 'id' | 'outcome' | 'resultId' | 'blockingIds'> | null
  alreadyRegated: boolean
  newestResultId: string | null
  resultRevision: number | null
  taskRevision: number
  ledger: readonly LedgerRow[]
  fixAttempt: { status: AttemptStatus; answersRound: string | null } | null
}

/** Table RG: why the newest round is not re-gated, or null when it is (RG1). */
export function regateRefusal(facts: RegateFacts): string | null {
  const { newest } = facts
  if (newest === null || newest.outcome !== 'fail') return 'the newest round did not fail' // RG7
  if (facts.alreadyRegated) return 'the round was already re-gated' // RG6
  // Only decideVerdict's structured review failure records blockingIds: a
  // CI failure (decided before any review) and a text verdict leave it null.
  if (newest.blockingIds === null) return 'the round did not fail on a structured review' // RG4
  if (facts.newestResultId !== newest.resultId) return 'a newer result gates' // RG3
  if (facts.resultRevision !== facts.taskRevision) return 'its result is pinned to an older revision' // RG9
  if (blocking(facts.ledger).length > 0) return 'a finding blocks' // RG5
  if (pendingDisputes(facts.ledger).length > 0) return 'a dispute is undecided' // RG2
  const rows = new Map(facts.ledger.map(row => [row.id, row]))
  const unrefuted = newest.blockingIds.filter(id => rows.get(id)?.state !== 'rejected')
  if (newest.blockingIds.length === 0 || unrefuted.length > 0) return `not refuted: ${unrefuted.join(', ') || 'no blocker recorded'}` // RG8
  if (facts.fixAttempt === null || facts.fixAttempt.status === 'answered' || facts.fixAttempt.answersRound !== newest.id) {
    return 'no fix attempt of the round is out' // RG10
  }
  return null
}

export interface RegateDeps {
  team: TeamIdentity
  executions: ExecutionStore
  tasks: TaskStore
  mail: Pick<MailboxStore, 'enqueue' | 'get' | 'cancel'>
  now: () => Date
  /** A test seam: called inside the transaction after the round's insert (a crash there rolls everything back). */
  afterInsert?: () => void
}

/** The facts of one change, read now. */
export function regateFacts(deps: Pick<RegateDeps, 'executions' | 'tasks'>, change: ChangeRow): RegateFacts | null {
  if (change.taskId === null) return null
  const task = deps.tasks.get(change.taskId)
  if (!task) return null
  const rounds = deps.executions.rounds(change.executionId, change.change)
  const newest = rounds.at(-1) ?? null
  const attempt = deps.executions.attempts(change.executionId, change.change).at(-1) ?? null
  const result = newest ? deps.tasks.results.get(newest.resultId) : null
  return {
    newest,
    alreadyRegated: newest !== null && rounds.some(round => round.regateOf === newest.id),
    newestResultId: deps.tasks.results.listByTask(change.taskId).at(-1)?.id ?? null,
    resultRevision: result?.taskRevision ?? null,
    taskRevision: task.revision,
    ledger: foldLedger(deps.tasks.findings.countedSubmissions(change.taskId), deps.tasks.findings.events(change.taskId)),
    fixAttempt: attempt === null || attempt.kind !== 'fix' ? null : {
      status: attemptStatus(attempt, deps.tasks.assignmentsOf(change.taskId), rounds),
      answersRound: attempt.manifest.answers?.roundId ?? null,
    },
  }
}

/** Run the step for one change; true when it wrote the new round. */
export function regateRefuted(deps: RegateDeps, change: ChangeRow): boolean {
  if (change.state !== 'implementing') return false
  const facts = regateFacts(deps, change)
  if (facts === null || regateRefusal(facts) !== null) return false
  const failed = facts.newest as RoundRow
  const attempt = deps.executions.attempts(change.executionId, change.change).at(-1)!
  const taskId = change.taskId!
  return deps.tasks.atomically(() => {
    const current = deps.executions.change(change.executionId, change.change)
    if (current === null || current.state !== change.state || current.generation !== change.generation) return false
    const round = deps.executions.insertRegateRound(failed, attempt.id)
    deps.afterInsert?.()
    deps.executions.transition(change.executionId, change.change, current, { state: 'gating', step: null, passedAt: deps.now().toISOString(), fixRounds: 0 })
    const handoff = attempt.assignmentId !== null ? deps.tasks.assignmentsOf(taskId).find(row => row.id === attempt.assignmentId) ?? null : null
    if (handoff !== null && handoff.supersededBy === null) {
      const state = handoff.messageId !== null ? deps.mail.get(handoff.messageId)?.state : undefined
      if (state === 'queued' || state === 'awaiting-request') deps.mail.cancel(handoff.messageId!, { kind: 'system' }, 'the refuted review was re-gated')
      deps.tasks.supersedeAssignment(handoff.id, round.id)
    }
    const ids = failed.blockingIds!.join(', ')
    deps.tasks.appendJournal(taskId, SYSTEM_ACTOR,
      `Re-gated result ${failed.resultId}: every finding round ${failed.number} failed on (${ids}) was rejected on its dispute; round ${round.number} passes on its kept CI and review, and fix attempt ${attempt.number} is answered`)
    if (handoff?.claimedBy) {
      deps.mail.enqueue({
        teamId: deps.team.teamId, toKind: 'session', toId: handoff.claimedBy, fromKind: 'system', fromSession: null, fromGroup: null,
        originPath: deps.team.groupsRoot, taskId, actor: 'system', tags: ['review-regate'],
        body: `Kawai: the disputes of ${ids} on change "${change.change}" were rejected, so result ${failed.resultId} passes as round ${round.number} on its kept CI and review. Your fix attempt ${attempt.number} is closed: stop working on it and commit nothing more for it.`,
      })
    }
    return true
  })
}

/** The tick's pass (D8): every owned, unheld implementing change; true when any re-gated. */
export function regateOwned(deps: RegateDeps, changes: readonly ChangeRow[], held: (change: ChangeRow) => boolean): boolean {
  let regated = false
  for (const change of changes) {
    if (change.state !== 'implementing' || held(change)) continue
    if (regateRefuted(deps, change)) regated = true
  }
  return regated
}
