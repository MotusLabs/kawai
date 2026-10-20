// The system caller's origins (plan-supervision 5.1, design D7): the
// execution origin keeps plan-execution D2's rights exactly, and the decision
// origins (override, promotion) create a fix task with its `plan_fix_tasks`
// row, dispatch it, and close it — nothing else.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import { AssignmentService } from '../team/AssignmentService'
import { AssignmentStore } from '../team/assignmentStore'
import { MailboxStore } from '../team/mailboxStore'
import { TaskService } from '../team/TaskService'
import { TaskResultService } from '../team/TaskResultService'
import { WorktreeStaffing } from '../team/staffing'
import { TeamCaps } from '../team/teamCaps'
import { TeamWorktrees } from '../team/worktreeRoots'
import { originRights, type SystemCaller, type SystemRight } from '../team/systemCaller'
import { DecisionStore } from '../plans/decisions/decisionStore'
import { createPlanBench, createPlanWorld, type PlanBench, type PlanWorld } from './planHarness'

let world: PlanWorld
let bench: PlanBench
let tasks: TaskService
let assignments: AssignmentService
let results: TaskResultService
let decisions: DecisionStore
let execution: SystemCaller
let override: SystemCaller

beforeAll(async () => { world = await createPlanWorld('kawai-system-origins-') })
afterAll(() => fs.rmSync(world.root, { recursive: true, force: true }))

beforeEach(() => {
  bench?.db.close()
  bench = createPlanBench(world)
  const mail = (bench.tasks as unknown as { mail: MailboxStore }).mail
  tasks = new TaskService(bench.tasks, { getSession: id => bench.records.get(id), homeDir: world.home, plans: bench.plans })
  const caps = new TeamCaps({ homeDir: world.home })
  const worktrees = new TeamWorktrees()
  const teamOf = () => world.team
  const staffing = new WorktreeStaffing(bench.db.db, mail, {
    records: () => bench.records.values(), teamOf, caps, worktrees, spawn: () => Promise.resolve({ ok: false, error: 'no spawn in tests' }),
  })
  assignments = new AssignmentService(bench.db.db, new AssignmentStore(bench.db.db, mail), bench.tasks, mail, {
    getSession: id => bench.records.get(id), records: () => bench.records.values(), teamOf, staffing, caps, worktrees, homeDir: world.home, plans: bench.plans,
  })
  results = new TaskResultService(tasks, { getSession: id => bench.records.get(id), assignments })
  decisions = new DecisionStore(bench.db.db)
  execution = { kind: 'system', team: world.team, origin: { kind: 'execution', executionId: 'exec-1' } }
  override = { kind: 'system', team: world.team, origin: { kind: 'override', decisionId: 'decision-1' } }
})

const fix = (caller: SystemCaller, planId = 'plan-x') => tasks.createFixTask(caller, { title: 'Forward fix: q — Wave C', direction: 'Do it', acceptance: 'Landed' },
  task => { decisions.insertFixTask({ taskId: task.id, teamId: world.team.teamId, planId, sourceKind: 'override', sourceId: 'decision-1' }) })

async function linkedTask() {
  const { planId, revision } = await bench.draftInReview()
  await bench.approve(planId, revision)
  return tasks.create(execution, { title: 'api', direction: 'Build', plan_id: planId, plan_change: 'api' })
}

describe('rights per origin', () => {
  test('the execution origin keeps exactly D2 rights; the decision origins end at create, dispatch, and close', () => {
    const d2: SystemRight[] = ['read', 'create-linked', 'dispatch', 'handoff', 'accept', 'close', 'status', 'note', 'submit', 'acknowledge']
    expect([...originRights({ kind: 'execution', executionId: 'e' })]).toEqual(d2)
    for (const origin of [{ kind: 'override' as const, decisionId: 'd' }, { kind: 'promotion' as const, promotionId: 'p' }]) {
      expect([...originRights(origin)]).toEqual(['create-fix', 'dispatch', 'close'])
    }
  })

  test('the execution origin still creates, dispatches, hands off, accepts, notes, and closes its tasks', async () => {
    const task = await linkedTask()
    expect(task.creator).toEqual({ kind: 'system', sessionId: null })
    await assignments.dispatch(execution, { taskId: task.id, target: { kind: 'group', id: 'middle-devs' }, instruction: 'Implement', requestKey: 'k1' })
    const result = await results.submit(bench.agent('dev'), task.id, { summary: 'done', commit: 'abc' })
    await results.handoff(execution, task.id, { kind: 'review', resultId: result.id, target: { kind: 'group', id: 'leads' }, instructions: 'Review', requestKey: 'k2' })
    await tasks.note(execution, task.id, 'note')
    expect((await results.accept(execution, task.id, result.id)).task.status).toBe('done')
  })

  test('the execution origin cannot create a fix task', () => {
    expect(() => fix(execution)).toThrow('has no create-fix right')
    expect(tasks.store.list(world.team.teamId)).toEqual([])
  })
})

describe('the decision origins', () => {
  test('a fix task commits with its plan_fix_tasks row: no worktree, change, parent, or plan link', () => {
    const task = fix(override)
    expect(task).toMatchObject({ creator: { kind: 'system', sessionId: null }, worktree: null, openspecChange: null, parentId: null, planId: null, planChange: null })
    expect(decisions.fixTask(world.team.teamId, task.id)).toMatchObject({ sourceKind: 'override', sourceId: 'decision-1' })
  })

  test('a failing within rolls the task back', () => {
    expect(() => tasks.createFixTask(override, { title: 't', direction: 'd', acceptance: 'a' }, () => { throw new Error('boom') })).toThrow('boom')
    expect(tasks.store.list(world.team.teamId)).toEqual([])
  })

  test('the decision origins create no linked task', async () => {
    const { planId, revision } = await bench.draftInReview()
    await bench.approve(planId, revision)
    await expect(tasks.create(override, { title: 'x', direction: 'y', plan_id: planId, plan_change: 'api' })).rejects.toThrow('has no create-linked right')
  })

  test('dispatch of its fix task goes to a group with role profiles and tags; Kawai is the sender', () => {
    const task = fix(override)
    const outcome = assignments.dispatchWithin(override, {
      taskId: task.id, target: { kind: 'group', id: 'leads' }, instruction: 'Plan the fix', requestKey: 'fix:decision-1', allowedProfiles: ['opus'], tags: ['plan-fix'],
    })
    expect(outcome.message).toMatchObject({ fromKind: 'system', toKind: 'group', toId: 'leads', allowedProfiles: ['opus'], tags: ['plan-fix'], taskId: task.id })
    expect(outcome.assignment.createdBy).toEqual({ kind: 'system', sessionId: null })
  })

  test("a decision origin never dispatches a plan change's task or a human's task", async () => {
    const linked = await linkedTask()
    const human = await tasks.create(bench.human, { title: 'h', direction: 'd' })
    for (const task of [linked, human]) {
      expect(() => assignments.dispatchWithin(override, { taskId: task.id, target: { kind: 'group', id: 'leads' }, instruction: 'x', requestKey: `k-${task.id}` }))
        .toThrow('only its own fix and correction tasks')
    }
  })

  test('handoff, acceptance, notes, results, active/blocked, and reads are refused', async () => {
    const task = fix(override)
    await expect(results.handoff(override, task.id, { kind: 'review', resultId: 'r', target: { kind: 'group', id: 'leads' }, instructions: 'x', requestKey: 'k' }))
      .rejects.toThrow('has no handoff right')
    await expect(results.accept(override, task.id, 'r')).rejects.toThrow('has no accept right')
    await expect(results.submit(override, task.id, { summary: 's', commit: 'c' })).rejects.toThrow('has no submit right')
    await expect(tasks.note(override, task.id, 'n')).rejects.toThrow('has no note right')
    await expect(tasks.setStatus(override, task.id, 'active')).rejects.toThrow('has no status right')
    await expect(tasks.get(override, task.id)).rejects.toThrow('has no read right')
    expect(tasks.store.journal(task.id)).toEqual([])
  })

  test("it closes its fix task as creator, and never a plan change's task", async () => {
    const task = fix(override)
    expect((await tasks.setStatus(override, task.id, 'cancelled', 'Superseded by override decision-2')).status).toBe('cancelled')
    expect(tasks.store.journal(task.id).at(-1)).toMatchObject({ author: { kind: 'system', sessionId: null }, text: 'Superseded by override decision-2' })
    const linked = await linkedTask()
    await expect(tasks.setStatus(override, linked.id, 'done')).rejects.toThrow('closes only fix and correction tasks')
  })
})
