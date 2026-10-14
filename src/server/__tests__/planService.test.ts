// Plan drafting and submission (durable-plans 3.1/3.2): create writes the
// plan, its creator's draft, and a created event together; saves are
// CAS-guarded and structure-checked; submission pins the team's current
// approved strategy on the server, checks alignment refs against it,
// deduplicates, and refuses closed plans and incomplete drafts.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import { normalizePlanContent } from '../../shared/plans'
import { planInput } from '../../shared/__tests__/planFixtures'
import { createPlanBench, createPlanWorld, type PlanBench, type PlanWorld } from './planHarness'

let world: PlanWorld
let bench: PlanBench
beforeAll(async () => { world = await createPlanWorld('kawai-plan-service-') })
afterAll(() => fs.rmSync(world.root, { recursive: true, force: true }))
beforeEach(() => {
  bench?.db.close()
  bench = createPlanBench(world)
})

const counts = () => Object.fromEntries(['team_tasks', 'team_messages', 'plan_revisions', 'plan_events'].map(table =>
  [table, (bench.db.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n]))

describe('create', () => {
  test('writes the plan, the creator draft, and a created event in one transaction', async () => {
    const { plan, draft } = await bench.service.create(bench.agent('lead'), { title: ' Wave C ' })
    expect(plan).toMatchObject({ title: 'Wave C', lifecycle: 'open', state: 'draft', creator: { kind: 'agent', sessionId: 'lead' } })
    expect(draft).toMatchObject({ draftId: 'lead', content: normalizePlanContent({}) })
    expect(bench.plans.events(plan.id).map(event => [event.kind, event.draftId])).toEqual([['created', 'lead']])
  })

  test('refused without canCreatePlans, and for structurally invalid content', async () => {
    await expect(bench.service.create(bench.agent('dev'), { title: 'Mine' })).rejects.toThrow(/canCreatePlans: true/)
    await expect(bench.service.create(bench.agent('lead'), { title: 'Bad', content: { changes: [{ change: 'A' }] } })).rejects.toThrow(/kebab-case/)
    expect(bench.plans.list(world.team.teamId)).toEqual([])
  })
})

describe('saveDraft', () => {
  test('a concurrent save is refused with the first writer\'s draft returned', async () => {
    const { plan, draft } = await bench.service.create(bench.agent('lead'), { title: 'Wave C' })
    const first = await bench.service.saveDraft(bench.agent('lead'), { plan_id: plan.id, content: planInput(), expected_draft_hash: draft.contentHash })
    expect(first.ok).toBe(true)
    const second = await bench.service.saveDraft(bench.agent('dev'), { plan_id: plan.id, draft_id: 'lead', content: planInput({ goal: 'Other' }), expected_draft_hash: draft.contentHash })
    expect(second).toMatchObject({ ok: false, reason: 'conflict' })
    expect(second.ok === false && second.stored?.content.goal).toBe('Durable plans the owner approves')
  })

  test('a replacement author continues a draft by id and becomes its author', async () => {
    const { plan, draft } = await bench.service.create(bench.agent('lead'), { title: 'Wave C' })
    bench.records.delete('lead')
    const saved = await bench.service.saveDraft(bench.agent('lead2'), { plan_id: plan.id, draft_id: 'lead', content: planInput(), expected_draft_hash: draft.contentHash, expected_base_revision: null })
    expect(saved).toMatchObject({ ok: true, draft: { draftId: 'lead', author: { kind: 'agent', sessionId: 'lead2' } } })
  })

  test('a structure refusal leaves the draft unchanged and names every violation', async () => {
    const { plan, draft } = await bench.service.create(bench.agent('lead'), { title: 'Wave C' })
    const refused = await bench.service.saveDraft(bench.agent('lead'), {
      plan_id: plan.id, expected_draft_hash: draft.contentHash,
      content: planInput({ changes: [{ change: 'a', dependsOn: ['b'] }, { change: 'b', dependsOn: ['a'] }, { change: 'ui', dependsOn: ['api'] }] }),
    })
    expect(refused).toMatchObject({ ok: false, reason: 'structure' })
    expect(refused.ok === false && refused.reason === 'structure' && refused.errors).toEqual([
      'Change "ui" depends on "api", which is unknown: the plan lists no change "api".',
      'Dependency cycle: a → b → a.',
    ])
    expect(bench.plans.getDraft(plan.id, 'lead')).toEqual(draft)
  })

  test('saving an incomplete draft is allowed and touches no revision, task, or mail row', async () => {
    const { plan, draft } = await bench.service.create(bench.agent('lead'), { title: 'Wave C' })
    const before = counts()
    const saved = await bench.service.saveDraft(bench.agent('lead'), { plan_id: plan.id, content: { goal: 'Only a goal' }, expected_draft_hash: draft.contentHash })
    expect(saved.ok).toBe(true)
    expect(counts()).toEqual(before)
  })

  test('another team\'s plan reads as not found', async () => {
    const { plan } = await bench.service.create(bench.agent('lead'), { title: 'Wave C' })
    await expect(bench.service.saveDraft(bench.agent('stranger'), { plan_id: plan.id, content: {} })).rejects.toThrow(`Plan not found in this team: ${plan.id}`)
    await expect(bench.service.get(bench.agent('stranger'), plan.id)).rejects.toThrow('not found')
  })
})

describe('submit', () => {
  test('the pin is the current approved strategy revision, whatever the draft says', async () => {
    bench.approveStrategy()
    const strategy = bench.approveStrategy({ useCases: [{ ref: 'UC1' }, { ref: 'UC2' }] })
    const { planId, revision } = await bench.draftInReview({ pin: { strategyId: 'forged', revision: 9, hash: 'x' }, strategyPin: 'forged', alignment: { statement: 's', refs: ['UC2'] } })
    expect(bench.plans.revision(planId, revision)).toMatchObject({ status: 'in_review', pin: strategy })
    expect(bench.plans.summary(bench.plans.get(planId)!).state).toBe('draft')
  })

  test('no strategy record, and a strategy without an approved revision, both give an empty pin', async () => {
    const first = await bench.draftInReview()
    expect(bench.plans.revision(first.planId, first.revision)!.pin).toBeNull()
    bench.strategies.create({ productId: 'kawai', title: 'Kawai', owner: { kind: 'human', sessionId: null }, teamId: world.team.teamId, worktrees: [] })
    const second = await bench.draftInReview({ goal: 'Another' })
    expect(bench.plans.revision(second.planId, second.revision)!.pin).toBeNull()
  })

  test('an unknown reference is refused, as is any reference without a pin', async () => {
    const { plan } = await bench.service.create(bench.agent('lead'), { title: 'Wave C', content: planInput({ alignment: { statement: 's', refs: ['UC9'] } }) })
    const unpinned = await bench.service.submit(bench.agent('lead'), { plan_id: plan.id })
    expect(unpinned).toMatchObject({ ok: false, reason: 'alignment' })
    expect(unpinned.ok === false && unpinned.message).toContain('"UC9" cannot be checked')
    bench.approveStrategy()
    const pinned = await bench.service.submit(bench.agent('lead'), { plan_id: plan.id })
    expect(pinned.ok === false && pinned.message).toContain('"UC9" is not defined by strategy revision 1')
    expect(bench.plans.revisions(plan.id)).toEqual([])
  })

  test('a decision ref is accepted, and a claim ref is refused', async () => {
    bench.approveStrategy()
    expect((await bench.draftInReview({ alignment: { statement: 's', refs: ['D1', 'UC1', 'P4'] } })).revision).toBe(1)
    const { plan } = await bench.service.create(bench.agent('lead'), { title: 'Claims', content: planInput({ alignment: { statement: 's', refs: ['C1'] } }) })
    expect(await bench.service.submit(bench.agent('lead'), { plan_id: plan.id })).toMatchObject({ ok: false, reason: 'alignment' })
  })

  test('an unchanged resubmission returns the existing number and writes nothing', async () => {
    const { planId, revision } = await bench.draftInReview()
    const before = counts()
    const again = await bench.service.submit(bench.agent('lead'), { plan_id: planId })
    expect(again).toMatchObject({ ok: true, created: false, revision: { revision } })
    expect(counts()).toEqual(before)
    // The approved revision deduplicates too.
    await bench.approve(planId, revision)
    expect(await bench.service.submit(bench.agent('lead'), { plan_id: planId })).toMatchObject({ ok: true, created: false, revision: { revision, status: 'approved' } })
  })

  test('an incomplete draft is refused naming every gap, and no revision is created', async () => {
    const { plan } = await bench.service.create(bench.agent('lead'), {
      title: 'Wave C', content: { goal: 'g', changes: [{ change: 'api', group: 'middle-devs' }], roles: [{ group: 'middle-devs' }] },
    })
    const refused = await bench.service.submit(bench.agent('lead'), { plan_id: plan.id })
    expect(refused.ok === false && refused.errors).toEqual([
      'The plan needs at least one success criterion.', 'Change "api" needs a review group (its own, or the plan\'s).',
    ])
    expect(bench.plans.revisions(plan.id)).toEqual([])
  })

  test('a cancelled plan refuses submission; a missing draft is named', async () => {
    const { plan } = await bench.service.create(bench.agent('lead'), { title: 'Wave C', content: planInput() })
    expect(await bench.service.submit(bench.agent('dev'), { plan_id: plan.id })).toMatchObject({ ok: false, reason: 'no-draft' })
    await bench.service.close(bench.human, { planId: plan.id, outcome: 'cancelled', reason: 'Dropped', commandId: 'c1' })
    expect(await bench.service.submit(bench.agent('lead'), { plan_id: plan.id })).toMatchObject({ ok: false, reason: 'closed' })
  })

  test('two key orders submitted under the same pin carry the same hash', async () => {
    const a = await bench.draftInReview()
    const reversed = Object.fromEntries(Object.entries(planInput()).reverse())
    const { plan } = await bench.service.create(bench.agent('lead'), { title: 'Same', content: reversed })
    const b = await bench.service.submit(bench.agent('lead'), { plan_id: plan.id })
    expect(b.ok && b.revision.contentHash).toBe(a.hash)
  })
})
