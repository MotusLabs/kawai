// Startup recovery (plan-execution D14): after a restart every `running`
// effect is `unknown`; each is inspected with real git/gh reads (startupReads.ts) before
// anything else for its change runs. An exhausted inspection stops its
// change as effect-unknown (D12). It never wakes the executor: the runtime
// wakes the running teams once its wakes are installed.
import type { GhCommandOptions } from '../landing/ghCommand'
import { inspectUnknownEffects, type InspectorReads } from './effectInspectors'
import type { ExecutionStore } from './executionStore'
import { startupReads } from './startupReads'
import { applyEffectOutcome, stopWaitingChanges, type OutcomeDeps } from './executorOutcomes'

/**
 * One inspection pass over the due `unknown` effects (D14) — the wiring
 * shared by the startup recovery and every tick's settled step, so a
 * `unknown` row is inspected before anything runs however it got there: a
 * restart's `running` rows, an exhausted inspection's retry, or the human
 * Retry's reset after an `effect-unknown` stop. A done execution-level
 * effect is recorded by its mechanism; a stopped or exhausted one stops
 * every change still waiting on it; an exhausted change-level inspection
 * stops its change as `effect-unknown`, naming the effect so its Retry
 * re-opens the right row (review N2).
 */
export async function inspectDueUnknownEffects(deps: { store: ExecutionStore; reads: InspectorReads; outcomes?: OutcomeDeps; now?: () => Date; teamId?: string }): Promise<void> {
  await inspectUnknownEffects({
    store: deps.store, reads: deps.reads,
    ...(deps.teamId !== undefined ? { teamId: deps.teamId } : {}),
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
      // revision-control D7: a push-checkpoint never stops its change — the
      // settled row reads Pausing checkpoint-push-failed and the holder may
      // record again. Keyed on the kind only.
      if (effect.kind === 'push-checkpoint') return
      if (effect.change === null) return stopWaitingChanges(deps.store, effect.executionId, effect.kind, effect.id, effect.error ?? 'the outcome could not be determined')
      const row = deps.store.change(effect.executionId, effect.change)
      // A stopped execution's merge is settled by its landing-outcome stage.
      if (row === null || row.state === 'stopped' || row.state === 'cancelled' || row.state === 'landed') return
      if (deps.store.execution(effect.executionId)?.state !== 'running') return
      deps.store.transition(effect.executionId, effect.change, row, {
        state: 'stopped', stopReason: 'effect-unknown', step: null,
        stopDetail: { message: effect.error ?? 'the outcome could not be determined', effectId: effect.id },
      })
    },
  })
}

/** The startup pass: a `running` effect's process is gone — mark it `unknown`, then inspect. */
export async function recoverUnknownEffects(deps: { store: ExecutionStore; reads?: InspectorReads; outcomes?: OutcomeDeps; ghOptions?: GhCommandOptions; now?: () => Date }): Promise<void> {
  deps.store.markRunningEffectsUnknown()
  await inspectDueUnknownEffects({
    store: deps.store,
    reads: deps.reads ?? startupReads(deps.ghOptions),
    ...(deps.outcomes ? { outcomes: deps.outcomes } : {}),
    ...(deps.now ? { now: deps.now } : {}),
  })
}
