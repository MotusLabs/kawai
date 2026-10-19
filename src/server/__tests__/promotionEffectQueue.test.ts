// integration-candidates task 2.3: the effects runner over the promotion
// effects table. `PromotionEffectStore` is a second `EffectQueue` beside the
// execution store. These tests cover:
// - due effects run oldest first, and only for running promotions, except
//   a finished promotion's close-pr;
// - a transient failure backs off on the 30 s / 2 m / 10 m schedule and
//   fails after three tries;
// - at startup, a `running` effect becomes `unknown`.
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

  test('a running effect becomes unknown at startup; a finish cancels pending and uninspected effects so nothing repeats after it', () => {
    const running = promotion('plan-1')
    const inFlight = store.insertEffect({ promotionId: running.id, kind: 'merge', effectKey: 'p1:merge', command: {} })
    const waiting = store.insertEffect({ promotionId: running.id, kind: 'fast-forward', effectKey: 'p1:ff', command: {} })
    store.markEffectRunning(inFlight.id)
    expect(store.markRunningPromotionEffectsUnknown().map(row => row.id)).toEqual([inFlight.id])
    expect(store.effect(inFlight.id)!.state).toBe('unknown')
    store.cancelPromotionEffects(running.id)
    expect(store.effect(waiting.id)!.state).toBe('cancelled')
    // Cleanup, not a guard: dueEffects never runs a finished promotion's effects but close-pr, and the planner reads unknown as waiting (D10).
    expect(store.effect(inFlight.id)!.state).toBe('cancelled')
    expect(store.insertEffect({ promotionId: running.id, kind: 'merge', effectKey: 'p1:merge', command: { again: true } }).id).toBe(inFlight.id)
  })
})
