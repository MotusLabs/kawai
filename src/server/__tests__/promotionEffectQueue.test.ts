// integration-candidates task 2.3: the effects runner over the promotion
// effects table. `PromotionEffectStore` is a second `EffectQueue` beside the
// execution store. These tests cover:
// - due effects run oldest first, and only for running promotions, except
//   a finished promotion's close-pr;
// - a transient failure backs off on the 30 s / 2 m / 10 m schedule and
//   fails after three tries;
// - at startup, a `running` effect becomes `unknown`;
// - a write after an await never reopens a settled effect, and a finished
//   promotion keeps no pending or unknown row but its close-pr (review O3).
import { beforeEach, describe, expect, test } from 'bun:test'
import { schemaDb } from './schemaDb'
import { applyIntegrationSchema } from '../plans/landing/integration/integrationSchema'
import { IntegrationStore } from '../plans/landing/integration/integrationStore'
import type { PromotionEffectRow } from '../plans/landing/integration/promotionEffectStore'
import { EffectRunner, type EffectCallResult } from '../plans/execution/effects'

const TEAM = 'team'
let clock: number
let store: IntegrationStore
let calls: string[]
let results: EffectCallResult[]
let failed: string[]

beforeEach(() => {
  clock = Date.parse('2026-10-18T10:00:00.000Z')
  const db = schemaDb()
  applyIntegrationSchema(db)
  store = new IntegrationStore(db, () => new Date(clock))
  calls = []
  results = []
  failed = []
})

const runner = () => new EffectRunner<PromotionEffectRow>({
  store,
  adapter: { call: async effect => { calls.push(effect.effectKey); return results.length > 1 ? results.shift()! : results[0] ?? { ok: true, outcome: null } } },
  backoffsMs: [30_000, 120_000, 600_000],
  now: () => new Date(clock),
  onFailed: effect => failed.push(effect.effectKey),
})

function promotion(planId: string) {
  return store.insertPromotion({ teamId: TEAM, planId, branch: 'wave/int', commandId: `cmd-${planId}`, fromSha: 'h', throughSeq: 1, targetBranch: 'master', floor: {} })
}

describe('the promotion effect queue', () => {
  test('due effects run oldest first, for running promotions, plus a finished promotion\'s close-pr', async () => {
    const running = promotion('plan-1')
    const finished = promotion('plan-2')
    store.insertEffect({ promotionId: running.id, kind: 'create-promotion-branch', effectKey: 'p1:branch', command: {} })
    clock += 1000
    store.insertEffect({ promotionId: finished.id, kind: 'merge', effectKey: 'p2:merge', command: {} })
    store.insertEffect({ promotionId: finished.id, kind: 'close-pr', effectKey: 'p2:close', command: {} })
    clock += 1000
    store.insertEffect({ promotionId: running.id, kind: 'open-pr', effectKey: 'p1:pr', command: {} })
    store.finishPromotion(finished.id, 'failed:ci-failed')
    expect(await runner().runDue(TEAM)).toBe(3)
    expect(calls).toEqual(['p1:branch', 'p2:close', 'p1:pr'])
    expect(store.effectByKey('p2:merge')!.state).toBe('pending')
    expect(store.effectByKey('p1:pr')!.state).toBe('done')
    expect(await runner().runDue('another-team')).toBe(0)
  })

  test('a transient failure backs off 30 s, 2 m, 10 m, then fails', async () => {
    const running = promotion('plan-1')
    const effect = store.insertEffect({ promotionId: running.id, kind: 'open-pr', effectKey: 'p1:pr', command: {} })
    results = [{ ok: false, error: { argv: ['gh'], exitCode: 1, httpStatus: 502, message: 'Server Error' } }]
    for (const wait of [30_000, 120_000, 600_000]) {
      await runner().runDue(TEAM)
      const row = store.effect(effect.id)!
      expect(row.state).toBe('pending')
      expect(Date.parse(row.nextAt!) - clock).toBe(wait)
      expect(await runner().runDue(TEAM)).toBe(0)
      clock += wait
    }
    await runner().runDue(TEAM)
    expect(store.effect(effect.id)).toMatchObject({ state: 'failed', tries: 3 })
    expect(failed).toEqual(['p1:pr'])
    expect(calls).toHaveLength(4)
  })

  test('a running effect becomes unknown at startup; a finish also cancels its pending and uninspected effects as cleanup (D10)', () => {
    const running = promotion('plan-1')
    const inFlight = store.insertEffect({ promotionId: running.id, kind: 'merge', effectKey: 'p1:merge', command: {} })
    const waiting = store.insertEffect({ promotionId: running.id, kind: 'fast-forward', effectKey: 'p1:ff', command: {} })
    store.markEffectRunning(inFlight.id)
    expect(store.markRunningPromotionEffectsUnknown().map(row => row.id)).toEqual([inFlight.id])
    expect(store.effect(inFlight.id)!.state).toBe('unknown')
    store.cancelPromotionEffects(running.id)
    expect(store.effect(waiting.id)!.state).toBe('cancelled')
    // Cleanup, not a guard: dueEffects and dueUnknownEffects never pick a finished promotion's effects but close-pr, and the planner reads unknown as waiting (D10).
    expect(store.effect(inFlight.id)!.state).toBe('cancelled')
    expect(store.insertEffect({ promotionId: running.id, kind: 'merge', effectKey: 'p1:merge', command: { again: true } }).id).toBe(inFlight.id)
  })

  test('an inspection settling after a Cancel leaves the cancelled effect cancelled (O3)', () => {
    const running = promotion('plan-1')
    const done = store.insertEffect({ promotionId: running.id, kind: 'open-pr', effectKey: 'p1:pr', command: {} })
    const reset = store.insertEffect({ promotionId: running.id, kind: 'update-branch', effectKey: 'p1:update', command: {} })
    const retried = store.insertEffect({ promotionId: running.id, kind: 'create-promotion-branch', effectKey: 'p1:branch', command: {} })
    for (const effect of [done, reset, retried]) store.markEffectRunning(effect.id)
    store.markRunningPromotionEffectsUnknown()
    expect(store.dueUnknownEffects(TEAM, new Date(clock).toISOString())).toHaveLength(3)
    // The inspections read GitHub; the Cancel commits meanwhile.
    store.finishPromotion(running.id, 'cancelled')
    store.cancelPromotionEffects(running.id)
    store.setEffectOutcome(done.id, { state: 'done', outcome: { number: 7 } })
    store.resetEffect(reset.id)
    store.scheduleInspectionRetry(retried.id, new Date(clock + 30_000).toISOString(), 'HTTP 502')
    for (const effect of [done, reset, retried]) expect(store.effect(effect.id)).toMatchObject({ state: 'cancelled', outcome: null, tries: 0 })
  })

  test('a finished promotion gets no zombie pending or unknown row; its close-pr stays due (O3)', async () => {
    const running = promotion('plan-1')
    const update = store.insertEffect({ promotionId: running.id, kind: 'update-branch', effectKey: 'p1:update', command: {} })
    // The update-branch call is in flight (running, so the finish's sweep leaves it) when the promotion finishes; then it fails transiently.
    results = [{ ok: false, error: { argv: ['gh'], exitCode: 1, httpStatus: 502, message: 'Server Error' } }]
    let closeId: string | undefined
    const queue = new EffectRunner<PromotionEffectRow>({
      store,
      adapter: {
        call: async effect => {
          calls.push(effect.effectKey)
          if (effect.id === update.id) {
            // The finish's own sequence (promotionFinish): sweep pending and unknown, then queue close-pr.
            store.finishPromotion(running.id, 'cancelled')
            store.cancelPromotionEffects(running.id)
            closeId = store.insertEffect({ promotionId: running.id, kind: 'close-pr', effectKey: `promo:${running.id}:close-pr`, command: {} }).id
          }
          return results[0]!
        },
      },
      backoffsMs: [30_000, 120_000, 600_000],
      now: () => new Date(clock),
    })
    await queue.runDue(TEAM)
    expect(calls).toEqual(['p1:update'])
    expect(store.effect(update.id)!.state).toBe('cancelled')
    expect(store.effect(closeId!)).toMatchObject({ state: 'pending', tries: 0 })
    // The next pass runs the finish's close-pr; its transient failure retries, and the retry survives the sweep.
    await queue.runDue(TEAM)
    expect(calls).toHaveLength(2)
    expect(calls[0]).toBe('p1:update')
    expect(calls[1]!.startsWith('promo:')).toBe(true)
    expect(store.effect(closeId!)).toMatchObject({ state: 'pending', tries: 1 })
    clock += 600_000
    expect(store.dueEffects(TEAM, new Date(clock).toISOString()).map(row => row.id)).toEqual([closeId!])
    // An unknown row of a finished promotion is never inspected, and a reset of one is cancelled, not reopened.
    const stale = store.insertEffect({ promotionId: running.id, kind: 'merge', effectKey: 'p1:merge', command: {} })
    store.markEffectRunning(stale.id)
    store.markRunningPromotionEffectsUnknown()
    expect(store.dueUnknownEffects(TEAM, new Date(clock).toISOString()).map(row => row.id)).toEqual([])
    store.resetEffect(stale.id)
    expect(store.effect(stale.id)!.state).toBe('cancelled')
  })

  test('a no-op mark announces nothing (N4)', async () => {
    const changed: Array<string | undefined> = []
    store.subscribe((_teamId, planId) => changed.push(planId))
    const flush = () => new Promise(resolve => queueMicrotask(resolve))
    const running = promotion('plan-1')
    const effect = store.insertEffect({ promotionId: running.id, kind: 'merge', effectKey: 'p1:merge', command: {} })
    expect(store.markEffectRunning(effect.id)).toBe(true)
    await flush()
    expect(changed).toEqual(['plan-1'])
    store.setEffectOutcome(effect.id, { state: 'cancelled' })
    await flush()
    changed.length = 0
    expect(store.markEffectRunning(effect.id)).toBe(false)
    await flush()
    expect(changed).toEqual([])
  })

  // The final review's probe (F1): runDue snapshots two due effects; a Cancel
  // lands while the first runs; the second must stay cancelled and its
  // adapter must never be called — markEffectRunning does not revive it.
  test('a Cancel between two due effects is not undone by markEffectRunning (F1)', async () => {
    const cancelled = promotion('plan-2')
    const merge = store.insertEffect({ promotionId: promotion('plan-1').id, kind: 'merge', effectKey: 'p1:merge', command: {} })
    store.insertEffect({ promotionId: cancelled.id, kind: 'create-promotion-branch', effectKey: 'p2:branch', command: {} })
    const queue = new EffectRunner<PromotionEffectRow>({
      store,
      adapter: {
        call: async effect => {
          calls.push(effect.effectKey)
          if (effect.id === merge.id) {
            // The human Cancels plan-2's promotion while the merge runs: the sweep settles p2's pending effect.
            store.finishPromotion(cancelled.id, 'cancelled')
            store.cancelPromotionEffects(cancelled.id)
          }
          return { ok: true, outcome: null }
        },
      },
      now: () => new Date(clock),
    })
    await queue.runDue(TEAM)
    expect(calls).toEqual(['p1:merge'])
    expect(store.effectByKey('p2:branch')!.state).toBe('cancelled')
  })
})
