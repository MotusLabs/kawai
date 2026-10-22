// The plan tools (durable-plans 6.1): exactly five read/create/draft/submit
// tools allowed without cards, identity bound to the calling session, the
// creation right read from the current group file at each call, another
// team's ids not found, a CAS mismatch returning the stored draft, and no
// approve, withdraw, close, or reopen tool anywhere on the team server.
// @reads: .kawai/plans, docs/plan.md
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { PLAN_FORBIDDEN_TOOL_NAMES, PLAN_TOOL_NAMES, planHandlers } from '../plans/planTools'
import { TEAM_ALLOWED_TOOLS } from '../team/mailboxTools'
import { TaskService } from '../team/TaskService'
import { planInput } from '../../shared/__tests__/planFixtures'
import { createPlanBench, createPlanWorld, writeGroup, type PlanBench, type PlanWorld } from './planHarness'

let world: PlanWorld
let bench: PlanBench
beforeAll(async () => { world = await createPlanWorld('kawai-plan-tools-') })
afterAll(() => fs.rmSync(world.root, { recursive: true, force: true }))
beforeEach(() => {
  bench?.db.close()
  writeGroup(world, 'leads', '---\ncanCreatePlans: true\ncanCreateTasks: true\n---\nLead.')
  bench = createPlanBench(world)
})

const tools = (sessionId: string) => planHandlers(bench.service, sessionId)

describe('tool surface', () => {
  test('exactly the five plan tools, all allowed without approval cards', () => {
    expect(Object.keys(tools('lead')).sort()).toEqual([...PLAN_TOOL_NAMES].sort())
    for (const name of PLAN_TOOL_NAMES) expect(TEAM_ALLOWED_TOOLS).toContain(`mcp__kawai-team__${name}`)
  })

  test('no approve, withdraw, close, or reopen tool exists on the plan surface or the team allow-list', () => {
    for (const forbidden of PLAN_FORBIDDEN_TOOL_NAMES) {
      expect(tools('lead')).not.toHaveProperty(forbidden)
      expect(TEAM_ALLOWED_TOOLS).not.toContain(`mcp__kawai-team__${forbidden}`)
    }
    const lifecycle = TEAM_ALLOWED_TOOLS.filter(name => /plan_(approve|withdraw|close|reopen|complete|cancel)/.test(name))
    expect(lifecycle).toEqual([])
  })
})

describe('refusals', () => {
  test('plan_create needs canCreatePlans, read from the current group file at each call', async () => {
    await expect(tools('dev').plan_create({ title: 'Wave C' })).rejects.toThrow('cannot create plans')
    writeGroup(world, 'middle-devs', '---\ncanCreatePlans: true\n---\nBuild.')
    try {
      expect((await tools('dev').plan_create({ title: 'Wave C' })).plan.title).toBe('Wave C')
    } finally {
      writeGroup(world, 'middle-devs', 'Build.')
    }
    await expect(tools('dev').plan_create({ title: 'Again' })).rejects.toThrow('cannot create plans')
  })

  test('another team\'s plan ids read as not found for every tool', async () => {
    const { planId } = await bench.draftInReview()
    const stranger = tools('stranger')
    await expect(stranger.plan_get({ plan_id: planId })).rejects.toThrow(`Plan not found in this team: ${planId}`)
    await expect(stranger.plan_save_draft({ plan_id: planId, content: {} })).rejects.toThrow('Plan not found in this team')
    await expect(stranger.plan_submit_for_review({ plan_id: planId })).rejects.toThrow('Plan not found in this team')
    expect(await stranger.plan_list({})).toEqual([])
  })

  test('a CAS mismatch writes nothing and returns the stored draft', async () => {
    const { plan, draft } = await tools('lead').plan_create({ title: 'Wave C', content: planInput() })
    const stale = await tools('lead').plan_save_draft({ plan_id: plan.id, content: { ...planInput(), goal: 'Other' }, expected_draft_hash: 'stale' })
    expect(stale).toMatchObject({ ok: false, reason: 'conflict' })
    expect(!stale.ok && stale.stored).toEqual(draft)
    expect(bench.plans.getDraft(plan.id, 'lead')).toEqual(draft)
  })

  test('forged actor and team arguments are stripped; identity is the calling session', async () => {
    const { plan } = await tools('lead').plan_create({ title: 'Wave C', content: planInput(), actor: { kind: 'human' }, team: 'x' } as never)
    expect(plan.creator).toEqual({ kind: 'agent', sessionId: 'lead' })
    const saved = await tools('dev').plan_save_draft({ plan_id: plan.id, content: planInput(), actor: { kind: 'human' } } as never)
    expect(saved).toMatchObject({ ok: true, draft: { draftId: 'dev', author: { kind: 'agent', sessionId: 'dev' } } })
  })
})

describe('the record', () => {
  test('a plan-like file in the repository is never read: plan_get and the store return only the SQLite rows', async () => {
    const lead = tools('lead')
    const { plan } = await lead.plan_create({ title: 'Wave C', content: planInput() })
    const file = { title: 'Forged plan', goal: 'From a file', status: 'approved', currentApprovedRevision: 7 }
    for (const name of ['plan.json', path.join('.kawai', 'plans', `${plan.id}.json`), path.join('docs', 'plan.md')]) {
      fs.mkdirSync(path.dirname(path.join(world.repo, name)), { recursive: true })
      fs.writeFileSync(path.join(world.repo, name), JSON.stringify(file))
    }
    const stored = bench.plans.detail(plan.id)!
    const read = await lead.plan_get({ plan_id: plan.id })
    for (const detail of [stored, read]) {
      expect(detail.plan).toMatchObject({ id: plan.id, title: 'Wave C', currentApprovedRevision: null })
      expect(detail.revisions).toEqual([])
      expect(detail.drafts.map(draft => draft.content.goal)).toEqual([planInput().goal as string])
    }
    expect((await lead.plan_list({})).map(entry => entry.title)).toEqual(['Wave C'])
  })
})

describe('round trip', () => {
  test('create → save → submit, then plan_get reports progress of the approved revision', async () => {
    const lead = tools('lead')
    const { plan, draft } = await lead.plan_create({ title: 'Wave C' })
    const saved = await lead.plan_save_draft({ plan_id: plan.id, content: planInput(), expected_draft_hash: draft.contentHash })
    expect(saved.ok).toBe(true)
    const submitted = await lead.plan_submit_for_review({ plan_id: plan.id })
    expect(submitted).toMatchObject({ ok: true, created: true, revision: { revision: 1, status: 'in_review' } })
    expect((await lead.plan_get({ plan_id: plan.id })).progress).toBeNull()
    expect((await bench.approve(plan.id, 1)).ok).toBe(true)

    const tasks = new TaskService(bench.tasks, { getSession: id => bench.records.get(id), homeDir: world.home, plans: bench.plans })
    const api = await tasks.create(bench.agent('lead'), { title: 'API', direction: 'Build', plan_id: plan.id, plan_change: 'api' })
    const detail = await lead.plan_get({ plan_id: plan.id })
    expect(detail.plan.state).toBe('in-progress')
    expect(detail.progress!.changes.map(change => [change.change, change.status, change.waitsOn])).toEqual([
      ['api', 'in-progress', []],
      ['ui', 'not-started', ['api']],
    ])
    expect(detail.linkedTasks.map(task => task.id)).toEqual([api.id])
    expect((await lead.plan_list({ status: 'in-progress' })).map(entry => entry.id)).toEqual([plan.id])
    expect(await lead.plan_list({ status: 'cancelled' })).toEqual([])
  })
})
