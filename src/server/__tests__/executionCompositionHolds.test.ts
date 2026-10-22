// The composed holds service (revision-control 3.2, PR B's review N2): the
// HoldService the composition builds wakes the runtime after a committed
// release, proved through `composePlanServices` with the team services — the
// same construction the server runs, not a hand-built service.
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { AssignmentService } from '../team/AssignmentService'
import { AssignmentStore } from '../team/assignmentStore'
import { MailboxStore } from '../team/mailboxStore'
import { MemberRelease } from '../team/memberRelease'
import { TeamMailbox } from '../team/TeamMailbox'
import { TaskService } from '../team/TaskService'
import { TaskResultService } from '../team/TaskResultService'
import { TeamWorktrees } from '../team/worktreeRoots'
import { WorktreeStaffing } from '../team/staffing'
import { TeamCaps } from '../team/teamCaps'
import { ImpactService } from '../strategy/ImpactService'
import { ImpactStore } from '../strategy/impactStore'
import { composeExecutionCore, composePlanServices } from '../plans/planComposition'
import type { ExecutionRuntime } from '../plans/execution/executionRuntime'
import type { HoldService } from '../plans/revisionControl/holdService'
import { LEAD_ROLES } from './decisionHarness'
import { createPlanBench, createPlanWorld, writeGroup, type PlanBench, type PlanWorld } from './planHarness'

let world: PlanWorld
let bench: PlanBench
let runtime: ExecutionRuntime
let holds: HoldService

const inTwoDays = (): string => new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString()

/** The composed stack over the bench: core, team services with the ownership, and the runtime. */
async function compose(): Promise<void> {
  const core = composeExecutionCore(bench.db.db)
  const mail = (bench.tasks as unknown as { mail: MailboxStore }).mail
  const tasks = new TaskService(bench.tasks, {
    getSession: id => bench.records.get(id), homeDir: world.home,
    restoreSession: () => undefined, plans: bench.plans, ownership: core.ownership,
  })
  const releases = new MemberRelease(bench.db.db, {
    store: mail, tasks: bench.tasks,
    records: () => bench.records.values(), getRecord: id => bench.records.get(id),
    teamOf: () => world.team,
    definition: async () => undefined, cachedDefinition: () => undefined,
    recipient: () => undefined,
    hasLiveWorkers: () => false, hasRunningBackgroundTasks: () => false,
    archive: () => ({ ok: false as const, error: 'no archive in this test' }),
    notify: () => undefined,
  })
  const caps = new TeamCaps({ homeDir: world.home })
  const worktrees = new TeamWorktrees()
  const teamOf = () => world.team
  const staffing = new WorktreeStaffing(bench.db.db, mail, {
    records: () => bench.records.values(), teamOf, caps, worktrees,
    spawn: () => Promise.resolve({ ok: false, error: 'no spawn in tests' }),
  })
  const assignments = new AssignmentService(bench.db.db, new AssignmentStore(bench.db.db, mail), bench.tasks, mail, {
    getSession: id => bench.records.get(id), records: () => bench.records.values(), teamOf,
    staffing, caps, worktrees, homeDir: world.home, plans: bench.plans, ownership: core.ownership,
  })
  const results = new TaskResultService(tasks, {
    getSession: id => bench.records.get(id), assignments,
    releases, records: () => bench.records.values(), homeDir: world.home,
    ownership: core.ownership, onWrite: taskId => core.wakes.resultWrite(taskId),
  })
  const impact = new ImpactService(new ImpactStore(bench.db.db), {
    strategies: bench.strategies, plans: bench.plans, mail, getSession: id => bench.records.get(id),
  })
  const teamMailbox = new TeamMailbox(mail, { getSession: id => bench.records.get(id), homeDir: world.home, tasks: bench.tasks })
  const composed = composePlanServices({
    db: bench.db.db, plans: bench.plans, strategies: bench.strategies, impact,
    getSession: id => bench.records.get(id),
    caps: { planExecution: async () => ({ floorChecks: { lint: ['ci'], typecheck: ['ci'], 'unit-tests': ['ci'], 'ci-e2e': ['e2e'] }, maxParallelChanges: 2, mergeMethod: 'merge' }) },
    executionCore: core,
    executionTeam: {
      tasks, assignments, results, taskStore: bench.tasks, mailbox: mail, teamMailbox, releases,
      pendingSpawns: () => [],
      records: () => bench.records.values(),
      identityOf: id => (id === world.team.teamId ? world.team : undefined),
      teamOfSession: teamOf,
      supervision: { holder: () => null, blocker: () => null },
    },
    executionValidation: {
      prepareStanding: async () => ({}),
      standing: () => ({ state: 'current', report: { id: 'rep-1', inputHash: 'ih-1', readiness: { carriedConditions: [] } } }) as never,
    },
  })
  holds = composed.holds
  runtime = composed.runtime!
  await runtime.start()
}

beforeAll(async () => {
  world = await createPlanWorld('kawai-exec-holds-')
  writeGroup(world, 'leads', '---\ncanCreatePlans: true\nmax: 1\n---\nLead.')
  bench = createPlanBench(world)
  await compose()
})

afterAll(() => {
  runtime.stop()
  bench.db.close()
  fs.rmSync(world.root, { recursive: true, force: true })
})

describe('the composed holds service (revision-control 3.2)', () => {
  test('a committed release wakes the executor through the composition (N2)', async () => {
    const draft = await bench.draftInReview(LEAD_ROLES)
    await bench.approve(draft.planId, draft.revision)
    const placed = holds.place(bench.human, {
      planId: draft.planId, scope: 'plan', rationale: 'rethink the direction', deadline: inTwoDays(), cites: null, commandId: 'wake-place-1',
    })
    if (!placed.ok) throw new Error(placed.message)
    // The place already woke once; the spy covers the release's wake only.
    const wake = spyOn(runtime, 'command')
    const released = holds.release(bench.human, { planId: draft.planId, holdId: placed.result!.hold.id, reason: 'done waiting', commandId: 'wake-release-1' })
    if (!released.ok) throw new Error(released.message)
    expect(wake).toHaveBeenCalledTimes(1)
    expect(wake).toHaveBeenCalledWith(world.team.teamId)
  })
})
