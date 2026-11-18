// AT1 through the real workspace read (revision-control 9.3, design D13):
// `WorkspaceRead.snapshot` gathers the open plans' holds from the services
// `composePlanServices` attached to its PlanService and projects them
// through the real `ATTENTION_SOURCES`, so an overdue hold reaches the
// Team page's attention queue — and another team's snapshot never sees it.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import { WorkspaceRead } from '../team/workspaceRead'
import { composePlanServices } from '../plans/planComposition'
import { revisionControlOf } from '../plans/revisionControl/revisionControlServices'
import type { OpenspecAdapter } from '../plans/validation/openspecAdapter'
import { createPlanWorld, writeGroup, type PlanWorld } from './planHarness'
import { createImpactBench, type ImpactBench } from './impactHarness'

let world: PlanWorld
let bench: ImpactBench
let composed: ReturnType<typeof composePlanServices>

beforeAll(async () => {
  world = await createPlanWorld('kawai-rc-attention-')
  writeGroup(world, 'leads', '---\ncanCreatePlans: true\ncanCreateTasks: true\n---\nLead.')
  bench = createImpactBench(world)
  composed = composePlanServices({
    db: bench.db.db, plans: bench.plans, strategies: bench.strategies, impact: bench.impact,
    adapter: { probe: async () => ({ ok: true }) } as unknown as OpenspecAdapter,
    getSession: id => bench.records.get(id), homeDir: world.home,
  })
  bench.service = composed.plans
})

afterAll(() => {
  bench.db.close()
  fs.rmSync(world.root, { recursive: true, force: true })
})

/** The manager the snapshot reads: empty team facts beside the composed PlanService. */
const manager = () => ({
  plans: composed.plans,
  tasks: { store: {
    list: () => [], get: () => null,
    results: { get: () => null, outstandingSince: () => [], submittedBy: () => false },
    acknowledgements: { highest: () => null },
  } },
  mailbox: { store: { listForTeam: () => [], eventsFor: () => [] } },
  waitingFor: () => ({}),
  teamRecords: () => [],
  directory: { list: () => [] },
  getPendingRequests: () => [],
  teams: { catalogForTeam: () => ({ groups: new Map() }) },
  groupProfileCounts: () => ({}),
  teamApprovalDefault: () => null,
  turnEnds: { finishedForTeam: () => [] }, exhaustionEpisodes: () => [],
  outboundAudit: { violationGroups: () => [], windowCounts: () => ({ allowed: 0, unknown: 0, violations: 0 }) },
})

describe('AT1 through the real workspace read', () => {
  // @covers: plan-holds › Holds are released only by the owner › The deadline passes
  test('AT1: an open plan\'s active hold past its deadline reaches the snapshot\'s attention as plan-hold-overdue', async () => {
    const { planId } = await bench.draftInReview()
    // The service refuses a past deadline, so the overdue hold is a store row whose deadline already passed.
    const deadline = new Date(Date.now() - 60_000).toISOString()
    const hold = revisionControlOf(composed.plans)!.holds.deps.holds.insert({
      teamId: world.team.teamId, planId, scope: 'plan', rationale: 'rethink it', deadline, cites: null, commandId: 'at1-hold', changes: [],
    })
    const snapshot = new WorkspaceRead(manager() as never).snapshot(world.team)
    const items = snapshot.attention.filter(item => item.kind === 'plan-hold-overdue')
    expect(items).toEqual([{
      id: `plan-hold-overdue:${hold.id}:${deadline}`, kind: 'plan-hold-overdue',
      cause: expect.stringContaining(hold.id) as never, owner: { kind: 'human', id: null, label: 'Human' }, impact: {},
      nextAction: 'Release or extend the hold', link: { kind: 'plan', id: planId, planId }, requiresHuman: true,
    }])
    // Another team's snapshot never reads it.
    expect(new WorkspaceRead(manager() as never).snapshot(world.otherTeam).attention.filter(item => item.kind === 'plan-hold-overdue')).toEqual([])
  })
})
