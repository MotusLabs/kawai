// Retry and Stop (plan-execution D12, §13.3-13.4): the owner retries a
// stopped change — the generation bumps, the change returns to the stage its
// reason implies, and a resend replays — and Stop cancels everything: the
// unlanded changes and their tasks (as Kawai, one transaction), the pending
// effects, the execution itself, and the `execution-stopped` event.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { AssignmentService } from '../team/AssignmentService'
import { AssignmentStore } from '../team/assignmentStore'
import { MailboxStore } from '../team/mailboxStore'
import { TaskService } from '../team/TaskService'
import { TaskResultService } from '../team/TaskResultService'
import { TeamWorktrees } from '../team/worktreeRoots'
import { WorktreeStaffing } from '../team/staffing'
import { TeamCaps } from '../team/teamCaps'
import { ExecutionStore } from '../plans/execution/executionStore'
import { executionOwnership } from '../plans/execution/executionOwnership'
import { ExecutionService } from '../plans/execution/ExecutionService'
import { ExecutionExecutor } from '../plans/execution/executor'
import { provisionAdapter } from '../plans/execution/executionProvision'
import { createPlanBench, createPlanWorld, writeGroup, type PlanBench, type PlanWorld } from './planHarness'

const FLOOR = { lint: ['ci'], typecheck: ['ci'], 'unit-tests': ['ci'], 'ci-e2e': ['e2e'] }

let world: PlanWorld
let bench: PlanBench
let mail: MailboxStore
let tasks: TaskService
let assignments: AssignmentService
let results: TaskResultService
let executions: ExecutionStore
let service: ExecutionService
let executor: ExecutionExecutor
let system: { kind: 'system'; team: typeof world.team; executionId: string }

beforeAll(async () => {
  world = await createPlanWorld('kawai-stops-')
  writeGroup(world, 'middle-devs', '---\nmax: 2\n---\nBuild.')
})
afterAll(() => fs.rmSync(world.root, { recursive: true, force: true }))

beforeEach(async () => {
  bench?.db.close()
  bench = createPlanBench(world)
  mail = (bench.tasks as unknown as { mail: MailboxStore }).mail
  executions = new ExecutionStore(bench.db.db)
  const ownership = executionOwnership(executions, {
    isAncestor: async () => ({ ok: true, ancestor: true }),
    lsRemoteHead: async () => ({ ok: true, sha: null }),
  }, () => null)
  tasks = new TaskService(bench.tasks, { getSession: id => bench.records.get(id), homeDir: world.home, plans: bench.plans, ownership })
  const caps = new TeamCaps({ homeDir: world.home })
  const worktrees = new TeamWorktrees()
  const teamOf = (id: string) => (bench.records.get(id)?.projectPath === world.other ? undefined : world.team)
  const staffing = new WorktreeStaffing(bench.db.db, mail, {
    records: () => bench.records.values(), teamOf, caps, worktrees,
    spawn: () => Promise.resolve({ ok: false, error: 'no spawn in tests' }),
  })
  assignments = new AssignmentService(bench.db.db, new AssignmentStore(bench.db.db, mail), bench.tasks, mail, {
    getSession: id => bench.records.get(id), records: () => bench.records.values(), teamOf,
    staffing, caps, worktrees, homeDir: world.home, plans: bench.plans, ownership,
  })
  results = new TaskResultService(tasks, { getSession: id => bench.records.get(id), assignments, ownership })
  service = new ExecutionService({
    store: executions, plansStore: bench.plans, plans: bench.service,
    validation: { prepareStanding: async () => ({}), standing: () => null },
    impact: { gate: () => null },
    settings: { planExecution: async () => ({ floorChecks: FLOOR, maxParallelChanges: 2, mergeMethod: 'merge' }) },
    getSession: () => null,
    landingModes: () => new Set(['direct']),
    tasks,
  })
  executor = new ExecutionExecutor({
    store: executions, plans: bench.plans, tasks, assignments, results, mailbox: mail,
    teamOf: id => (id === world.team.teamId ? world.team : undefined),
    adapters: { provision: provisionAdapter(executions) },
  })
  system = { kind: 'system', team: world.team, executionId: '' }
})
afterEach(() => executor.close())

/** An approved execution whose changes provision and dispatch (no git world: stub provision). */
async function runningExecution(changes: string[]): Promise<string> {
  const { planId, revision, hash } = await bench.draftInReview({
    changes: changes.map(change => ({ change, dependsOn: [], group: 'middle-devs', acceptance: [], extraChecks: [], guidance: '' })),
  })
  await bench.approve(planId, revision)
  const execution = executions.insertExecution({
    teamId: world.team.teamId, planId, revision, contentHash: hash, reportId: 'r', inputHash: 'i',
    landingMode: 'direct', baseBranch: 'master', baseCommit: 'abc', floor: { version: 1, map: FLOOR },
    maxParallel: 2, mergeMethod: 'merge', changes: changes.map(change => ({ change, landed: false })),
  })
  // Drive the stages by hand: provisioning done, implementing with a task.
  for (const change of changes) {
    const row = executions.change(execution.id, change)!
    executions.transition(execution.id, change, row, { state: 'provisioning' })
    executions.insertEffect({
      executionId: execution.id, change, roundId: null, kind: 'provision',
      effectKey: `${execution.id}:${change}:provision:1:0`, command: {},
    })
    const effect = executions.effectByKey(`${execution.id}:${change}:provision:1:0`)!
    executions.setEffectOutcome(effect.id, { state: 'done', outcome: { path: path.join(world.repo, '.worktrees', change), branch: change, baseline: 'abc' } })
    const moved = executions.change(execution.id, change)!
    const task = await tasks.create({ ...system, executionId: execution.id }, {
      title: `${change} — plan`, direction: 'Build it', plan_id: planId, plan_change: change,
    })
    executions.transition(execution.id, change, moved, { state: 'implementing', taskId: task.id, worktree: task.worktree, branch: change, baselineCommit: 'abc' })
  }
  return execution.id
}

describe('Retry (§13.3)', () => {
  test('a stopped change returns to the stage its reason implies, generation bumped; a resend replays', async () => {
    const executionId = await runningExecution(['rt-a'])
    const before = executions.change(executionId, 'rt-a')!
    executions.transition(executionId, 'rt-a', before, { state: 'stopped', stopReason: 'round-limit', stopDetail: { message: 'three failures' } })

    const stoppedAt = executions.change(executionId, 'rt-a')!
    const first = await service.retry(bench.human, { executionId, change: 'rt-a', commandId: 'retry-1' })
    expect(first).toMatchObject({ ok: true, replayed: false })
    const moved = executions.change(executionId, 'rt-a')!
    expect(moved).toMatchObject({ state: 'implementing', stopReason: null })
    expect(moved.generation).toBe(stoppedAt.generation + 1)
    expect(moved.generation).toBeGreaterThan(before.generation)

    const again = await service.retry(bench.human, { executionId, change: 'rt-a', commandId: 'retry-1' })
    expect(again).toMatchObject({ ok: true, replayed: true })
    expect(bench.plans.events((executions.execution(executionId))!.planId).filter(event => event.kind === 'change-retried')).toHaveLength(1)

    // An effect failure retries back into gating; a closed task refuses.
    executions.transition(executionId, 'rt-a', executions.change(executionId, 'rt-a')!, { state: 'stopped', stopReason: 'effect-failed', stopDetail: { message: 'push rejected' } })
    await expect(service.retry(bench.human, { executionId, change: 'rt-a', commandId: 'retry-2' })).resolves.toMatchObject({ ok: true })
    expect(executions.change(executionId, 'rt-a')!.state).toBe('gating')

    const task = tasks.store.get(executions.change(executionId, 'rt-a')!.taskId!)!
    await tasks.setStatus(bench.human, task.id, 'cancelled')
    executions.transition(executionId, 'rt-a', executions.change(executionId, 'rt-a')!, { state: 'stopped', stopReason: 'task-closed', stopDetail: { message: 'closed' } })
    const refused = await service.retry(bench.human, { executionId, change: 'rt-a', commandId: 'retry-3' })
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.message).toContain('reopen')
    // An agent cannot retry.
    expect((await service.retry({ kind: 'agent', sessionId: 'dev' }, { executionId, change: 'rt-a', commandId: 'x' })).ok).toBe(false)
  })
})

describe('Stop (§13.4)', () => {
  test('cancels unlanded changes and their tasks as Kawai, cancels pending effects, records the event', async () => {
    const executionId = await runningExecution(['sp-a', 'sp-b'])
    executions.insertEffect({
      executionId, change: 'sp-a', roundId: null, kind: 'push',
      effectKey: `${executionId}:sp-a:push:1:0`, command: {},
    })
    const landed = executions.change(executionId, 'sp-b')!
    executions.transition(executionId, 'sp-b', landed, { state: 'landed' })

    const stopped = await service.stop(bench.human, { executionId, reason: 'enough for today', commandId: 'stop-1' })
    expect(stopped).toMatchObject({ ok: true, replayed: false })
    expect(executions.execution(executionId)).toMatchObject({ state: 'finished', outcome: 'stopped', stopReason: 'enough for today' })
    expect(executions.change(executionId, 'sp-a')).toMatchObject({ state: 'cancelled' })
    expect(executions.change(executionId, 'sp-b')).toMatchObject({ state: 'landed' })
    expect(executions.effectByKey(`${executionId}:sp-a:push:1:0`)?.state).toBe('cancelled')
    const taskA = tasks.store.get(executions.change(executionId, 'sp-a')!.taskId!)!
    expect(taskA.status).toBe('cancelled')
    expect(taskA.creator).toEqual({ kind: 'system', sessionId: null })
    expect(bench.plans.events(executions.execution(executionId)!.planId).filter(event => event.kind === 'execution-stopped')).toHaveLength(1)
    // A resend replays; an empty reason refuses.
    expect(await service.stop(bench.human, { executionId, reason: 'enough for today', commandId: 'stop-1' })).toMatchObject({ ok: true, replayed: true })
    expect((await service.stop(bench.human, { executionId, reason: '  ', commandId: 'stop-2' })).ok).toBe(false)
  })
})
