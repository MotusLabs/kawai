// The shared landing slot (integration-candidates 6.4, D10 step 3, X6): a
// promotion holds the team's one slot as `holder_kind = 'promotion'` with
// its id; a waiting change shows the promotion's branch, a promotion
// waits naming the change that holds it, and a promotion holder whose
// promotion finished, has a recorded merge, or is missing is an orphan —
// cleared and logged at startup and when the slot is found taken — while
// a running promotion's holder stays.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import type { CiCheck } from '../../shared/planExecution'
import { createMatrixBench, createMatrixWorld, greenChecks, originHead, passedChange, removeMatrixWorld, startedExecution, type MatrixBench, type MatrixWorld } from './executionMatrixHarness'
import { createIntegrationBench, type IntegrationBench } from './integrationMatrixHarness'
import { createPromotionBench, twoLandings, type PromotionBench } from './promotionMatrixHarness'

let matrix: MatrixWorld
let h: MatrixBench
let i: IntegrationBench
let p: PromotionBench
let n = 0

beforeAll(async () => { matrix = await createMatrixWorld('kawai-promotion-slot-') })
afterAll(() => removeMatrixWorld(matrix))
beforeEach(() => { h = createMatrixBench(matrix); i = createIntegrationBench(h); p = createPromotionBench(h, i); n += 1 })
afterEach(() => { p.executor.close(); i.executor.close(); h.executor.close(); h.bench.db.close() })

const team = () => matrix.world.team.teamId
const pending = (): CiCheck[] => [{ name: 'ci', source: 'check-run', conclusion: 'pending', link: null, startedAt: null, completedAt: null }]

/** A running promotion that holds the slot while its CI is pending. */
async function holdingPromotion() {
  const branch = `wave/slot-${n}`
  const planId = await twoLandings(h, i, p, branch, String(n))
  h.gh.defaultChecks = pending()
  const outcome = await p.service.promote(p.human, { planId, branch, fromSha: originHead(matrix, branch)!, commandId: `slot-${n}` })
  if (!outcome.ok) throw new Error(outcome.message)
  for (let tick = 0; tick < 10 && i.store.promotion(outcome.promotion.id)!.step !== 'ci'; tick++) await p.tick()
  expect(h.executions.slot(team())).toMatchObject({ holderKind: 'promotion', holderId: outcome.promotion.id })
  return i.store.promotion(outcome.promotion.id)!
}

describe('the shared landing slot (6.4)', () => {
  test("another plan's direct change waits, showing the promotion", async () => {
    const promotion = await holdingPromotion()
    h.gh.defaultChecks = greenChecks()
    h.gh.checks.set(originHead(matrix, promotion.promotionBranch)!, pending())
    const executionId = await startedExecution(h, [{ change: `direct${n}` }])
    const real = h.tick
    h.tick = () => p.tick()
    try {
      await passedChange(h, executionId, `direct${n}`)
      await p.tick()
    } finally {
      h.tick = real
    }
    const row = h.executions.change(executionId, `direct${n}`)!
    expect(row.step).toBe('awaiting-slot')
    expect(h.executions.slotHolderLabel(team())).toBe(promotion.promotionBranch)
    expect(h.executions.slot(team())!.holderId).toBe(promotion.id)
  })

  test('a promotion waits for a change holding the slot, showing that change', async () => {
    const branch = `wave/slot-${n}`
    const planId = await twoLandings(h, i, p, branch, String(n))
    const executionId = await startedExecution(h, [{ change: `holder${n}` }])
    // The change enters landing, taking the slot; only the promotion runner passes from here.
    const row = h.executions.change(executionId, `holder${n}`)!
    expect(h.executions.transition(executionId, `holder${n}`, { state: row.state, generation: row.generation }, { state: 'landing' })).not.toBeNull()
    const outcome = await p.service.promote(p.human, { planId, branch, fromSha: originHead(matrix, branch)!, commandId: `wait-${n}` })
    if (!outcome.ok) throw new Error(outcome.message)
    for (let pass = 0; pass < 6; pass++) await p.runner.pass(team())
    const waiting = i.store.promotion(outcome.promotion.id)!
    expect(waiting).toMatchObject({ state: 'running', step: 'slot' })
    expect(h.executions.slot(team())).toMatchObject({ holderKind: 'change', holderId: `${executionId}:holder${n}` })
    expect(h.executions.slotHolderLabel(team())).toBe(`${executionId}:holder${n}`)
  })

  test('orphan promotion holders are cleared at startup; a running promotion holder stays', async () => {
    const promotion = await holdingPromotion()
    expect(h.executions.clearOrphanSlots()).toEqual([])
    expect(h.executions.slot(team())!.holderId).toBe(promotion.id)
    // A recorded merge makes the holder an orphan.
    i.store.patchPromotion(promotion.id, { mergeSha: 'm'.repeat(40) })
    expect(h.executions.clearOrphanSlots().map(slot => slot.holderId)).toEqual([promotion.id])
    expect(h.executions.slot(team())).toBeNull()
    // A finished promotion and a missing one are orphans too.
    i.store.patchPromotion(promotion.id, { mergeSha: null })
    expect(h.executions.takeSlotFor(team(), 'promotion', promotion.id)).toBe(true)
    i.store.finishPromotion(promotion.id, 'cancelled')
    expect(h.executions.clearOrphanSlots().map(slot => slot.holderId)).toEqual([promotion.id])
    h.bench.db.db.prepare("INSERT INTO plan_landing_slots (team_id, holder_kind, holder_id, since) VALUES (?, 'promotion', 'promo-missing', '')").run(team())
    expect(h.executions.clearOrphanSlots().map(slot => slot.holderId)).toEqual(['promo-missing'])
  })

  test('an orphan promotion holder is cleared when the slot is found taken; a live one keeps it', async () => {
    const promotion = await holdingPromotion()
    expect(h.executions.takeSlotFor(team(), 'promotion', 'other')).toBe(false)
    expect(h.executions.slot(team())!.holderId).toBe(promotion.id)
    i.store.finishPromotion(promotion.id, 'cancelled')
    expect(h.executions.takeSlotFor(team(), 'promotion', 'other')).toBe(true)
    expect(h.executions.slot(team())).toMatchObject({ holderKind: 'promotion', holderId: 'other' })
  })
})
