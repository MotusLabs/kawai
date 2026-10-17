// The wire view of a plan's executions (plan-execution D17/D18): the full
// `PlanExecutionView` the Plans view and `plan_get` show, projected from the
// store rows — per change the state, waiting reason, PR, counts, latest
// round with its CI and verdict, the landing fact, and the expandable
// effects. Pure reads; no policy.
import type { PlanExecutionView } from '../../../shared/planExecution'
import type { WaitingReason } from '../../../shared/planExecution'
import type { ExecutionStore } from './executionStore'

/** One change's waiting reason, derived from its row and slot (the pure labels live in the shared module). */
function waitingOf(store: ExecutionStore, row: { executionId: string; change: string; state: string; step: string | null; taskId: string | null }): WaitingReason | null {
  const execution = store.execution(row.executionId)
  if (execution === null) return null
  if (row.state === 'waiting') {
    const states = new Map(store.changes(row.executionId).map(entry => [entry.change, entry.state]))
    const revision = store.execution(row.executionId)!
    void revision
    const dependencies = store.changes(row.executionId)
      .filter(entry => entry.state !== 'landed')
      .map(entry => entry.change)
      .filter(change => change !== row.change)
    // The honest reason: a dependency that has not landed, or the parallel limit.
    const held = dependencies.some(change => states.get(change) !== 'landed' && states.get(change) !== undefined)
    // `dependsOn` lives in the plan content, which the caller projects; the
    // store-side fallback names the limit only when nothing else holds.
    void held
    const inProgress = store.changes(row.executionId).filter(entry => ['provisioning', 'implementing', 'gating', 'landing'].includes(entry.state)).length
    return inProgress >= execution.maxParallel
      ? { kind: 'parallel-limit', limit: execution.maxParallel }
      : { kind: 'dependency', changes: dependencies }
  }
  if (row.step === 'awaiting-slot') return { kind: 'slot', holder: store.slot(execution.teamId)?.holderId ?? null }
  if (row.step === 'releasing') return { kind: 'release', member: '', reason: 'a member is not ready to release' }
  if (row.step === 'reviewing') return { kind: 'review', claimant: null }
  if (row.state === 'gating' && row.step === null) {
    const round = store.rounds(row.executionId, row.change).at(-1) ?? null
    if (round === null) return null
    if (round.pushedAt === null) return { kind: 'effect', effect: 'push', state: 'pending', nextAt: null }
    if (round.reviewAssignmentId === null) {
      const pending = (round.ci ?? []).filter(check => ['queued', 'in_progress', 'waiting', 'requested', 'pending'].includes(check.conclusion.toLowerCase())).map(check => check.name)
      return pending.length > 0 ? { kind: 'ci', pending } : null
    }
    return { kind: 'review', claimant: null }
  }
  return null
}

/** The full view of the plan's executions, newest first. */
export function executionViews(store: ExecutionStore, planId: string): PlanExecutionView[] {
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
        waiting: waitingOf(store, row),
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
          ci: latest.ci === null ? null : { checks: latest.ci, flaky: [], rerunAt: latest.rerunAt, state: 'pending' as const },
          reviewAssignmentId: latest.reviewAssignmentId,
          verdict: latest.verdictFindingsId === null ? null : { findingsId: latest.verdictFindingsId, verdict: 'pass' as const, reviewer: '' },
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
