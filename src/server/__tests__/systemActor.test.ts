// Kawai as a system actor (plan-execution 2.1–2.3, design D2): a system
// caller creates, dispatches, sends, hands off, and accepts, and every row
// reads back `system` — never the human; the human-only paths still refuse
// it.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import { KAWAI_REPLY_GUIDANCE } from '../../shared/team'
import { AssignmentService } from '../team/AssignmentService'
import { AssignmentStore } from '../team/assignmentStore'
import { MailboxStore } from '../team/mailboxStore'
import { TaskService, type TaskCaller } from '../team/TaskService'
import { TaskResultService } from '../team/TaskResultService'
import { TaskRelease } from '../team/taskRelease'
import { TeamMailbox } from '../team/TeamMailbox'
import { WorktreeStaffing } from '../team/staffing'
import { TeamCaps } from '../team/teamCaps'
import { TeamWorktrees } from '../team/worktreeRoots'
import { StrategyService } from '../strategy/StrategyService'
import { ImpactService } from '../strategy/ImpactService'
import { ImpactStore } from '../strategy/impactStore'
import { ValidationService } from '../plans/validation/ValidationService'
import { createPlanBench, createPlanWorld, writeGroup, type PlanBench, type PlanWorld } from './planHarness'

let world: PlanWorld
let bench: PlanBench
let mail: MailboxStore
let tasks: TaskService
let assignments: AssignmentService
let results: TaskResultService
let system: TaskCaller

beforeAll(async () => {
  world = await createPlanWorld('kawai-system-actor-')
  writeGroup(world, 'reviewers', 'Review.')
})
afterAll(() => fs.rmSync(world.root, { recursive: true, force: true }))

beforeEach(() => {
  bench?.db.close()
  bench = createPlanBench(world)
  mail = (bench.tasks as unknown as { mail: MailboxStore }).mail
  tasks = new TaskService(bench.tasks, { getSession: id => bench.records.get(id), homeDir: world.home, plans: bench.plans })
  const caps = new TeamCaps({ homeDir: world.home })
  const worktrees = new TeamWorktrees()
  const teamOf = (id: string) => (bench.records.get(id)?.projectPath === world.other ? undefined : world.team)
  const staffing = new WorktreeStaffing(bench.db.db, mail, {
    records: () => bench.records.values(), teamOf, caps, worktrees,
    spawn: () => Promise.resolve({ ok: false, error: 'no spawn in tests' }),
  })
  assignments = new AssignmentService(bench.db.db, new AssignmentStore(bench.db.db, mail), bench.tasks, mail, {
    getSession: id => bench.records.get(id), records: () => bench.records.values(), teamOf,
    staffing, caps, worktrees, homeDir: world.home, plans: bench.plans,
  })
  results = new TaskResultService(tasks, { getSession: id => bench.records.get(id), assignments })
  system = { kind: 'system', team: world.team, origin: { kind: 'execution', executionId: 'exec-1' } }
})

async function kawaiTask() {
  const { planId, revision } = await bench.draftInReview()
  await bench.approve(planId, revision)
  return tasks.create(system, { title: 'api — Wave C', direction: 'Build the API', plan_id: planId, plan_change: 'api' })
}

describe('a system caller is recorded as Kawai', () => {
  test('creator and first revision author read back as system', async () => {
    const task = await kawaiTask()
    expect(task.creator).toEqual({ kind: 'system', sessionId: null })
    expect(tasks.store.revisions(task.id)[0]!.author).toEqual({ kind: 'system', sessionId: null })
    expect(tasks.store.get(task.id)!.creator.kind).toBe('system')
  })

  test('Kawai creates a task only with a plan-change link', async () => {
    await expect(tasks.create(system, { title: 'x', direction: 'y' })).rejects.toThrow('plan-change link')
    expect(tasks.store.list(world.team.teamId)).toEqual([])
  })

  test('dispatch records Kawai as dispatcher and sender, with no session or group', async () => {
    const task = await kawaiTask()
    const outcome = await assignments.dispatch(system, {
      taskId: task.id, target: { kind: 'group', id: 'middle-devs' }, instruction: 'Implement api', requestKey: 'exec:1:api:attempt:1:0',
    })
    expect(outcome.assignment.createdBy).toEqual({ kind: 'system', sessionId: null })
    expect(outcome.message).toMatchObject({ fromKind: 'system', fromSession: null, fromGroup: null, originPath: world.team.groupsRoot })
    const journal = tasks.store.journal(task.id).at(-1)!
    expect(journal.author).toEqual({ kind: 'system', sessionId: null })
    expect(journal.text).toContain('by Kawai')
  })

  test('a handoff and an acceptance by Kawai read back as system', async () => {
    const task = await kawaiTask()
    const result = await results.submit(bench.agent('dev'), task.id, { summary: 'done', commit: 'abc' })
    const handoff = await results.handoff(system, task.id, {
      kind: 'review', resultId: result.id, target: { kind: 'group', id: 'reviewers' }, instructions: 'Review it', requestKey: 'exec:1:api:round:1:review',
    })
    expect(handoff.assignment.createdBy.kind).toBe('system')
    const accepted = await results.accept(system, task.id, result.id)
    expect(accepted.task.status).toBe('done')
    expect(accepted.result.acceptedBy).toEqual({ kind: 'system', sessionId: null })
  })

  test("Kawai closes only its own tasks and never reopens", async () => {
    const own = await kawaiTask()
    await expect(tasks.setStatus(system, own.id, 'open')).rejects.toThrow('Only the human can reopen')
    expect((await tasks.setStatus(system, own.id, 'cancelled')).status).toBe('cancelled')
    const human = await tasks.create(bench.human, { title: 'h', direction: 'd' })
    await expect(tasks.setStatus(system, human.id, 'done')).rejects.toThrow('only on the tasks it created')
    await expect(results.accept(system, human.id, 'r')).rejects.toThrow('only on the tasks it created')
  })

  test("a reply to Kawai's mail is refused with the guidance", async () => {
    const task = await kawaiTask()
    const { message } = await assignments.dispatch(system, {
      taskId: task.id, target: { kind: 'group', id: 'middle-devs' }, instruction: 'Implement', requestKey: 'k1',
    })
    const mailbox = new TeamMailbox(mail, { getSession: id => bench.records.get(id), homeDir: world.home, tasks: bench.tasks })
    await expect(mailbox.reply({ kind: 'human', team: world.team }, { message_id: message!.id, body: 'ok' })).rejects.toThrow(KAWAI_REPLY_GUIDANCE)
  })
})

describe('human-only paths refuse the system actor', () => {
  const asSystem = () => system as never

  test('publish, notify, and drafts', async () => {
    const task = await kawaiTask()
    await expect(tasks.publish(system, task.id, { direction: 'v2' })).rejects.toThrow('never publishes')
    await expect(tasks.notify(system, task.id, 1, 'n1')).rejects.toThrow('never publishes')
    await expect(tasks.saveDraft(system, task.id, { direction: 'v2' })).rejects.toThrow("Drafts are the human's")
    expect(tasks.store.get(task.id)!.revision).toBe(1)
  })

  test('Release worktree and hand off', async () => {
    const release = new TaskRelease(results, { releases: {} as never, records: () => [] })
    await expect(release.release(system, 'task', { target: 'reviewers', instructions: 'x', requestKey: 'k' })).rejects.toThrow("is the human's")
  })

  test('plan approve, withdraw, close, and reopen', async () => {
    const { planId, revision, hash } = await bench.draftInReview()
    const approve = await bench.service.approve(asSystem(), { planId, revision, contentHash: hash, expectedApprovedRevision: null, commandId: 'c' })
    const withdraw = await bench.service.withdraw(asSystem(), { planId, revision, commandId: 'c' } as never)
    const close = await bench.service.close(asSystem(), { planId, outcome: 'cancelled', reason: 'x', commandId: 'c' } as never)
    const reopen = await bench.service.reopen(asSystem(), { planId, commandId: 'c' })
    for (const outcome of [approve, withdraw, close, reopen]) expect(outcome).toMatchObject({ ok: false, reason: 'forbidden' })
    expect(bench.plans.get(planId)!.currentApprovedRevision).toBeNull()
  })

  test('strategy approve and withdraw, and impact decisions', async () => {
    const strategy = new StrategyService(bench.strategies, { getSession: id => bench.records.get(id), homeDir: world.home })
    await expect(strategy.approve(asSystem(), { revision: 1, content_hash: 'h', command_id: 'c' } as never)).rejects.toThrow()
    await expect(strategy.withdraw(asSystem(), { revision: 1, command_id: 'c' } as never)).rejects.toThrow()
    const impact = new ImpactService(new ImpactStore(bench.db.db), {
      strategies: bench.strategies, plans: bench.plans, mail, getSession: id => bench.records.get(id),
    })
    expect(await impact.decide(asSystem(), {} as never)).toMatchObject({ ok: false, reason: 'forbidden' })
    expect(await impact.requestAssessment(asSystem(), { reviewId: 'r', group: 'leads', commandId: 'c' })).toMatchObject({ ok: false, reason: 'forbidden' })
  })

  test('validation decisions', async () => {
    const validation = Object.create(ValidationService.prototype) as ValidationService
    expect(await validation.decide(asSystem(), {} as never)).toMatchObject({ ok: false, reason: 'forbidden' })
  })
})

