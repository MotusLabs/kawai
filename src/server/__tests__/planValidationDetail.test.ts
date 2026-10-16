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
