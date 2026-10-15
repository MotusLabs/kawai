// strategy-revision-impact 3.1–3.3: the derived assessment (groups, the
// unassessed mark, current review only, earlier reviews' records and states),
// the owner's decisions (agent refusal, replay, current review, plan group,
// rationale, proposal match, the predecessor check, races, supersession, and
// nothing else written), and agent proposals that change no gate.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import { createPlanWorld, type PlanWorld } from './planHarness'
import { createImpactBench, type ImpactBench } from './impactHarness'
import type { ImpactDecideInput } from '../strategy/ImpactService'

let world: PlanWorld
let bench: ImpactBench
beforeAll(async () => { world = await createPlanWorld('kawai-impact-service-') })
afterAll(() => fs.rmSync(world.root, { recursive: true, force: true }))
beforeEach(() => {
  bench?.db.close()
  bench = createImpactBench(world)
})

const teamId = () => world.team.teamId
const detail = () => bench.impact.detail(teamId())!
let commands = 0
const decideInput = (planId: string, reviewId: string, overrides: Partial<ImpactDecideInput> = {}): ImpactDecideInput => ({
  reviewId, planId, disposition: 'continue', rationale: 'Still serves the revised purpose', expectedDecisionId: null, commandId: `decide-${++commands}`, ...overrides,
})

describe('ImpactService.detail', () => {
  test('no strategy record returns null and creates nothing', () => {
    expect(bench.impact.detail(teamId())).toBeNull()
    expect(bench.strategies.listForTeam(teamId())).toEqual([])
  })

  test('groups affected, unaffected, and historical plans, marking unpinned revisions unassessed', async () => {
    // An unpinned in-review revision submitted before any strategy approval.
    const { planId: unpinned } = await bench.draftInReview()
    const { planId: affected } = await bench.affectedPlan()
    const { planId: current } = await bench.draftInReview()
    const { planId: closed } = await bench.draftInReview()
    expect((await bench.approve(closed, 1)).ok).toBe(true)
    await bench.service.close(bench.human, { planId: closed, outcome: 'cancelled', reason: 'dropped', commandId: 'close-1' })
    const { assessment } = detail()
    expect(assessment!.affected.map(row => row.planId).sort()).toEqual([unpinned, affected].sort())
    expect(assessment!.unaffected.map(row => row.planId)).toEqual([current])
    expect(assessment!.historical.map(row => row.planId)).toEqual([closed])
    const unpinnedRow = assessment!.affected.find(row => row.planId === unpinned)!
    expect(unpinnedRow.revisions).toMatchObject([{ revision: 1, status: 'in_review', pin: null, unassessed: true }])
    expect(unpinnedRow.revisions[0]!.gate.state).toBe('decision-required')
    const affectedRow = assessment!.affected.find(row => row.planId === affected)!
    expect(affectedRow.revisions[0]!.pin?.revision).toBe(1)
    expect(affectedRow.revisions[0]!.unassessed).toBe(false)
    expect(assessment!.historical[0]!.revisions[0]!.pin?.revision).toBe(2)
  })

  test('only the current review has an assessment; earlier reviews keep their records and derived states', async () => {
    const { planId, reviewId } = await bench.affectedPlan()
    expect((await bench.impact.decide(bench.human, decideInput(planId, reviewId))).ok).toBe(true)
    bench.approveStrategy({ purpose: 'Third direction' })
    const now = detail()
    expect(now.reviews.map(review => [review.revision, review.state])).toEqual([[3, 'needs-decisions'], [2, 'superseded'], [1, 'superseded']])
    expect(now.reviews[1]!.decisions.map(decision => decision.disposition)).toEqual(['continue'])
    expect(now.assessment!.affected[0]!.effectiveDecision).toBeNull()
    bench.withdrawStrategy(2)
    expect(detail().reviews[1]!.state).toBe('withdrawn')
    expect(bench.strategies.impactReviews(bench.strategies.forTeam(teamId())!.id).every(review => review.state === 'pending')).toBe(true)
  })

  test('a strategy without an approved revision has no current review and no assessment', () => {
    const strategy = bench.strategies.create({ productId: 'kawai', title: 'Kawai', owner: { kind: 'human', sessionId: null }, teamId: teamId(), worktrees: [] })
    expect(detail()).toEqual({ currentReviewId: null, reviews: [], assessment: null })
    expect(strategy.currentApprovedRevision).toBeNull()
  })
})

describe('ImpactService.decide', () => {
  test('records a decision with the plan snapshot, and the review becomes Reviewed', async () => {
    const { planId, reviewId } = await bench.affectedPlan()
    expect(detail().reviews[0]!.state).toBe('needs-decisions')
    const outcome = await bench.impact.decide(bench.human, decideInput(planId, reviewId))
    if (!outcome.ok) throw new Error(outcome.message)
    expect(outcome.decision).toMatchObject({ disposition: 'continue', rationale: 'Still serves the revised purpose', actor: { kind: 'human' }, supersedesDecisionId: null })
    expect(outcome.decision.planSnapshot).toEqual([{ revision: 1, status: 'approved', pin: expect.objectContaining({ revision: 1 }) }])
    expect(detail().reviews[0]!.state).toBe('reviewed')
    expect(detail().assessment!.affected[0]!.effectiveDecision?.id).toBe(outcome.decision.id)
  })

  test('each refusal names its reason and writes nothing', async () => {
    const { planId, reviewId } = await bench.affectedPlan()
    const { planId: unaffected } = await bench.draftInReview()
    const cases: Array<[Promise<{ ok: boolean; reason?: string; message?: string }>, string, string]> = [
      [bench.impact.decide(bench.agent('lead'), decideInput(planId, reviewId)), 'forbidden', 'Only the human'],
      [bench.impact.decide(bench.human, decideInput(planId, reviewId, { commandId: ' ' })), 'invalid', 'command id'],
      [bench.impact.decide(bench.human, decideInput(planId, reviewId, { rationale: '  ' })), 'invalid', 'rationale is required'],
      [bench.impact.decide(bench.human, decideInput(planId, reviewId, { rationale: 'x'.repeat(2001) })), 'invalid', '2001 characters'],
      [bench.impact.decide(bench.human, decideInput(planId, 'impact-unknown')), 'not-found', 'Impact review not found'],
      [bench.impact.decide(bench.human, decideInput('plan-unknown', reviewId)), 'not-found', 'Plan not found'],
      [bench.impact.decide(bench.human, decideInput(unaffected, reviewId)), 'state', 'unaffected'],
      [bench.impact.decide(bench.human, decideInput(planId, reviewId, { proposalId: 'impact-proposal-x' })), 'invalid', 'not a proposal'],
      [bench.impact.decide(bench.human, decideInput(planId, reviewId, { expectedDecisionId: 'impact-decision-x' })), 'stale', 'no longer effective'],
    ]
    for (const [pending, reason, text] of cases) {
      const outcome = await pending
      expect(outcome.ok).toBe(false)
      expect(outcome.reason).toBe(reason)
      expect(outcome.message).toContain(text)
    }
    expect(detail().reviews[0]!.decisions).toEqual([])
  })

  test('a historical plan is refused naming its group', async () => {
    const { planId, reviewId } = await bench.affectedPlan()
    await bench.service.close(bench.human, { planId, outcome: 'cancelled', reason: 'dropped', commandId: 'close-h' })
    expect(await bench.impact.decide(bench.human, decideInput(planId, reviewId))).toMatchObject({ ok: false, reason: 'state', message: expect.stringContaining('historical') })
  })

  test('a same-payload retry returns the decision; a changed payload is refused naming the field', async () => {
    const { planId, reviewId } = await bench.affectedPlan()
    const input = decideInput(planId, reviewId)
    const first = await bench.impact.decide(bench.human, input)
    const again = await bench.impact.decide(bench.human, { ...input, rationale: `  ${input.rationale} ` })
    expect(again).toMatchObject({ ok: true, replayed: true })
    expect(first.ok && again.ok && again.decision.id === first.decision.id).toBe(true)
    expect(await bench.impact.decide(bench.human, { ...input, disposition: 'adapt' })).toMatchObject({ ok: false, reason: 'payload', message: expect.stringContaining('different disposition') })
    expect(detail().reviews[0]!.decisions).toHaveLength(1)
  })

  test('a later decision supersedes the earlier one; both stay readable', async () => {
    const { planId, reviewId } = await bench.affectedPlan()
    const first = await bench.impact.decide(bench.human, decideInput(planId, reviewId))
    if (!first.ok) throw new Error(first.message)
    const second = await bench.impact.decide(bench.human, decideInput(planId, reviewId, { disposition: 'adapt', expectedDecisionId: first.decision.id }))
    if (!second.ok) throw new Error(second.message)
    expect(second.decision.supersedesDecisionId).toBe(first.decision.id)
    const row = detail().assessment!.affected[0]!
    expect(row.effectiveDecision?.id).toBe(second.decision.id)
    expect(row.decisionHistory.map(decision => decision.disposition)).toEqual(['continue', 'adapt'])
  })

  test('two decisions racing on one predecessor leave one; the loser is refused naming the recorded decision', async () => {
    const { planId, reviewId } = await bench.affectedPlan()
    const [a, b] = await Promise.all([
      bench.impact.decide(bench.human, decideInput(planId, reviewId, { disposition: 'continue' })),
      bench.impact.decide(bench.human, decideInput(planId, reviewId, { disposition: 'reconsider' })),
    ])
    const winner = [a, b].find(outcome => outcome.ok)
    const loser = [a, b].find(outcome => !outcome.ok)
    if (!winner?.ok || !loser || loser.ok) throw new Error('expected one winner and one loser')
    expect(loser).toMatchObject({ reason: 'stale', message: expect.stringContaining(winner.decision.id) })
    expect(detail().reviews[0]!.decisions).toHaveLength(1)
  })

  test('when the chain index is what refuses the loser, it is still refused as stale naming the winner', async () => {
    const { planId, reviewId } = await bench.affectedPlan()
    const winner = await bench.impact.decide(bench.human, decideInput(planId, reviewId))
    if (!winner.ok) throw new Error(winner.message)
    // The loser read the chain head before the winner committed: its step 6 passes and the index refuses the insert.
    const store = bench.impact.store
    const chainHead = store.chainHead.bind(store)
    let calls = 0
    store.chainHead = (review, plan) => (++calls === 1 ? null : chainHead(review, plan))
    const loser = await bench.impact.decide(bench.human, decideInput(planId, reviewId, { disposition: 'adapt' }))
    store.chainHead = chainHead
    expect(loser).toMatchObject({ ok: false, reason: 'stale', message: expect.stringContaining(winner.decision.id) })
    expect(detail().reviews[0]!.decisions).toHaveLength(1)
  })

  test('a concurrent resend of the same command resolves as its replay, whichever constraint is reported', async () => {
    const { planId, reviewId } = await bench.affectedPlan()
    const input = decideInput(planId, reviewId)
    const first = await bench.impact.decide(bench.human, input)
    if (!first.ok) throw new Error(first.message)
    // The resend missed the recorded row inside its transaction, and passed the predecessor check:
    // its insert violates both the command id and the chain index.
    const store = bench.impact.store
    const byCommand = store.decisionByCommand.bind(store)
    const chainHead = store.chainHead.bind(store)
    let lookups = 0
    store.decisionByCommand = (strategy, command) => (++lookups === 1 ? null : byCommand(strategy, command))
    store.chainHead = () => null
    const resend = await bench.impact.decide(bench.human, input)
    store.decisionByCommand = byCommand
    store.chainHead = chainHead
    expect(resend).toMatchObject({ ok: true, replayed: true, decision: { id: first.decision.id } })
    expect(detail().reviews[0]!.decisions).toHaveLength(1)
  })

  test('deciding writes no plan, revision, task, message, or spawn', async () => {
    const { planId, reviewId } = await bench.affectedPlan()
    const before = bench.counts()
    const first = await bench.impact.decide(bench.human, decideInput(planId, reviewId, { disposition: 'adapt' }))
    if (!first.ok) throw new Error(first.message)
    await bench.impact.decide(bench.human, decideInput(planId, reviewId, { disposition: 'reconsider', expectedDecisionId: first.decision.id }))
    expect(bench.counts()).toEqual(before)
    expect(bench.plans.get(planId)!.lifecycle).toBe('open')
  })

  test('deciding on a superseded review is refused as stale', async () => {
    const { planId, reviewId } = await bench.affectedPlan()
    bench.approveStrategy({ purpose: 'Fourth' })
    expect(await bench.impact.decide(bench.human, decideInput(planId, reviewId))).toMatchObject({ ok: false, reason: 'stale', message: expect.stringContaining('no longer current') })
  })

  test("another team's review reads as not found", async () => {
    const { planId, reviewId } = await bench.affectedPlan()
    const other = { kind: 'human' as const, team: world.otherTeam }
    expect(await bench.impact.decide(other, decideInput(planId, reviewId))).toMatchObject({ ok: false, reason: 'not-found' })
  })

  test("a team with its own strategy deciding on another team's plan reads it as not found and writes nothing", async () => {
    const { planId } = await bench.affectedPlan()
    const otherReview = bench.approveOtherStrategy()
    const before = bench.counts()
    const other = { kind: 'human' as const, team: world.otherTeam }
    expect(await bench.impact.decide(other, decideInput(planId, otherReview)))
      .toMatchObject({ ok: false, reason: 'not-found', message: expect.stringContaining('Plan not found') })
    expect(bench.counts()).toEqual(before)
    expect(bench.impact.detail(world.otherTeam.teamId)!.reviews[0]!.decisions).toEqual([])
    expect(detail().reviews[0]!.decisions).toEqual([])
  })
})

describe('ImpactService.propose', () => {
  test('a proposal is recorded with its author, changes no gate, and the owner can record it naming it', async () => {
    const { planId, reviewId } = await bench.affectedPlan()
    const proposal = await bench.impact.propose(bench.agent('lead'), { planId, disposition: 'continue', rationale: 'Plan still fits revision 2' })
    expect(proposal).toMatchObject({ reviewId, planId, disposition: 'continue', author: { kind: 'agent', sessionId: 'lead' } })
    const row = detail().assessment!.affected[0]!
    expect([row.effectiveDecision, row.latestProposal?.id, row.proposalCount]).toEqual([null, proposal.id, 1])
    expect(bench.impact.gate(planId, 1)?.state).toBe('decision-required')
    const mismatch = await bench.impact.decide(bench.human, decideInput(planId, reviewId, { disposition: 'adapt', proposalId: proposal.id }))
    expect(mismatch).toMatchObject({ ok: false, reason: 'invalid', message: expect.stringContaining('proposes continue') })
    const recorded = await bench.impact.decide(bench.human, decideInput(planId, reviewId, { proposalId: proposal.id, rationale: 'Edited by the owner' }))
    expect(recorded).toMatchObject({ ok: true, decision: { proposalId: proposal.id, rationale: 'Edited by the owner' } })
  })

  test('a stale review, an unaffected plan, a team without a strategy record, the human, and bad rationales are refused with nothing recorded', async () => {
    const { planId, reviewId } = await bench.affectedPlan()
    const { planId: unaffected } = await bench.draftInReview()
    const refused = async (call: Promise<unknown>, text: string) => {
      let message = ''
      try { await call } catch (error) { message = String(error) }
      expect(message).toContain(text)
    }
    await refused(bench.impact.propose(bench.agent('lead'), { planId: unaffected, disposition: 'adapt', rationale: 'x' }), 'unaffected')
    await refused(bench.impact.propose(bench.agent('stranger'), { planId, disposition: 'adapt', rationale: 'x' }), 'no strategy record')
    await refused(bench.impact.propose(bench.agent('lead'), { planId, disposition: 'adapt', rationale: ' ' }), 'rationale is required')
    await refused(bench.impact.propose(bench.agent('lead'), { planId, disposition: 'adapt', rationale: 'y'.repeat(2001) }), '2001 characters')
    await refused(bench.impact.propose(bench.human, { planId, disposition: 'adapt', rationale: 'x' }), 'owner records decisions')
    bench.approveStrategy({ purpose: 'Newer' })
    await refused(bench.impact.propose(bench.agent('lead'), { planId, disposition: 'adapt', rationale: 'x', reviewId }), 'no longer current')
    expect(bench.impact.store.proposals(bench.strategies.forTeam(teamId())!.id)).toEqual([])
  })

  test("an agent whose team has its own strategy proposing on another team's plan reads it as not found", async () => {
    const { planId } = await bench.affectedPlan()
    bench.approveOtherStrategy()
    let message = ''
    try { await bench.impact.propose(bench.agent('stranger'), { planId, disposition: 'adapt', rationale: 'x' }) } catch (error) { message = String(error) }
    expect(message).toContain('Plan not found')
    for (const team of [world.team, world.otherTeam]) {
      expect(bench.impact.store.proposals(bench.strategies.forTeam(team.teamId)!.id)).toEqual([])
    }
  })
})
