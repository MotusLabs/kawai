// Plan withdrawal and closing (durable-plans 4.3): withdraw and discard,
// complete, cancel, and reopen, each replaying by command id over its
// compared payload and recording its event; the reason rules; closed-plan
// refusals of submission and approval; and closing never touching tasks.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import { createPlanBench, createPlanWorld, type PlanBench, type PlanWorld } from './planHarness'

let world: PlanWorld
let bench: PlanBench
beforeAll(async () => { world = await createPlanWorld('kawai-plan-lifecycle-') })
afterAll(() => fs.rmSync(world.root, { recursive: true, force: true }))
beforeEach(() => {
  bench?.db.close()
  bench = createPlanBench(world)
})

const kinds = (planId: string) => bench.plans.events(planId).map(event => event.kind)
const linkTask = (planId: string, change: string, status: 'active' | 'done' | 'cancelled' = 'active') => {
  const task = bench.tasks.create({ teamId: world.team.teamId, title: change, direction: 'Do it', creator: { kind: 'agent', sessionId: 'lead' }, planId, planChange: change })
  return bench.tasks.setStatus(task.id, status)!
}
const close = (planId: string, outcome: 'completed' | 'cancelled', reason: string | null, commandId = 'close') =>
  bench.service.close(bench.human, { planId, outcome, reason, commandId })

describe('withdraw and discard', () => {
  test('an in-review revision is withdrawn, stays readable, and the history shows it', async () => {
    const { planId, revision } = await bench.draftInReview()
    const outcome = await bench.service.withdraw(bench.human, { planId, revision, commandId: 'w' })
    expect(outcome).toMatchObject({ ok: true, event: { kind: 'withdrawn', revision } })
    expect(bench.plans.revision(planId, revision)).toMatchObject({ status: 'withdrawn', content: { goal: 'Durable plans the owner approves' } })
    expect(kinds(planId)).toEqual(['created', 'submitted', 'withdrawn'])
  })

  test('approved and superseded revisions cannot be withdrawn', async () => {
    const { planId, revision } = await bench.draftInReview()
    await bench.approve(planId, revision)
    expect(await bench.service.withdraw(bench.human, { planId, revision, commandId: 'w1' })).toMatchObject({ ok: false, reason: 'state' })
    const draft = bench.plans.getDraft(planId, 'lead')!
    await bench.service.saveDraft(bench.agent('lead'), { plan_id: planId, content: { ...draft.content, goal: 'Next' }, expected_draft_hash: draft.contentHash })
    await bench.service.submit(bench.agent('lead'), { plan_id: planId })
    await bench.approve(planId, 2)
    expect(await bench.service.withdraw(bench.human, { planId, revision: 1, commandId: 'w2' })).toMatchObject({ ok: false, reason: 'state' })
    expect(bench.plans.revisions(planId).map(entry => entry.status)).toEqual(['superseded', 'approved'])
  })

  test('a draft discard records the draft id and its last hash; a resend replays', async () => {
    const { planId } = await bench.draftInReview()
    const hash = bench.plans.getDraft(planId, 'lead')!.contentHash
    const input = { planId, draftId: 'lead', commandId: 'd' }
    expect(await bench.service.withdraw(bench.human, input)).toMatchObject({ ok: true, replayed: false, event: { kind: 'draft-discarded', draftId: 'lead', contentHash: hash } })
    expect(bench.plans.getDraft(planId, 'lead')).toBeNull()
    expect(await bench.service.withdraw(bench.human, input)).toMatchObject({ ok: true, replayed: true })
    expect(kinds(planId).filter(kind => kind === 'draft-discarded')).toHaveLength(1)
  })

  test('a withdraw resend replays; agents are refused', async () => {
    const { planId, revision } = await bench.draftInReview()
    await bench.service.withdraw(bench.human, { planId, revision, commandId: 'w' })
    expect(await bench.service.withdraw(bench.human, { planId, revision, commandId: 'w' })).toMatchObject({ ok: true, replayed: true })
    expect(await bench.service.withdraw(bench.agent('lead'), { planId, draftId: 'lead', commandId: 'x' })).toMatchObject({ ok: false, reason: 'forbidden' })
  })
})

describe('complete, cancel, reopen', () => {
  test('cancel without a reason is refused and the plan stays open', async () => {
    const { planId } = await bench.draftInReview()
    const outcome = await close(planId, 'cancelled', '  ')
    expect(outcome).toMatchObject({ ok: false, reason: 'invalid' })
    expect(!outcome.ok && outcome.message).toContain('needs a reason')
    expect(bench.plans.get(planId)!.lifecycle).toBe('open')
  })

  test('complete needs an approved revision, plus a reason while a change is not done', async () => {
    const { planId, revision } = await bench.draftInReview()
    expect(await close(planId, 'completed', null, 'c0')).toMatchObject({ ok: false, reason: 'state' })
    await bench.approve(planId, revision)
    const task = linkTask(planId, 'api')
    const refused = await close(planId, 'completed', null, 'c1')
    expect(!refused.ok && refused.message).toContain('Changes not done: api, ui')
    const done = await close(planId, 'completed', 'Shipping the rest later', 'c2')
    expect(done).toMatchObject({ ok: true, plan: { lifecycle: 'completed', state: 'completed' }, event: { kind: 'completed', reason: 'Shipping the rest later', commandId: 'c2' } })
    // Closing never touches linked tasks.
    expect(bench.tasks.get(task.id)!.status).toBe('active')
  })

  test('complete without a reason once every change is done', async () => {
    const { planId, revision } = await bench.draftInReview()
    await bench.approve(planId, revision)
    linkTask(planId, 'api', 'done')
    linkTask(planId, 'ui', 'done')
    expect(await close(planId, 'completed', null)).toMatchObject({ ok: true, event: { reason: null } })
  })

  test('reopen a cancelled plan: it accepts submissions and approvals, and its history shows both events', async () => {
    const { planId, revision } = await bench.draftInReview()
    await close(planId, 'cancelled', 'Paused')
    expect(await bench.approve(planId, revision)).toMatchObject({ ok: false, reason: 'precondition' })
    expect(await bench.service.reopen(bench.human, { planId, commandId: 'r' })).toMatchObject({ ok: true, plan: { lifecycle: 'open' } })
    expect((await bench.approve(planId, revision)).ok).toBe(true)
    expect(kinds(planId)).toEqual(['created', 'submitted', 'cancelled', 'reopened', 'approved'])
    expect(await bench.service.reopen(bench.human, { planId, commandId: 'r' })).toMatchObject({ ok: true, replayed: true })
    expect(await bench.service.reopen(bench.human, { planId, commandId: 'r2' })).toMatchObject({ ok: false, reason: 'state' })
  })

  test('a close resend replays — also when its reason differs only in whitespace — and another outcome is refused naming outcome', async () => {
    const { planId } = await bench.draftInReview()
    const first = await close(planId, 'cancelled', 'Dropped')
    expect(await close(planId, 'cancelled', '  Dropped \n')).toMatchObject({ ok: true, replayed: true, event: { id: first.ok ? first.event.id : '' } })
    const other = await close(planId, 'completed', 'Dropped')
    expect(other).toMatchObject({ ok: false, reason: 'payload' })
    expect(!other.ok && other.message).toContain('different outcome')
    expect(kinds(planId).filter(kind => kind === 'cancelled')).toHaveLength(1)
  })

  test('agents cannot close or reopen; another team\'s plan is not found', async () => {
    const { planId } = await bench.draftInReview()
    expect(await bench.service.close(bench.agent('lead'), { planId, outcome: 'cancelled', reason: 'x', commandId: 'a' })).toMatchObject({ ok: false, reason: 'forbidden' })
    expect(await bench.service.reopen(bench.agent('lead'), { planId, commandId: 'a' })).toMatchObject({ ok: false, reason: 'forbidden' })
    const otherHuman = { kind: 'human' as const, team: world.otherTeam }
    expect(await bench.service.close(otherHuman, { planId, outcome: 'cancelled', reason: 'x', commandId: 'a' })).toMatchObject({ ok: false, reason: 'not-found' })
    expect(await bench.service.approve(otherHuman, { planId, revision: 1, contentHash: 'h', expectedApprovedRevision: null, commandId: 'a' })).toMatchObject({ ok: false, reason: 'not-found' })
  })

  test('a killed creator leaves the plan; the human still approves and closes it', async () => {
    const { planId, revision } = await bench.draftInReview()
    bench.records.delete('lead')
    expect((await bench.approve(planId, revision)).ok).toBe(true)
    expect((await close(planId, 'cancelled', 'Done with it')).ok).toBe(true)
    expect(bench.plans.detail(planId)!.drafts.map(draft => draft.draftId)).toEqual(['lead'])
  })
})
