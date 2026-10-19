// Startup recovery (plan-execution D14): after a restart every `running`
// effect is `unknown`; each is inspected with real git/gh reads (startupReads.ts) before
// anything else for its change runs. An exhausted inspection stops its
// change as effect-unknown (D12). It never wakes the executor: the runtime
// wakes the running teams once its wakes are installed.
import type { GhCommandOptions } from '../landing/ghCommand'
import { inspectUnknownEffects } from './effectInspectors'
import type { ExecutionStore } from './executionStore'
import { startupReads } from './startupReads'
import { applyEffectOutcome, stopWaitingChanges, type OutcomeDeps } from './executorOutcomes'

export async function recoverUnknownEffects(deps: { store: ExecutionStore; outcomes?: OutcomeDeps; ghOptions?: GhCommandOptions; now?: () => Date }): Promise<void> {
  const unknown = deps.store.markRunningEffectsUnknown()
  const teams = new Set(unknown.map(effect => deps.store.execution(effect.executionId)?.teamId ?? ''))
  for (const teamId of teams) {
    if (teamId === '') continue
    const reads = startupReads(deps.ghOptions)
    await inspectUnknownEffects({
      store: deps.store, reads,
      ...(deps.now ? { now: deps.now } : {}),
      // Execution-level effects (X3, integration-candidates D4): a done one is
      // recorded by its mechanism; a stopped or exhausted one stops every
      // change still waiting on it.
      onInspected: (effect, verdict) => {
        if (effect.change !== null) return
        if (verdict.found === 'done' && deps.outcomes) applyEffectOutcome(deps.outcomes, { ...effect, state: 'done', outcome: verdict.outcome })
        if (verdict.found === 'stop') stopWaitingChanges(deps.store, effect.executionId, effect.kind, effect.id, verdict.detail.message ?? `stopped as ${verdict.reason}`)
      },
      onUnknownSettled: effect => {
        if (effect.change === null) return stopWaitingChanges(deps.store, effect.executionId, effect.kind, effect.id, effect.error ?? 'the outcome could not be determined')
        const row = deps.store.change(effect.executionId, effect.change)
        // A stopped execution's merge is settled by its landing-outcome stage.
        if (row === null || row.state === 'stopped' || row.state === 'cancelled' || row.state === 'landed') return
        if (deps.store.execution(effect.executionId)?.state !== 'running') return
        deps.store.transition(effect.executionId, effect.change, row, {
          state: 'stopped', stopReason: 'effect-unknown', step: null, stopDetail: { message: effect.error ?? 'the outcome could not be determined' },
        })
      },
    })
  }
}
