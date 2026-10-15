// The plan-change link on tasks (durable-plans 5.1/5.2): validated with the
// task's other references, immutable afterwards, and named in delivered task
// mail with the plan's approved revision at delivery; an unlinked task's
// envelope keeps exactly the old shape.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import { TaskService } from '../team/TaskService'
import { buildTaskContext, formatTaskHeader } from '../team/taskContext'
import { formatEnvelope, parseEnvelope } from '../team/envelope'
import { taskSchemas } from '../team/taskTools'
import { createPlanBench, createPlanWorld, type PlanBench, type PlanWorld } from './planHarness'
import type { ChatPeerMessage } from '../../shared/chat'

const PEER: ChatPeerMessage = {
  messageId: 'mail-1', senderSession: 'lead', senderKind: 'agent', senderGroup: 'leads', priority: 'normal',
  originPath: '/repo', tags: [], threadId: 'thread-1', body: 'Build it.', possibleDuplicate: false,
}

let world: PlanWorld
let bench: PlanBench
let tasks: TaskService
beforeAll(async () => { world = await createPlanWorld('kawai-plan-link-') })
afterAll(() => fs.rmSync(world.root, { recursive: true, force: true }))
beforeEach(() => {
  bench?.db.close()
  bench = createPlanBench(world)
  tasks = new TaskService(bench.tasks, { getSession: id => bench.records.get(id), homeDir: world.home, plans: bench.plans })
})

const create = (extra: Record<string, unknown>) => tasks.create(bench.agent('lead'), { title: 'API', direction: 'Build the API', ...extra })
async function approvedPlan() {
  const { planId, revision } = await bench.draftInReview()
  await bench.approve(planId, revision)
  return planId
}

describe('TaskService.create with a plan link', () => {
  test('a valid link is recorded and listed under its change', async () => {
    writeLeadTasksRight()
    const planId = await approvedPlan()
    const task = await create({ plan_id: planId, plan_change: 'api' })
    expect(task).toMatchObject({ planId, planChange: 'api', planTitle: 'Wave C' })
    const detail = bench.plans.detail(planId)!
    expect(detail.plan.state).toBe('in-progress')
    expect(detail.progress!.changes[0]!.tasks.map(entry => entry.id)).toEqual([task.id])
  })

  test('only one of the pair is refused; nothing is created', async () => {
    writeLeadTasksRight()
    const planId = await approvedPlan()
    await expect(create({ plan_id: planId })).rejects.toThrow('both plan_id and plan_change')
    await expect(create({ plan_change: 'api' })).rejects.toThrow('both plan_id and plan_change')
    expect(bench.tasks.list(world.team.teamId)).toEqual([])
  })

  test('a plan without an approved revision is refused naming the plan', async () => {
    writeLeadTasksRight()
    const { planId } = await bench.draftInReview()
    await expect(create({ plan_id: planId, plan_change: 'api' })).rejects.toThrow(`Plan "Wave C" (${planId}) has no approved revision`)
  })

  test('an unknown change is refused naming it; a closed plan is refused', async () => {
    writeLeadTasksRight()
    const planId = await approvedPlan()
    await expect(create({ plan_id: planId, plan_change: 'cli' })).rejects.toThrow('Change "cli" is not in plan "Wave C" revision 1')
    await bench.service.close(bench.human, { planId, outcome: 'cancelled', reason: 'x', commandId: 'c' })
    await expect(create({ plan_id: planId, plan_change: 'api' })).rejects.toThrow('is cancelled')
  })

  test('another team\'s plan reads as not found', async () => {
    writeLeadTasksRight()
    const planId = await approvedPlan()
    bench.db.db.prepare('UPDATE plans SET team_id = ? WHERE id = ?').run(world.otherTeam.teamId, planId)
    await expect(create({ plan_id: planId, plan_change: 'api' })).rejects.toThrow(`Plan not found in this team: ${planId}`)
  })

  test('amending a task, and approving a revision that drops its change, leave the link unchanged', async () => {
    writeLeadTasksRight()
    const planId = await approvedPlan()
    const task = await create({ plan_id: planId, plan_change: 'ui' })
    await tasks.amend(bench.agent('lead'), task.id, { direction: 'Build the UI differently' })
    const draft = bench.plans.getDraft(planId, 'lead')!
    await bench.service.saveDraft(bench.agent('lead'), { plan_id: planId, expected_draft_hash: draft.contentHash, content: { ...draft.content, changes: [draft.content.changes[0]] } })
    await bench.service.submit(bench.agent('lead'), { plan_id: planId })
    expect((await bench.approve(planId, 2)).ok).toBe(true)
    expect(bench.tasks.get(task.id)).toMatchObject({ revision: 2, planId, planChange: 'ui' })
    expect(bench.plans.detail(planId)!.progress!.outsideRevision.map(entry => entry.id)).toEqual([task.id])
  })

  test('task_create carries plan_id and plan_change to the service', () => {
    expect(taskSchemas.task_create.parse({ title: 't', direction: 'd', plan_id: 'plan-1', plan_change: 'api', forged: 1 }))
      .toEqual({ title: 't', direction: 'd', plan_id: 'plan-1', plan_change: 'api' })
  })
})

describe('delivered task context', () => {
  test('a linked task names the plan, the approved revision at delivery, and the change', async () => {
    writeLeadTasksRight()
    const planId = await approvedPlan()
    const task = await create({ plan_id: planId, plan_change: 'api' })
    const sent = buildTaskContext(bench.tasks, task.id, bench.plans)!
    expect(sent.plan).toEqual({ id: planId, title: 'Wave C', revision: 1, change: 'api' })
    expect(formatTaskHeader(sent)).toContain('Plan: Wave C (revision 1), change api')
    // A newer revision approved between send and delivery shows at delivery.
    const draft = bench.plans.getDraft(planId, 'lead')!
    await bench.service.saveDraft(bench.agent('lead'), { plan_id: planId, expected_draft_hash: draft.contentHash, content: { ...draft.content, goal: 'Next' } })
    await bench.service.submit(bench.agent('lead'), { plan_id: planId })
    await bench.approve(planId, 2)
    const delivered = buildTaskContext(bench.tasks, task.id, bench.plans)!
    expect(delivered.plan!.revision).toBe(2)
    const peer = { ...PEER, task: delivered }
    expect(parseEnvelope(formatEnvelope(peer))).toEqual(peer)
  })

  test('an unlinked task\'s context has no plan field and its envelope is unchanged', async () => {
    writeLeadTasksRight()
    const task = await create({})
    const context = buildTaskContext(bench.tasks, task.id, bench.plans)!
    expect('plan' in context).toBe(false)
    expect(buildTaskContext(bench.tasks, task.id)).toEqual(context)
    expect(formatEnvelope({ ...PEER, task: context })).toBe(formatEnvelope({ ...PEER, task: buildTaskContext(bench.tasks, task.id)! }))
    expect(formatTaskHeader(context)).not.toContain('Plan:')
  })
})

function writeLeadTasksRight() {
  fs.writeFileSync(`${world.repo}/.kawai/groups/leads.md`, '---\ncanCreatePlans: true\ncanCreateTasks: true\n---\nLead.')
}
