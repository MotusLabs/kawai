// strategy-revision-impact 4.1: the two impact tools on the `kawai-team`
// server — a get and propose round trip, identity bound to the calling
// session whatever the input claims, another team's ids read as not found,
// and no registered tool that decides, approves, publishes, withdraws, or
// deletes.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import { createPlanWorld, type PlanWorld } from './planHarness'
import { createImpactBench, type ImpactBench } from './impactHarness'
import { IMPACT_TOOL_NAMES, impactHandlers } from '../strategy/impactTools'
import { STRATEGY_FORBIDDEN_TOOL_NAMES, STRATEGY_TOOL_NAMES } from '../strategy/strategyTools'
import { PLAN_TOOL_NAMES } from '../plans/planTools'
import { TEAM_ALLOWED_TOOLS } from '../team/mailboxTools'
import type { StrategyImpactDetail } from '../../shared/strategyImpact'

let world: PlanWorld
let bench: ImpactBench
beforeAll(async () => { world = await createPlanWorld('kawai-impact-tools-') })
afterAll(() => fs.rmSync(world.root, { recursive: true, force: true }))
beforeEach(() => {
  bench?.db.close()
  bench = createImpactBench(world)
})

/** Give the other team its own approved strategy, so its agents read a real record. */
function otherTeamStrategy() {
  const strategy = bench.strategies.create({ productId: 'other', title: 'Other', owner: { kind: 'human', sessionId: null }, teamId: world.otherTeam.teamId, worktrees: [world.other] })
  const submitted = bench.strategies.submitRevision(strategy.id, { author: { kind: 'human', sessionId: null }, content: { purpose: 'Other product' } })
  if (!submitted.ok) throw new Error(submitted.message)
  const approved = bench.strategies.approve(strategy.id, {
    revision: submitted.revision.revision, contentHash: submitted.revision.contentHash, commandId: 'other-approve',
    expectedCurrentRevision: null, actor: { kind: 'human', sessionId: null },
  })
  if (!approved.ok) throw new Error(approved.message)
}

const failure = async (call: Promise<unknown>) => {
  try { await call } catch (error) { return String(error) }
  return 'no error'
}

describe('the strategy impact tools', () => {
  test('get and propose round trip as the calling agent, even with a forged actor in the input', async () => {
    const { planId, reviewId } = await bench.affectedPlan()
    const tools = impactHandlers(bench.impact, 'lead')
    const detail = await tools.strategy_impact_get({}) as StrategyImpactDetail
    expect(detail.currentReviewId).toBe(reviewId)
    expect(detail.assessment!.affected.map(row => row.planId)).toEqual([planId])
    const proposal = await tools.strategy_impact_propose({
      plan_id: planId, disposition: 'adapt', rationale: 'Revision 2 narrows the users', actor: { kind: 'human' }, team: world.otherTeam, author: 'human',
    })
    expect(proposal).toMatchObject({ reviewId, planId, disposition: 'adapt', author: { kind: 'agent', sessionId: 'lead' } })
    const review = await tools.strategy_impact_get({ review_id: reviewId }) as StrategyImpactDetail['reviews'][number]
    expect(review.proposals.map(entry => entry.id)).toEqual([proposal.id])
    expect(review.decisions).toEqual([])
    expect(bench.impact.gate(planId, 1)?.state).toBe('decision-required')
    expect(await failure(tools.strategy_impact_propose({ plan_id: planId, disposition: 'approve', rationale: 'x' }))).toContain('disposition')
  })

  test("another team's review and plan read as not found", async () => {
    const { planId, reviewId } = await bench.affectedPlan()
    otherTeamStrategy()
    const tools = impactHandlers(bench.impact, 'stranger')
    expect(await failure(tools.strategy_impact_get({ review_id: reviewId }))).toContain(`Impact review not found in this team: ${reviewId}`)
    expect(await failure(tools.strategy_impact_propose({ plan_id: planId, disposition: 'continue', rationale: 'x' }))).toContain(`Plan not found in this team: ${planId}`)
    expect(await failure(tools.strategy_impact_propose({ plan_id: planId, disposition: 'continue', rationale: 'x', review_id: reviewId }))).toContain('not found')
    const own = await tools.strategy_impact_get({}) as StrategyImpactDetail
    expect(own.reviews.map(entry => entry.reviewId)).not.toContain(reviewId)
  })

  test('no registered tool decides, approves, publishes, withdraws, or deletes', () => {
    const tools = impactHandlers(bench.impact, 'lead')
    expect(Object.keys(tools).sort()).toEqual([...IMPACT_TOOL_NAMES].sort())
    const registered = [...STRATEGY_TOOL_NAMES, ...IMPACT_TOOL_NAMES, ...PLAN_TOOL_NAMES]
    for (const forbidden of STRATEGY_FORBIDDEN_TOOL_NAMES) expect(registered).not.toContain(forbidden)
    expect(STRATEGY_FORBIDDEN_TOOL_NAMES).toEqual(expect.arrayContaining(['strategy_impact_decide', 'strategy_impact_record']))
    // decision_record records the Lead's decision on a plan's decision card
    // (plan-supervision D5), not an impact decision; it is the one exemption.
    for (const name of TEAM_ALLOWED_TOOLS.filter(name => name !== 'mcp__kawai-team__decision_record')) expect(name).not.toMatch(/decide|approve|publish|withdraw|delete|record/)
    for (const name of IMPACT_TOOL_NAMES) expect(TEAM_ALLOWED_TOOLS).toContain(`mcp__kawai-team__${name}`)
  })
})
