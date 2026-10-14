// Plan subscriptions and human commands over the chat connection
// (durable-plans 7.1): opened by repository or worktree path through the real
// team-scope resolver, unknown paths and another team's plan ids refused
// with no data, approve/withdraw/close/reopen round trips answered by
// `team-plan-result` and pushed to subscribers, a linked task's change
// pushing the open detail, and every new type listed for the WS router.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import type { ChatSessionManager } from '../chat/ChatSessionManager'
import { ChatConnections } from '../chat/ChatConnections'
import { CHAT_CONNECTION_TYPES } from '../chat/chatConnectionTypes'
import { TaskService } from '../team/TaskService'
import { TeamScopes } from '../team/teamScope'
import type { SessionTeams } from '../team/sessionTeams'
import type { ClientMessage, ServerMessage } from '../../shared/types'
import { createPlanBench, createPlanWorld, writeGroup, type PlanBench, type PlanWorld } from './planHarness'

let world: PlanWorld
let bench: PlanBench
let tasks: TaskService
let connections: ChatConnections
let messages: ServerMessage[]
const connection = { send: (message: ServerMessage) => messages.push(message) }

beforeAll(async () => { world = await createPlanWorld('kawai-plan-connections-') })
afterAll(() => fs.rmSync(world.root, { recursive: true, force: true }))
beforeEach(() => {
  bench?.db.close()
  writeGroup(world, 'leads', '---\ncanCreatePlans: true\ncanCreateTasks: true\n---\nLead.')
  bench = createPlanBench(world)
  tasks = new TaskService(bench.tasks, { getSession: id => bench.records.get(id), homeDir: world.home, plans: bench.plans })
  messages = []
  // Only this repository is discovered; the other one is no known team.
  const teamScopes = new TeamScopes({ teams: { hasTeam: async () => false } as unknown as SessionTeams, repositories: () => [world.team.teamId] })
  const manager = { whenRestored: () => Promise.resolve(), teamScopes, plans: bench.service } as unknown as ChatSessionManager
  connections = new ChatConnections(manager)
  // As ChatSessionManager wires it: plan writes and linked-task changes.
  bench.plans.subscribe(plan => connections.publishPlans(plan.teamId, plan.id))
  bench.tasks.subscribe(task => { if (task.planId) connections.publishPlans(task.teamId, task.planId) })
})

const send = (message: ClientMessage) => connections.handle(connection, message)
const all = <T extends ServerMessage['type']>(type: T) =>
  messages.filter((message): message is Extract<ServerMessage, { type: T }> => message.type === type)
const last = <T extends ServerMessage['type']>(type: T) => all(type).at(-1)

describe('subscriptions', () => {
  test('the repository path and a worktree path open the same team; an unknown path is refused', async () => {
    const { planId } = await bench.draftInReview()
    await send({ type: 'team-plans-open', teamPath: world.repo })
    await send({ type: 'team-plans-open', teamPath: world.feature })
    const [main, feature] = all('team-plans-snapshot')
    expect(main).toMatchObject({ teamPath: world.repo, teamId: world.team.teamId })
    expect(feature).toMatchObject({ teamPath: world.feature, teamId: world.team.teamId })
    expect(main!.plans.map(plan => plan.id)).toEqual([planId])
    expect(feature!.plans).toEqual(main!.plans)
    messages = []
    await send({ type: 'team-plans-open', teamPath: world.other })
    await send({ type: 'team-plan-open', teamPath: '/nowhere', planId })
    expect(messages.map(message => message.type)).toEqual(['error', 'error'])
    expect(messages[0]).toMatchObject({ message: expect.stringContaining(world.other) })
  })

  test('another team\'s plan id is refused with no data', async () => {
    const foreign = bench.plans.insertPlan({ teamId: world.otherTeam.teamId, title: 'Secret', creator: { kind: 'human', sessionId: null } })
    await send({ type: 'team-plan-open', teamPath: world.repo, planId: foreign })
    expect(messages).toEqual([{ type: 'error', message: `Plan not found in this team: ${foreign}` }])
    await send({ type: 'team-plans-open', teamPath: world.repo })
    expect(last('team-plans-snapshot')!.plans).toEqual([])
    // A write to it reaches no subscriber of this team.
    messages = []
    bench.plans.announce(foreign)
    expect(messages).toEqual([])
  })

  test('a linked task\'s status change pushes the open detail; close stops pushes', async () => {
    const { planId, revision } = await bench.draftInReview()
    await bench.approve(planId, revision)
    await send({ type: 'team-plan-open', teamPath: world.repo, planId })
    expect(last('team-plan-detail')!.detail.progress!.changes[0]!.status).toBe('not-started')
    const task = await tasks.create(bench.agent('lead'), { title: 'API', direction: 'Build', plan_id: planId, plan_change: 'api' })
    expect(last('team-plan-detail')!.detail.progress!.changes[0]!.status).toBe('in-progress')
    await tasks.setStatus(bench.agent('lead'), task.id, 'done')
    expect(last('team-plan-detail')!.detail.progress!.changes[0]!.status).toBe('done')
    await send({ type: 'team-plan-close', teamPath: world.repo, planId })
    messages = []
    await tasks.note(bench.agent('lead'), task.id, 'more')
    await tasks.setStatus(bench.agent('lead'), task.id, 'active')
    expect(all('team-plan-detail')).toEqual([])
  })
})

describe('human commands', () => {
  test('approve answers with the plan and event, pushes, and replays its command id', async () => {
    const { planId, revision, hash } = await bench.draftInReview()
    await send({ type: 'team-plans-open', teamPath: world.repo })
    await send({ type: 'team-plan-open', teamPath: world.repo, planId })
    const approve = { type: 'team-plan-approve' as const, teamPath: world.repo, requestId: 'a1', planId, revision, contentHash: hash, expectedApprovedRevision: null, commandId: 'cmd-approve' }
    await send(approve)
    expect(last('team-plan-result')).toMatchObject({ requestId: 'a1', replayed: false, plan: { currentApprovedRevision: 1, state: 'ready' }, event: { kind: 'approved', revision: 1 } })
    expect(last('team-plans-snapshot')!.plans[0]!.state).toBe('ready')
    expect(last('team-plan-detail')!.detail.revisions[0]!.status).toBe('approved')
    const pushes = messages.length
    await send({ ...approve, requestId: 'a2' })
    expect(last('team-plan-result')).toMatchObject({ requestId: 'a2', replayed: true, event: { kind: 'approved' } })
    expect(messages.length).toBe(pushes + 1)
    await send({ ...approve, requestId: 'a3', contentHash: 'other' })
    expect(last('team-plan-result')).toMatchObject({ requestId: 'a3', reason: 'payload', error: expect.stringContaining('different contentHash') })
  })

  test('a refused approval names every failing precondition', async () => {
    const { planId, revision } = await bench.draftInReview()
    await send({ type: 'team-plan-approve', teamPath: world.repo, requestId: 'a1', planId, revision, contentHash: 'stale', expectedApprovedRevision: 3, commandId: 'c1' })
    const result = last('team-plan-result')!
    expect(result.reason).toBe('precondition')
    expect(result.failures!.map(failure => failure.name)).toEqual(['hash-matches', 'approved-revision-unchanged'])
  })

  test('withdraw, close, and reopen round trips', async () => {
    const { planId, revision } = await bench.draftInReview()
    await send({ type: 'team-plan-open', teamPath: world.repo, planId })
    await send({ type: 'team-plan-withdraw', teamPath: world.repo, requestId: 'w1', planId, revision, commandId: 'w' })
    expect(last('team-plan-result')).toMatchObject({ requestId: 'w1', event: { kind: 'withdrawn', revision } })
    expect(last('team-plan-detail')!.detail.revisions[0]!.status).toBe('withdrawn')
    await send({ type: 'team-plan-withdraw', teamPath: world.repo, requestId: 'w2', planId, draftId: 'lead', commandId: 'd' })
    expect(last('team-plan-result')).toMatchObject({ requestId: 'w2', event: { kind: 'draft-discarded' } })
    await send({ type: 'team-plan-close', teamPath: world.repo, requestId: 'c1', planId, outcome: 'cancelled', commandId: 'c' })
    expect(last('team-plan-result')).toMatchObject({ requestId: 'c1', reason: 'invalid', error: 'Cancelling a plan needs a reason.' })
    await send({ type: 'team-plan-close', teamPath: world.repo, requestId: 'c2', planId, outcome: 'cancelled', reason: 'Dropped', commandId: 'c' })
    expect(last('team-plan-result')).toMatchObject({ requestId: 'c2', plan: { lifecycle: 'cancelled', state: 'cancelled' }, event: { kind: 'cancelled', reason: 'Dropped' } })
    expect(last('team-plan-detail')!.detail.plan.lifecycle).toBe('cancelled')
    await send({ type: 'team-plan-reopen', teamPath: world.repo, requestId: 'r1', planId, commandId: 'r' })
    expect(last('team-plan-result')).toMatchObject({ requestId: 'r1', plan: { lifecycle: 'open' }, event: { kind: 'reopened' } })
    expect(last('team-plan-detail')!.detail.plan.lifecycle).toBe('open')
  })

  test('commands on an unknown path or another team\'s plan are refused', async () => {
    const foreign = bench.plans.insertPlan({ teamId: world.otherTeam.teamId, title: 'Secret', creator: { kind: 'human', sessionId: null } })
    await send({ type: 'team-plan-reopen', teamPath: world.other, requestId: 'x1', planId: foreign, commandId: 'r' })
    expect(last('team-plan-result')).toMatchObject({ requestId: 'x1', error: expect.stringContaining('unknown-team') })
    await send({ type: 'team-plan-reopen', teamPath: world.repo, requestId: 'x2', planId: foreign, commandId: 'r' })
    expect(last('team-plan-result')).toMatchObject({ requestId: 'x2', reason: 'not-found', error: `Plan not found in this team: ${foreign}` })
    expect(last('team-plan-result')!.plan).toBeUndefined()
  })
})

test('every new plan client type is listed for the WS router', () => {
  for (const type of ['team-plans-open', 'team-plans-close', 'team-plan-open', 'team-plan-close', 'team-plan-approve', 'team-plan-withdraw', 'team-plan-reopen']) {
    expect(CHAT_CONNECTION_TYPES as readonly string[]).toContain(type)
  }
})
