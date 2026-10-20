// Review F1/F2 (integration-candidates PR #238): an effect that has settled —
// done, failed, or cancelled — never changes state again; only open
// (pending, running, unknown) effects move. The table runs every state
// writer of both effect stores against every settled state: each row seeds
// one settled state and asserts the writer leaves the whole row untouched
// (7 writers × 3 states per store, 42 rows).
import { describe, expect, test } from 'bun:test'
import { schemaDb } from './schemaDb'
import { applyIntegrationSchema } from '../plans/landing/integration/integrationSchema'
import { IntegrationStore } from '../plans/landing/integration/integrationStore'
import { ExecutionStore } from '../plans/execution/executionStore'

const CLOCK = Date.parse('2026-10-19T10:00:00.000Z')
const LATER = '2030-01-01T00:00:00.000Z'
const SETTLED = ['done', 'failed', 'cancelled'] as const
type Settled = (typeof SETTLED)[number]
const FLOOR = { lint: ['ci'], typecheck: ['ci'], 'unit-tests': ['ci'], 'ci-e2e': ['e2e'] }

interface Seeds { executionId: string; promotionId: string; effectId: string }

function settle(store: IntegrationStore | ExecutionStore, effectId: string, state: Settled): void {
  store.markEffectRunning(effectId)
  store.setEffectOutcome(effectId, state === 'failed' ? { state, error: 'boom' } : { state, outcome: { n: 1 } })
}

function executionSeeded(state: Settled): { store: ExecutionStore; seeds: Seeds } {
  const store = new ExecutionStore(schemaDb(), () => new Date(CLOCK))
  const executionId = store.insertExecution({
    teamId: 'team', planId: 'plan-1', revision: 1, contentHash: 'h', reportId: 'r', inputHash: 'i',
    landingMode: 'direct', baseBranch: 'master', baseCommit: 'abc', floor: { version: 1, map: FLOOR },
    maxParallel: 3, mergeMethod: 'merge', changes: [{ change: 'api', landed: false }],
  }).id
  const effectId = store.insertEffect({ executionId, change: null, roundId: null, kind: 'provision', effectKey: 'e1', command: { branch: 'b' } }).id
  settle(store, effectId, state)
  return { store, seeds: { executionId, promotionId: '', effectId } }
}

function promotionSeeded(state: Settled): { store: IntegrationStore; seeds: Seeds } {
  const db = schemaDb()
  applyIntegrationSchema(db)
  const store = new IntegrationStore(db, () => new Date(CLOCK))
  const promotionId = store.insertPromotion({ teamId: 'team', planId: 'plan-1', branch: 'wave/int', commandId: 'cmd', fromSha: 'h', throughSeq: 1, targetBranch: 'master', floor: {} }).id
  const effectId = store.insertEffect({ promotionId, kind: 'merge', effectKey: 'p1:merge', command: {} }).id
  settle(store, effectId, state)
  return { store, seeds: { executionId: '', promotionId, effectId } }
}

type Ctx = Pick<Seeds, 'executionId' | 'effectId'>
const EXECUTION_WRITERS: Array<[string, (store: ExecutionStore, ctx: Ctx) => void]> = [
  ['markEffectRunning', (store, ctx) => store.markEffectRunning(ctx.effectId)],
  ['setEffectOutcome', (store, ctx) => store.setEffectOutcome(ctx.effectId, { state: 'done', outcome: { late: true } })],
  ['scheduleEffectRetry', (store, ctx) => store.scheduleEffectRetry(ctx.effectId, LATER, 'late failure')],
  ['cancelEffects', (store, ctx) => store.cancelEffects(ctx.executionId)],
  ['markRunningEffectsUnknown', store => store.markRunningEffectsUnknown()],
  ['resetEffect', (store, ctx) => store.resetEffect(ctx.effectId)],
  ['scheduleInspectionRetry', (store, ctx) => store.scheduleInspectionRetry(ctx.effectId, LATER, 'late inspection')],
]

type PromotionCtx = Pick<Seeds, 'promotionId' | 'effectId'>
const PROMOTION_WRITERS: Array<[string, (store: IntegrationStore, ctx: PromotionCtx) => void]> = [
  ['markEffectRunning', (store, ctx) => store.markEffectRunning(ctx.effectId)],
  ['setEffectOutcome', (store, ctx) => store.setEffectOutcome(ctx.effectId, { state: 'done', outcome: { late: true } })],
  ['scheduleEffectRetry', (store, ctx) => store.scheduleEffectRetry(ctx.effectId, LATER, 'late failure')],
  ['cancelPromotionEffects', (store, ctx) => store.cancelPromotionEffects(ctx.promotionId)],
  ['markRunningPromotionEffectsUnknown', store => store.markRunningPromotionEffectsUnknown()],
  ['resetEffect', (store, ctx) => store.resetEffect(ctx.effectId)],
  ['scheduleInspectionRetry', (store, ctx) => store.scheduleInspectionRetry(ctx.effectId, LATER, 'late inspection')],
]

describe('a settled effect never changes state again (F1, F2)', () => {
  describe('executionEffectStore', () => {
    for (const state of SETTLED) {
      for (const [name, run] of EXECUTION_WRITERS) {
        test(`${name} leaves a ${state} effect unchanged`, () => {
          const { store, seeds } = executionSeeded(state)
          const before = store.effect(seeds.effectId)!
          run(store, seeds)
          expect(store.effect(seeds.effectId)).toEqual(before)
        })
      }
    }
  })

  describe('promotionEffectStore', () => {
    for (const state of SETTLED) {
      for (const [name, run] of PROMOTION_WRITERS) {
        test(`${name} leaves a ${state} effect unchanged`, () => {
          const { store, seeds } = promotionSeeded(state)
          const before = store.effect(seeds.effectId)!
          run(store, seeds)
          expect(store.effect(seeds.effectId)).toEqual(before)
        })
      }
    }
  })

  // The execution store's one exception: the human Retry after an
  // `effect-unknown` stop re-opens the failed effect (plan-execution 13.3),
  // synchronously in the retry's own transaction — never a late write.
  describe('retryFailedEffect: the one writer a settled row obeys', () => {
    test('a failed effect re-enters inspection as unknown, its error kept', () => {
      const { store, seeds } = executionSeeded('failed')
      store.retryFailedEffect(seeds.effectId)
      expect(store.effect(seeds.effectId)).toMatchObject({ state: 'unknown', nextAt: null, error: 'boom' })
    })

    test('done and cancelled effects stay settled', () => {
      for (const state of ['done', 'cancelled'] as const) {
        const { store, seeds } = executionSeeded(state)
        const before = store.effect(seeds.effectId)!
        store.retryFailedEffect(seeds.effectId)
        expect(store.effect(seeds.effectId)).toEqual(before)
      }
    })
  })
})
