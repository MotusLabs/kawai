// The wire view of a plan's executions (plan-execution D17/D18): the full
// `PlanExecutionView` the Plans view and `plan_get` show, projected from the
// store rows — per change the state, waiting reason, PR, counts, latest
// round with its CI (flaky names marked) and verdict, the landing fact, and
// the expandable effects. Pure reads; no policy.
import type { PlanExecutionView, RoundCiView, WaitingReason } from '../../../shared/planExecution'
import { flakyChecks } from '../../../shared/planExecutionGates'
import type { TaskFindings } from '../../../shared/teamTasks'
import type { Database } from 'bun:sqlite'
import { TaskResultStore } from '../../team/taskResultStore'
import type { PlanStore } from '../planStore'
import type { RoundRow } from './executionRows'
import type { ExecutionStore } from './executionStore'

/** What the view reads beside the store: the executed revision's dependencies and a round's findings. */
export interface ExecutionViewReads {
  dependsOn: (planId: string, revision: number, change: string) => string[]
  findings: (resultId: string) => TaskFindings[]
}

/** The production reads: the plan store's revision content and the team's findings rows. */
export function executionViewReads(plans: Pick<PlanStore, 'revision'>, db: Database): ExecutionViewReads {
  const results = new TaskResultStore(db)
  return {
    dependsOn: (planId, revision, change) => plans.revision(planId, revision)?.content.changes.find(entry => entry.change === change)?.dependsOn ?? [],
    findings: resultId => results.findingsFor(resultId),
  }
}

const PENDING_CI = ['queued', 'in_progress', 'waiting', 'requested', 'pending']

/** One change's waiting reason, derived from its row, the revision's dependencies, and the slot. */
function waitingOf(store: ExecutionStore, reads: ExecutionViewReads, row: { executionId: string; change: string; state: string; step: string | null; stopDetail: { message?: string; session?: string } | null }): WaitingReason | null {
  const execution = store.execution(row.executionId)
  if (execution === null) return null
  if (row.state === 'waiting') {
    const states = new Map(store.changes(row.executionId).map(entry => [entry.change, entry.state]))
    const unlanded = reads.dependsOn(execution.planId, execution.revision, row.change).filter(change => states.get(change) !== 'landed')
    return unlanded.length > 0 ? { kind: 'dependency', changes: unlanded } : { kind: 'parallel-limit', limit: execution.maxParallel }
  }
  if (row.step === 'awaiting-slot') return { kind: 'slot', holder: store.slot(execution.teamId)?.holderId ?? null }
  if (row.step === 'releasing') return { kind: 'release', member: row.stopDetail?.session ?? '', reason: row.stopDetail?.message ?? 'a member is not ready to release' }
  if (row.step === 'reviewing') return { kind: 'review', claimant: null }
  if (row.state === 'gating' && row.step === null) {
    const round = store.rounds(row.executionId, row.change).at(-1) ?? null
    if (round === null) return null
    if (round.pushedAt === null) return { kind: 'effect', effect: 'push', state: 'pending', nextAt: null }
    if (round.reviewAssignmentId === null) {
      const pending = (round.ci ?? []).filter(check => PENDING_CI.includes(check.conclusion.toLowerCase())).map(check => check.name)
      return pending.length > 0 ? { kind: 'ci', pending } : null
    }
    return { kind: 'review', claimant: null }
  }
  return null
}

/**
 * A round's CI standing: passed once the review was dispatched (or a carried
 * round's verdict decided it), failed when the round failed before review,
 * stopped when the change stopped on CI with the round open, else pending.
 */
function ciOf(round: RoundRow, change: { state: string; stopReason: string | null }): RoundCiView | null {
  if (round.ci === null) return null
  const state: RoundCiView['state'] = round.reviewAssignmentId !== null || (round.carriedFrom !== null && round.outcome === 'pass') ? 'pass'
    : round.outcome === 'fail' ? 'fail'
      : round.outcome === null && change.state === 'stopped' && (change.stopReason === 'ci-missing' || change.stopReason === 'ci-timeout') ? 'stopped'
        : 'pending'
  return { checks: round.ci, flaky: state === 'pass' ? flakyChecks(round.ci) : [], rerunAt: round.rerunAt, state }
}

/** The findings that decided the round: their verdict and author. */
function verdictOf(reads: ExecutionViewReads, round: RoundRow): { findingsId: string; verdict: 'pass' | 'fail'; reviewer: string } | null {
  if (round.verdictFindingsId === null) return null
  const findings = reads.findings(round.resultId).find(row => row.id === round.verdictFindingsId)
  if (findings === undefined) return null
  return { findingsId: findings.id, verdict: findings.verdict, reviewer: findings.author.kind === 'agent' ? findings.author.sessionId ?? '' : findings.author.kind }
}

/** The full view of the plan's executions, newest first. */
export function executionViews(store: ExecutionStore, planId: string, reads: ExecutionViewReads): PlanExecutionView[] {
  return store.executionsOf(planId).map(execution => ({
    id: execution.id,
    planId: execution.planId,
    revision: execution.revision,
    contentHash: execution.contentHash,
    reportId: execution.reportId,
    inputHash: execution.inputHash,
    landingMode: execution.landingMode,
    baseBranch: execution.baseBranch,
    baseCommit: execution.baseCommit,
    floor: execution.floor,
    maxParallel: execution.maxParallel,
    mergeMethod: execution.mergeMethod,
    state: execution.state,
    outcome: execution.outcome,
    stopReason: execution.stopReason,
    startedAt: execution.startedAt,
    finishedAt: execution.finishedAt,
    changes: store.changes(execution.id).map(row => {
      const rounds = store.rounds(execution.id, row.change)
      const latest = rounds.at(-1) ?? null
      const attemptId = latest?.attemptId ?? null
      const attempt = attemptId === null ? null : store.attempts(execution.id, row.change).find(entry => entry.id === attemptId) ?? null
      const effects = store.effectsOf(execution.id).filter(effect => effect.change === row.change)
      const landing = store.landings(planId).find(fact => fact.change === row.change) ?? null
      return {
        change: row.change,
        position: row.position,
        state: row.state,
        step: row.step,
        waiting: waitingOf(store, reads, row),
        stopReason: row.stopReason,
        stopDetail: row.stopDetail,
        taskId: row.taskId,
        worktree: row.worktree,
        branch: row.branch,
        baselineCommit: row.baselineCommit,
        prNumber: row.prNumber,
        prUrl: row.prUrl,
        prOpenedByKawai: row.prOpenedByKawai,
        fixRounds: row.fixRounds,
        generation: row.generation,
        passedAt: row.passedAt,
        attempts: store.attempts(execution.id, row.change).length,
        attempt: attempt === null ? null : {
          id: attempt.id, number: attempt.number, kind: attempt.kind, assignmentId: attempt.assignmentId,
          manifestHash: attempt.manifestHash, createdAt: attempt.createdAt,
        },
        instruction: null,
        latestRound: latest === null ? null : {
          id: latest.id, number: latest.number, attemptId: latest.attemptId, resultId: latest.resultId,
          commit: latest.commitSha, fixRound: latest.fixRound, carriedFrom: latest.carriedFrom,
          pushedAt: latest.pushedAt,
          ci: ciOf(latest, row),
          reviewAssignmentId: latest.reviewAssignmentId,
          verdict: verdictOf(reads, latest),
          extraChecks: latest.extra ?? [],
          outcome: latest.outcome,
          decidedAt: latest.decidedAt,
        },
        landing,
        effects: effects.map(effect => ({
          id: effect.id, kind: effect.kind, state: effect.state, tries: effect.tries,
          error: effect.error, createdAt: effect.createdAt, finishedAt: effect.finishedAt,
        })),
      }
    }),
  }))
}
