// strategy-revision-impact 3.5: the owner's assessment request — exactly one
// human, normal-priority group message with no task naming the review, the
// strategy revision, and each affected plan; a retry replays its message, a
// new command id sends again, and an unknown group, a stale review, and an
// agent caller are refused with nothing sent.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import { createPlanWorld, type PlanWorld } from './planHarness'
import { createImpactBench, type ImpactBench } from './impactHarness'

let world: PlanWorld
let bench: ImpactBench
beforeAll(async () => { world = await createPlanWorld('kawai-impact-request-') })
afterAll(() => fs.rmSync(world.root, { recursive: true, force: true }))
beforeEach(() => {
  bench?.db.close()
  bench = createImpactBench(world)
})

const messages = () => bench.mail.listForTeam(world.team.teamId)

describe('ImpactService.requestAssessment', () => {
  test('sends one human, normal-priority group message with no task, naming the review, revision, and affected plans', async () => {
    const { planId, reviewId } = await bench.affectedPlan()
    const outcome = await bench.impact.requestAssessment(bench.human, { reviewId, group: 'lead', commandId: 'request-1' })
    if (!outcome.ok) throw new Error(outcome.message)
    expect(outcome.replayed).toBe(false)
    const sent = messages()
    expect(sent).toHaveLength(1)
    const message = sent[0]!
    expect([message.id, message.fromKind, message.fromSession, message.toKind, message.toId, message.priority, message.taskId ?? null])
      .toEqual([outcome.messageId, 'human', null, 'group', 'lead', 'normal', null])
    expect(message.body).toContain(reviewId)
    expect(message.body).toContain('strategy revision 2')
    expect(message.body).toContain(planId)
    expect(message.body).toContain('Only the owner records decisions')
    const detail = bench.impact.detail(world.team.teamId)!
    expect(detail.reviews[0]!.requests).toMatchObject([{ reviewId, targetGroup: 'lead', messageId: outcome.messageId, commandId: 'request-1' }])
  })

  test('a retry returns the same message id; a new command id sends a second message', async () => {
    const { reviewId } = await bench.affectedPlan()
    const first = await bench.impact.requestAssessment(bench.human, { reviewId, group: 'lead', commandId: 'request-1' })
    const retry = await bench.impact.requestAssessment(bench.human, { reviewId, group: 'lead', commandId: 'request-1' })
    if (!first.ok || !retry.ok) throw new Error('refused')
    expect([retry.replayed, retry.messageId]).toEqual([true, first.messageId])
    expect(messages()).toHaveLength(1)
    const changed = await bench.impact.requestAssessment(bench.human, { reviewId, group: 'other', commandId: 'request-1' })
    expect(changed).toMatchObject({ ok: false, reason: 'payload', message: expect.stringContaining('group') })
    const second = await bench.impact.requestAssessment(bench.human, { reviewId, group: 'lead', commandId: 'request-2' })
    if (!second.ok) throw new Error(second.message)
    expect(second.messageId).not.toBe(first.messageId)
    expect(messages()).toHaveLength(2)
  })

  test('an unknown group, a stale review, an agent caller, and no strategy record are refused with no message', async () => {
    expect(await bench.impact.requestAssessment(bench.human, { reviewId: 'impact-x', group: 'lead', commandId: 'r-0' }))
      .toMatchObject({ ok: false, reason: 'not-found' })
    const { reviewId } = await bench.affectedPlan()
    expect(await bench.impact.requestAssessment(bench.human, { reviewId, group: 'nobody', commandId: 'r-1' }))
      .toMatchObject({ ok: false, reason: 'invalid', message: expect.stringContaining('Unknown group: nobody') })
    expect(await bench.impact.requestAssessment(bench.agent('lead'), { reviewId, group: 'lead', commandId: 'r-2' }))
      .toMatchObject({ ok: false, reason: 'forbidden' })
    bench.approveStrategy({ purpose: 'Third direction' })
    expect(await bench.impact.requestAssessment(bench.human, { reviewId, group: 'lead', commandId: 'r-3' }))
      .toMatchObject({ ok: false, reason: 'stale' })
    expect(messages()).toEqual([])
    expect(bench.impact.detail(world.team.teamId)!.reviews.flatMap(review => review.requests)).toEqual([])
  })
})
