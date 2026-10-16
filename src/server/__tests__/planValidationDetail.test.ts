// The coalesced validation view (plan-validation design D11): at most one
// build per plan every 2 s, busted the moment a validation row is written —
// so bursts of linked-task pushes pay one build, and a push after a
// validation, assessment, or decision never shows a snapshot that predates
// the write.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { createPlanBench, createPlanWorld, type PlanBench, type PlanWorld } from './planHarness'
import { ImpactService } from '../strategy/ImpactService'
import { ImpactStore } from '../strategy/impactStore'
import { MailboxStore } from '../team/mailboxStore'
import { composePlanServices } from '../plans/planComposition'
import { ValidationDetailCache } from '../plans/validation/validationDetail'
import type { OpenspecAdapter } from '../plans/validation/openspecAdapter'

let world: PlanWorld
let bench: PlanBench
let adapter: OpenspecAdapter
beforeAll(async () => {
  world = await createPlanWorld('kawai-plan-validation-detail-')
  for (const change of ['api', 'ui']) {
    fs.mkdirSync(path.join(world.repo, 'openspec', 'changes', change, 'specs', 'chat'), { recursive: true })
    fs.writeFileSync(path.join(world.repo, 'openspec', 'changes', change, 'proposal.md'), `# ${change}\n`)
  }
  fs.writeFileSync(path.join(world.repo, '.kawai', 'groups', 'reviewers.md'), 'Review.')
  adapter = {
    probe: async () => ({ tool: 'openspec', version: '1.14.2', capabilities: ['validate-strict-json', 'show-deltas-json'], ok: true, error: null }),
    validate: async () => ({ ok: true, error: null, valid: true, issues: [], issueCount: 0 }),
    showDeltas: async () => ({ ok: true, error: null, touches: [] }),
  } as unknown as OpenspecAdapter
})
afterAll(() => {
  bench?.db.close()
  fs.rmSync(world.root, { recursive: true, force: true })
})

test('coalesces bursts to one build per plan every 2 s, busted by a write', async () => {
  bench = createPlanBench(world)
  const impact = new ImpactService(new ImpactStore(bench.db.db), {
    strategies: bench.strategies, plans: bench.plans, mail: new MailboxStore(bench.db.db), getSession: id => bench.records.get(id), homeDir: world.home,
  })
  const composed = composePlanServices({
    db: bench.db.db, plans: bench.plans, strategies: bench.strategies, impact, adapter,
    getSession: id => bench.records.get(id), homeDir: world.home,
  })
  const { planId, revision } = await bench.draftInReview()
  let now = 1_000_000
  const cache = new ValidationDetailCache(composed.validation, () => now)

  // A burst of linked-task pushes within the window shares one build.
  const first = cache.detail(planId)
  await first
  for (let burst = 0; burst < 8; burst += 1) {
    expect(cache.detail(planId)).toBe(first)
  }

  // A validation write busts the cache at once, even inside the window.
  await composed.validation.validate({ kind: 'human', team: world.team }, { planId, revision })
  const afterWrite = cache.detail(planId)
  expect(afterWrite).not.toBe(first)
  await afterWrite
  expect((await afterWrite)[0]!.report).toMatchObject({ seq: 1 })

  // The window passing builds again: the standing reflects a fresh edit.
  now += 2_001
  const afterWindow = cache.detail(planId)
  await afterWindow
  fs.writeFileSync(path.join(world.repo, 'openspec', 'changes', 'api', 'proposal.md'), '# api (edited)\\n')
  now += 2_001
  const fresh = await cache.detail(planId)
  expect(fresh[0]!.standing).toMatchObject({ state: 'out-of-date', changedParts: expect.arrayContaining(["api's artifacts"]) })
})

test('a plan write busts the cache inside the window: withdraw then submit each push fresh standing revisions (M-1)', async () => {
  bench = createPlanBench(world)
  const impact = new ImpactService(new ImpactStore(bench.db.db), {
    strategies: bench.strategies, plans: bench.plans, mail: new MailboxStore(bench.db.db), getSession: id => bench.records.get(id), homeDir: world.home,
  })
  const composed = composePlanServices({
    db: bench.db.db, plans: bench.plans, strategies: bench.strategies, impact, adapter,
    getSession: id => bench.records.get(id), homeDir: world.home,
  })
  const { planId, revision } = await bench.draftInReview()
  const now = 1_000_000
  const cache = new ValidationDetailCache(composed.validation, () => now)
  const first = await cache.detail(planId)
  expect(first.map(entry => entry.revision)).toEqual([revision])

  // A withdraw inside the 2 s window: the plan push path invalidates first
  // (planConnections.publish), so the next detail build sees no standing
  // revisions — exactly what the pushed detail then carries.
  const withdrawn = await composed.plans.withdraw({ kind: 'human', team: world.team }, { planId, revision, commandId: 'withdraw-1' })
  expect(withdrawn.ok).toBe(true)
  cache.invalidate(planId)
  expect(await cache.detail(planId)).toEqual([])

  // A resubmit inside the window: the new standing revision appears at once.
  const saved = await composed.plans.saveDraft({ kind: 'agent', sessionId: 'lead' }, {
    plan_id: planId, content: (await composed.plans.get({ kind: 'agent', sessionId: 'lead' }, planId)).drafts[0]!.content,
    expected_draft_hash: (await composed.plans.get({ kind: 'agent', sessionId: 'lead' }, planId)).drafts[0]!.contentHash,
  })
  expect(saved.ok).toBe(true)
  const submitted = await composed.plans.submit({ kind: 'agent', sessionId: 'lead' }, { plan_id: planId })
  expect(submitted.ok).toBe(true)
  cache.invalidate(planId)
  const afterSubmit = await cache.detail(planId)
  expect(afterSubmit.map(entry => entry.revision)).toEqual([2])
})

test('a slower older build rejects as superseded and never lands (L-1)', async () => {
  let releaseOld: (() => void) | null = null
  const oldBuild = new Promise<unknown>(resolve => { releaseOld = () => resolve(undefined) })
  let builds = 0
  const stub = {
    standingRevisions: () => [1],
    prepareStanding: async () => {
      builds += 1
      if (builds === 1) await oldBuild
      return { prepared: true }
    },
    standing: () => ({ state: 'current', report: { seq: 1 } }) as never,
    store: { writeStamp: 0, newestReport: () => null, assessments: () => [], decisions: () => [] },
  }
  const cache = new ValidationDetailCache(stub as never, () => 1_000_000)
  const old = cache.detail('plan-1')
  // The first build is in flight; a new generation starts before it lands.
  cache.invalidate('plan-1')
  const fresh = await cache.detail('plan-1')
  expect(fresh).toEqual([expect.objectContaining({ revision: 1 })])
  // The old build resolves now — after the newer one — and rejects as
  // superseded, so its awaiter drops the send instead of sending stale data.
  releaseOld!()
  let rejected = false
  await old.catch(() => { rejected = true })
  expect(rejected).toBe(true)
})
