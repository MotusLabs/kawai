// The plan services composition (plan-validation M1/M2): the one helper the
// manager and the benches call. A never-validated revision is refused by the
// composed PlanService with exactly `validation-current` — deleting the
// wiring breaks compilation here — and capacity evidence reads the team's
// OWN groups root, never the `.git` tail (M2).
import { afterAll, beforeAll, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { createPlanBench, createPlanWorld, type PlanBench, type PlanWorld } from './planHarness'
import { ImpactService } from '../strategy/ImpactService'
import { ImpactStore } from '../strategy/impactStore'
import { MailboxStore } from '../team/mailboxStore'
import { capacityEvidenceFor, composePlanServices, type CapacityReads } from '../plans/planComposition'
import type { OpenspecAdapter } from '../plans/validation/openspecAdapter'
import { planInput } from '../../shared/__tests__/planFixtures'

let world: PlanWorld
beforeAll(async () => {
  world = await createPlanWorld('kawai-plan-composition-')
  for (const change of ['api', 'ui']) {
    fs.mkdirSync(path.join(world.repo, 'openspec', 'changes', change, 'specs', 'chat'), { recursive: true })
    fs.writeFileSync(path.join(world.repo, 'openspec', 'changes', change, 'proposal.md'), `# ${change}\n`)
  }
  fs.writeFileSync(path.join(world.repo, '.kawai', 'groups', 'reviewers.md'), 'Review.')
})
afterAll(() => fs.rmSync(world.root, { recursive: true, force: true }))

const fakeAdapter = (): OpenspecAdapter => ({
  probe: async () => ({ tool: 'openspec', version: '1.14.2', capabilities: ['validate-strict-json', 'show-deltas-json'], ok: true, error: null }),
  validate: async () => ({ ok: true, error: null, valid: true, issues: [], issueCount: 0 }),
  showDeltas: async () => ({ ok: true, error: null, touches: [] }),
}) as unknown as OpenspecAdapter

let bench: PlanBench | null = null
afterAll(() => {
  bench?.db.close()
})

test('through the composition, a never-validated revision is refused with exactly validation-current (M1)', async () => {
  bench = createPlanBench(world)
  const impact = new ImpactService(new ImpactStore(bench.db.db), {
    strategies: bench.strategies, plans: bench.plans, mail: new MailboxStore(bench.db.db), getSession: id => bench!.records.get(id), homeDir: world.home,
  })
  const composed = composePlanServices({
    db: bench.db.db, plans: bench.plans, strategies: bench.strategies, impact, adapter: fakeAdapter(),
    getSession: id => bench!.records.get(id), homeDir: world.home,
  })
  const { plan } = await composed.plans.create({ kind: 'agent', sessionId: 'lead' }, { title: 'Wave C', content: planInput() })
  const submitted = await composed.plans.submit({ kind: 'agent', sessionId: 'lead' }, { plan_id: plan.id })
  if (!submitted.ok) throw new Error(submitted.message)
  const outcome = await composed.plans.approve({ kind: 'human', team: world.team }, {
    planId: plan.id, revision: submitted.revision.revision, contentHash: submitted.revision.contentHash,
    expectedApprovedRevision: null, commandId: 'approve-composition',
  })
  expect(outcome).toMatchObject({ ok: false, reason: 'precondition' })
  expect(outcome.ok === false && outcome.failures?.map(failure => failure.name)).toEqual(['validation-current'])
})

test('capacity evidence reads the team own groups root, never the .git tail (M2)', () => {
  const reads: CapacityReads = {
    capacity: () => ({ groupMembers: 3, onProfile: { default: 2, opus: 1 } }),
    cooldownUntil: profileId => (profileId === 'opus' ? '2026-10-16T12:00:00Z' : null),
  }
  // The middle-devs group is a PROJECT group (repo/.kawai/groups): the team's
  // own identity finds it; the wrong root (.git) finds nothing.
  const right = capacityEvidenceFor({ teamId: `${world.repo}/.git`, groupsRoot: world.repo }, 'middle-devs', reads, world.home)
  expect(right).toMatchObject({ group: 'middle-devs', live: 3 })
  const wrong = capacityEvidenceFor({ teamId: `${world.repo}/.git`, groupsRoot: `${world.repo}/.git` }, 'middle-devs', reads, world.home)
  expect(wrong).toBeNull()
  // The user-level leads group resolves through the home dir either way.
  const leads = capacityEvidenceFor({ teamId: `${world.repo}/.git`, groupsRoot: world.repo }, 'leads', reads, world.home)
  expect(leads).toMatchObject({ group: 'leads' })
})
