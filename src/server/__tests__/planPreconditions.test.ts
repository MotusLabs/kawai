// Approval preconditions (durable-plans 4.1): each shipped entry failing
// alone with its name and message, several failing together, a stale
// strategy pin (including an unpinned submission followed by a strategy
// approval), and a disposition stub proving the extension point.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import { APPROVAL_PRECONDITIONS } from '../plans/planPreconditions'
import { createPlanBench, createPlanWorld, type PlanBench, type PlanWorld } from './planHarness'

let world: PlanWorld
let bench: PlanBench
beforeAll(async () => { world = await createPlanWorld('kawai-plan-preconditions-') })
afterAll(() => fs.rmSync(world.root, { recursive: true, force: true }))
beforeEach(() => {
  bench?.db.close()
  bench = createPlanBench(world)
})

const names = (outcome: Awaited<ReturnType<PlanBench['approve']>>) => (outcome.ok ? [] : (outcome.failures ?? []).map(failure => failure.name))

describe('APPROVAL_PRECONDITIONS', () => {
  test('ship in order', () => {
    expect(APPROVAL_PRECONDITIONS.map(entry => entry.name)).toEqual(['plan-open', 'revision-in-review', 'hash-matches', 'approved-revision-unchanged', 'strategy-pin-current'])
  })

  test('plan-open fails alone for a cancelled plan', async () => {
    const { planId, revision } = await bench.draftInReview()
    await bench.service.close(bench.human, { planId, outcome: 'cancelled', reason: 'Dropped', commandId: 'c' })
    const outcome = await bench.approve(planId, revision)
    expect(names(outcome)).toEqual(['plan-open'])
    expect(!outcome.ok && outcome.failures![0]!.message).toContain('reopen it')
  })

  test('revision-in-review fails alone for a withdrawn revision', async () => {
    const { planId, revision } = await bench.draftInReview()
    await bench.service.withdraw(bench.human, { planId, revision, commandId: 'w' })
    expect(names(await bench.approve(planId, revision))).toEqual(['revision-in-review'])
  })

  test('hash-matches fails alone for another hash', async () => {
    const { planId, revision } = await bench.draftInReview()
    const outcome = await bench.service.approve(bench.human, { planId, revision, contentHash: 'other', expectedApprovedRevision: null, commandId: 'a' })
    expect(names(outcome)).toEqual(['hash-matches'])
    expect(bench.plans.revision(planId, revision)!.status).toBe('in_review')
  })

  test('approved-revision-unchanged fails alone for a stale expectation', async () => {
    const { planId, revision, hash } = await bench.draftInReview()
    expect(names(await bench.service.approve(bench.human, { planId, revision, contentHash: hash, expectedApprovedRevision: 4, commandId: 'a' })))
      .toEqual(['approved-revision-unchanged'])
  })

  test('several failures are named together', async () => {
    const { planId, revision } = await bench.draftInReview()
    await bench.service.withdraw(bench.human, { planId, revision, commandId: 'w' })
    const outcome = await bench.service.approve(bench.human, { planId, revision, contentHash: 'wrong', expectedApprovedRevision: null, commandId: 'a' })
    expect(names(outcome)).toEqual(['revision-in-review', 'hash-matches'])
    expect(!outcome.ok && outcome.message).toContain('revision-in-review: ')
  })

  test('strategy-pin-current: a strategy approved after a pinned or unpinned submission', async () => {
    const unpinned = await bench.draftInReview()
    bench.approveStrategy()
    const outcome = await bench.approve(unpinned.planId, unpinned.revision)
    expect(names(outcome)).toEqual(['strategy-pin-current'])
    expect(!outcome.ok && outcome.failures![0]!.message).toContain('resubmit')
    const pinned = await bench.draftInReview({ goal: 'Pinned' })
    bench.approveStrategy({ useCases: [{ ref: 'UC1' }, { ref: 'UC3' }] })
    expect(names(await bench.approve(pinned.planId, pinned.revision))).toEqual(['strategy-pin-current'])
    // Resubmission re-pins, and the new revision can be approved.
    const resubmitted = await bench.service.submit(bench.agent('lead'), { plan_id: pinned.planId })
    expect(resubmitted.ok && resubmitted.created && resubmitted.revision.pin?.revision).toBe(2)
    expect((await bench.approve(pinned.planId, resubmitted.ok ? resubmitted.revision.revision : 0)).ok).toBe(true)
  })

  test('a disposition stub lets a stale pin pass: the extension point', async () => {
    bench.db.close()
    const seen: Array<[string, number]> = []
    bench = createPlanBench(world, { pinDisposition: (planId, revision) => { seen.push([planId, revision]); return { kind: 'keep-pin' } } })
    const { planId, revision } = await bench.draftInReview()
    bench.approveStrategy()
    expect((await bench.approve(planId, revision)).ok).toBe(true)
    expect(seen).toEqual([[planId, revision]])
  })

  test('an appended precondition runs after the shipped ones without editing them', async () => {
    bench.db.close()
    bench = createPlanBench(world, { preconditions: [...APPROVAL_PRECONDITIONS, { name: 'validation-current', check: () => 'Validate the plan first.' }] })
    const { planId, revision } = await bench.draftInReview()
    expect(names(await bench.approve(planId, revision))).toEqual(['validation-current'])
  })
})
