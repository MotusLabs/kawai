// strategy-revision-impact 3.4: the impact gate as durable-plans' approval
// sees it through `pinDisposition` — `continue` lets a non-current pin pass,
// every other decision state keeps the `strategy-pin-current` refusal, a
// resubmitted revision passes under `adapt` and `reconsider`, a withdrawn
// direction and a newer strategy approval override `continue`, no strategy
// record passes only an unpinned revision, and the state
// key changes exactly when a gate result changes.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import { createPlanWorld, type PlanWorld } from './planHarness'
import { createImpactBench, type ImpactBench } from './impactHarness'
import type { ImpactDisposition } from '../../shared/strategyImpact'

let world: PlanWorld
let bench: ImpactBench
beforeAll(async () => { world = await createPlanWorld('kawai-impact-gate-') })
afterAll(() => fs.rmSync(world.root, { recursive: true, force: true }))
beforeEach(() => {
  bench?.db.close()
  bench = createImpactBench(world)
})

let commands = 0
/** A plan revision in review pinned to strategy revision 1, after revision 2 was approved. */
async function pinnedInReview() {
  bench.approveStrategy()
  const { planId } = await bench.draftInReview()
  bench.approveStrategy({ purpose: 'Revised direction' })
  return { planId, reviewId: bench.currentReviewId() }
}

async function decide(planId: string, reviewId: string, disposition: ImpactDisposition) {
  const prior = bench.impact.detail(world.team.teamId)!.assessment!.affected.find(row => row.planId === planId)?.effectiveDecision ?? null
  const outcome = await bench.impact.decide(bench.human, {
    reviewId, planId, disposition, rationale: `Owner chose ${disposition}`, expectedDecisionId: prior?.id ?? null, commandId: `gate-decide-${++commands}`,
  })
  if (!outcome.ok) throw new Error(outcome.message)
  return outcome.decision
}

const failureIds = (outcome: Awaited<ReturnType<ImpactBench['approve']>>) => (outcome.ok ? [] : (outcome.failures ?? []).map(failure => failure.name))

describe('the impact gate through PlanService.approve', () => {
  test('no decision keeps the strategy-pin-current refusal; continue lets the non-current pin pass', async () => {
    const { planId, reviewId } = await pinnedInReview()
    expect(failureIds(await bench.approve(planId, 1))).toEqual(['strategy-pin-current'])
    const decision = await decide(planId, reviewId, 'continue')
    expect(bench.impact.pinDisposition(planId, 1)).toEqual({ kind: 'continue', decisionId: decision.id })
    const approved = await bench.approve(planId, 1)
    expect(approved.ok).toBe(true)
    expect(bench.plans.get(planId)!.currentApprovedRevision).toBe(1)
  })

  for (const disposition of ['adapt', 'reconsider'] as const) {
    test(`${disposition} keeps the refusal, and a resubmitted revision passes with the plan still open`, async () => {
      const { planId, reviewId } = await pinnedInReview()
      await decide(planId, reviewId, disposition)
      expect(bench.impact.pinDisposition(planId, 1)).toBeNull()
      expect(failureIds(await bench.approve(planId, 1))).toEqual(['strategy-pin-current'])
      const revision = await bench.resubmit(planId)
      expect(bench.impact.gate(planId, revision)?.state).toBe('current')
      expect((await bench.approve(planId, revision)).ok).toBe(true)
      expect(bench.plans.get(planId)!.lifecycle).toBe('open')
    })
  }

  test('without a strategy record, an unpinned revision passes and a pinned one keeps the refusal', async () => {
    const { planId: unpinned } = await bench.draftInReview()
    expect(bench.strategies.forTeam(world.team.teamId)).toBeNull()
    expect(bench.plans.revision(unpinned, 1)!.pin).toBeNull()
    expect(bench.impact.pinDisposition(unpinned, 1)).toBeNull()
    expect((await bench.approve(unpinned, 1)).ok).toBe(true)
    // A pin naming a strategy this team no longer has a record of (written
    // directly: no supported path removes a record) never passes.
    const { planId: pinned } = await bench.draftInReview()
    bench.db.db.run("UPDATE plan_revisions SET strategy_id = 'strategy-gone', strategy_revision = 1, strategy_hash = 'hash-gone' WHERE plan_id = ? AND revision = 1", [pinned])
    expect(bench.plans.revision(pinned, 1)!.pin).toEqual({ strategyId: 'strategy-gone', revision: 1, hash: 'hash-gone' })
    expect(bench.impact.pinDisposition(pinned, 1)).toBeNull()
    expect(failureIds(await bench.approve(pinned, 1))).toEqual(['strategy-pin-current'])
    expect(bench.plans.get(pinned)!.currentApprovedRevision).toBeNull()
  })

  test('a withdrawn pinned revision is refused despite continue', async () => {
    const { planId, reviewId } = await pinnedInReview()
    await decide(planId, reviewId, 'continue')
    bench.withdrawStrategy(1)
    expect(bench.impact.gate(planId, 1)?.state).toBe('withdrawn-direction')
    expect(bench.impact.pinDisposition(planId, 1)).toBeNull()
    expect(failureIds(await bench.approve(planId, 1))).toEqual(['strategy-pin-current'])
  })

  test('a newer strategy approval makes the old continue stop counting', async () => {
    const { planId, reviewId } = await pinnedInReview()
    await decide(planId, reviewId, 'continue')
    bench.approveStrategy({ purpose: 'Third direction' })
    expect(bench.impact.gate(planId, 1)).toMatchObject({ state: 'decision-required', decisionId: null })
    expect(failureIds(await bench.approve(planId, 1))).toEqual(['strategy-pin-current'])
  })

  test('the state key changes exactly when a gate result changes', async () => {
    const { planId, reviewId } = await pinnedInReview()
    const keys = [bench.impact.stateKey(planId)]
    await bench.impact.propose(bench.agent('lead'), { planId, disposition: 'continue', rationale: 'Fits' })
    keys.push(bench.impact.stateKey(planId))
    expect(keys[1]).toBe(keys[0])
    await decide(planId, reviewId, 'adapt')
    keys.push(bench.impact.stateKey(planId))
    expect(keys[2]).not.toBe(keys[1])
    expect(bench.impact.stateKey(planId)).toBe(keys[2])
    await decide(planId, reviewId, 'continue')
    keys.push(bench.impact.stateKey(planId))
    expect(new Set(keys.slice(1)).size).toBe(3)
    bench.approveStrategy({ purpose: 'Third direction' })
    expect(bench.impact.stateKey(planId)).not.toBe(keys[3])
    expect(bench.impact.stateKey('plan-missing')).toBe(bench.impact.stateKey('plan-also-missing'))
  })
})
