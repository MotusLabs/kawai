// executorOutcomes.ts - A settled effect's follow-on writes (plan-execution
// D14), moved out of the executor so it stays under 500 lines: a done
// effect's outcome lands as its change's transition, and a failed one stops
// its change. Execution-level effects (X3: no change, such as integration's
// `create-integration`) belong to the execution's landing mechanism: a done
// one is the mechanism's to record, and a failed one stops every change
// still waiting on it, so Retry resumes them where they waited.
import { recordPull } from './executionRounds'
import type { ExecutionStore } from './executionStore'
import type { LandingMechanism } from '../landing/landingMechanisms'
import type { EffectKind } from '../../../shared/planExecution'

export interface OutcomeDeps {
  store: ExecutionStore
  taskStatusOf: (taskId: string) => string | null
  mechanismOf: (executionId: string) => LandingMechanism
  now: () => Date
}

type SettledEffect = { id: string; kind: string; change: string | null; roundId?: string | null; executionId: string; state: string; outcome: unknown; error: string | null }

/**
 * A failed effect stops its change (D14): effect-failed, or pr-closed when
 * the PR was closed; task-closed when the human closed the task while the
 * effect ran (D19). A stopped execution's failed merge is settled by its
 * landing-outcome stage instead (D12: cancelled with its task).
 */
export function applyEffectFailure(deps: OutcomeDeps, effect: SettledEffect): void {
  if (deps.store.execution(effect.executionId)?.state !== 'running') return
  if (effect.change === null) {
    stopWaitingChanges(deps.store, effect.executionId, effect.kind, effect.id, effect.error ?? 'the effect failed')
    return
  }
  const row = deps.store.change(effect.executionId, effect.change)
  if (row === null || row.state === 'stopped') return
  const error = effect.error ?? ''
  const taskStatus = row.taskId === null ? null : deps.taskStatusOf(row.taskId)
  if (taskStatus === 'done' || taskStatus === 'cancelled') {
    deps.store.transition(effect.executionId, effect.change, row, {
      state: 'stopped', stopReason: 'task-closed', step: null,
      stopDetail: { message: `The task was ${taskStatus} by hand; ${error || 'its running effect failed'}.`, resumeState: row.state, taskId: row.taskId!, effectId: effect.id },
    })
    return
  }
  const reason = error.includes('pr-closed') ? 'pr-closed'
    : error.includes('name-taken') ? 'name-taken' : 'effect-failed'
  deps.store.transition(effect.executionId, effect.change, row, {
    state: 'stopped',
    stopReason: reason,
    stopDetail: { message: effect.error ?? 'the effect failed' },
    step: null,
  })
}

/**
 * A failed execution-level effect (integration-candidates D4): every change
 * still waiting stops as effect-failed, naming the effect, and resumes
 * waiting on Retry — whose planner pass issues the effect again under the
 * next count. Changes past waiting never depended on it.
 */
export function stopWaitingChanges(store: ExecutionStore, executionId: string, kind: string, effectId: string, message: string): void {
  if (store.execution(executionId)?.state !== 'running') return
  for (const row of store.changes(executionId)) {
    if (row.state !== 'waiting') continue
    store.transition(executionId, row.change, row, {
      state: 'stopped', stopReason: 'effect-failed', step: null,
      stopDetail: { message, effect: kind as EffectKind, effectId, resumeState: 'waiting' },
    })
  }
}

/** A settled effect's follow-on transition (D14: the outcome commits with it). */
export function applyEffectOutcome(deps: OutcomeDeps, effect: SettledEffect): void {
  if (effect.change === null) {
    // The settled outcome as given: recovery reports it before the row is written.
    const row = deps.store.effect(effect.id)
    if (row !== null && effect.state === 'done') deps.mechanismOf(effect.executionId).effectDone?.({ ...row, state: 'done', outcome: effect.outcome })
    return
  }
  if (effect.kind === 'push' && typeof effect.roundId === 'string') {
    deps.store.markRoundPushed(effect.roundId, deps.now().toISOString())
    return
  }
  if (effect.kind === 'open-pr') {
    const outcome = effect.outcome as { number?: unknown; url?: unknown; openedByKawai?: unknown } | null
    if (typeof outcome?.number === 'number' && typeof outcome.url === 'string') {
      recordPull(deps.store, effect.executionId, effect.change, {
        number: outcome.number, url: outcome.url, openedByKawai: outcome.openedByKawai === true,
      })
    }
    return
  }
  if (effect.kind === 'provision' && effect.state === 'done') {
    const outcome = effect.outcome as { path?: unknown; branch?: unknown; baseline?: unknown }
    const row = deps.store.change(effect.executionId, effect.change)
    if (row === null || row.state !== 'provisioning') return
    deps.store.transition(effect.executionId, effect.change, row, {
      state: 'implementing',
      worktree: typeof outcome.path === 'string' ? outcome.path : null,
      branch: typeof outcome.branch === 'string' ? outcome.branch : null,
      baselineCommit: typeof outcome.baseline === 'string' ? outcome.baseline : null,
    })
  }
}
