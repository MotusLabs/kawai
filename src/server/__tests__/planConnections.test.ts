// Plan subscriptions and human commands over the chat connection
// (durable-plans 7.1): opened by repository or worktree path through the real
// team-scope resolver, unknown paths and another team's plan ids refused
// with no data, approve/withdraw/close/reopen round trips answered by
// `team-plan-result` and pushed to subscribers, a linked task's change
// pushing the open detail, and every new type listed for the WS router.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import type { ChatSessionManager } from '../chat/ChatSessionManager'
import { ChatConnections } from '../chat/ChatConnections'
import { CHAT_CONNECTION_TYPES } from '../chat/chatConnectionTypes'
import { TaskService } from '../team/TaskService'
import { TeamScopes } from '../team/teamScope'
import type { SessionTeams } from '../team/sessionTeams'
import type { ClientMessage, ServerMessage } from '../../shared/types'
import { createPlanWorld, writeGroup, type PlanWorld } from './planHarness'
import { createImpactBench, type ImpactBench } from './impactHarness'
import { composePlanServices } from '../plans/planComposition'
import type { OpenspecAdapter } from '../plans/validation/openspecAdapter'

let world: PlanWorld
let bench: ImpactBench
let tasks: TaskService
let connections: ChatConnections
let messages: ServerMessage[]
let composedServices: ReturnType<typeof composePlanServices>
const connection = { send: (message: ServerMessage) => messages.push(message) }

beforeAll(async () => {
  world = await createPlanWorld('kawai-plan-connections-')
  // Registered OpenSpec changes the fixture plan names, so a validation can
  // reach a ready report (plan-validation).
  for (const change of ['api', 'ui']) {
    fs.mkdirSync(path.join(world.repo, 'openspec', 'changes', change, 'specs', 'chat'), { recursive: true })
    fs.writeFileSync(path.join(world.repo, 'openspec', 'changes', change, 'proposal.md'), `# ${change}\n`)
  }
  // The fixture plan's review group, so groups-known passes.
  writeGroup(world, 'reviewers', 'Review.')
})
afterAll(() => fs.rmSync(world.root, { recursive: true, force: true }))
beforeEach(() => {
  bench?.db.close()
  writeGroup(world, 'leads', '---\ncanCreatePlans: true\ncanCreateTasks: true\n---\nLead.')
  bench = createImpactBench(world)
  tasks = new TaskService(bench.tasks, { getSession: id => bench.records.get(id), homeDir: world.home, plans: bench.plans })
  messages = []
  // The production plan composition (plan-validation M1), so the detail
  // pushes carry the Validation section exactly as the server sends it.
  const planServices = composePlanServices({
    db: bench.db.db, plans: bench.plans, strategies: bench.strategies, impact: bench.impact, adapter: fakeAdapter(),
    getSession: id => bench.records.get(id), homeDir: world.home,
  })
  bench.service = planServices.plans
  composedServices = planServices
  // Only this repository is discovered; the other one is no known team.
  const teamScopes = new TeamScopes({ teams: { hasTeam: async () => false } as unknown as SessionTeams, repositories: () => [world.team.teamId] })
  const manager = { whenRestored: () => Promise.resolve(), teamScopes, plans: planServices.plans, impact: bench.impact, validation: planServices.validation, validationDetail: planServices.validationDetail } as unknown as ChatSessionManager
  connections = new ChatConnections(manager)
  // As ChatSessionManager wires it: plan writes and linked-task changes.
  bench.plans.subscribe(plan => connections.publishPlans(plan.teamId, plan.id))
  bench.tasks.subscribe(task => { if (task.planId) connections.publishPlans(task.teamId, task.planId) })
})

/** A canned adapter: the probe answers, both CLI calls succeed with nothing. */
const fakeAdapter = (): OpenspecAdapter => ({
  probe: async () => ({ tool: 'openspec', version: '1.14.2', capabilities: ['validate-strict-json', 'show-deltas-json'], ok: true, error: null }),
  validate: async () => ({ ok: true, error: null, valid: true, issues: [], issueCount: 0 }),
  showDeltas: async () => ({ ok: true, error: null, touches: [] }),
}) as unknown as OpenspecAdapter

/** Wait a few ticks for an async detail push (its validation build is awaited inside). */
async function untilDetail(probe: (message: Extract<ServerMessage, { type: 'team-plan-detail' }>) => boolean, tries = 100): Promise<void> {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    const arrived = all('team-plan-detail').filter(probe)
    if (arrived.length > 0) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

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
    await untilDetail(message => message.detail.progress!.changes[0]!.status === 'in-progress')
    expect(last('team-plan-detail')!.detail.progress!.changes[0]!.status).toBe('in-progress')
    await tasks.setStatus(bench.agent('lead'), task.id, 'done')
    await untilDetail(message => message.detail.progress!.changes[0]!.status === 'done')
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
    // Approval now requires a current, ready validation report first
    // (plan-validation D9's `validation-current`, wired through the
    // composition this bench uses).
    await send({ type: 'team-plan-validate', teamPath: world.repo, requestId: 'v0', planId, revision })
    expect(last('team-plan-result')).toMatchObject({ requestId: 'v0', validation: { stored: true, dryRun: false } })
    await send({ type: 'team-plans-open', teamPath: world.repo })
    await send({ type: 'team-plan-open', teamPath: world.repo, planId })
    const approve = { type: 'team-plan-approve' as const, teamPath: world.repo, requestId: 'a1', planId, revision, contentHash: hash, expectedApprovedRevision: null, commandId: 'cmd-approve' }
    await send(approve)
    expect(last('team-plan-result')).toMatchObject({ requestId: 'a1', replayed: false, plan: { currentApprovedRevision: 1, state: 'ready' }, event: { kind: 'approved', revision: 1 } })
    expect(last('team-plans-snapshot')!.plans[0]!.state).toBe('ready')
    await untilDetail(message => message.detail.revisions[0]!.status === 'approved')
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
    expect(result.failures!.map(failure => failure.name)).toEqual(['hash-matches', 'approved-revision-unchanged', 'validation-current'])
  })

  test('withdraw, close, and reopen round trips', async () => {
    const { planId, revision } = await bench.draftInReview()
    await send({ type: 'team-plan-open', teamPath: world.repo, planId })
    await send({ type: 'team-plan-withdraw', teamPath: world.repo, requestId: 'w1', planId, revision, commandId: 'w' })
    expect(last('team-plan-result')).toMatchObject({ requestId: 'w1', event: { kind: 'withdrawn', revision } })
    expect(last('team-plan-detail')!.detail.revisions[0]!.status).toBe('withdrawn')
    await send({ type: 'team-plan-withdraw', teamPath: world.repo, requestId: 'w2', planId, draftId: 'lead', commandId: 'd' })
    expect(last('team-plan-result')).toMatchObject({ requestId: 'w2', event: { kind: 'draft-discarded' } })
    await send({ type: 'team-plan-finish', teamPath: world.repo, requestId: 'c1', planId, outcome: 'cancelled', commandId: 'c' })
    expect(last('team-plan-result')).toMatchObject({ requestId: 'c1', reason: 'invalid', error: 'Cancelling a plan needs a reason.' })
    await send({ type: 'team-plan-finish', teamPath: world.repo, requestId: 'c2', planId, outcome: 'cancelled', reason: 'Dropped', commandId: 'c' })
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
  for (const type of ['team-plans-open', 'team-plans-close', 'team-plan-open', 'team-plan-close', 'team-plan-approve', 'team-plan-withdraw', 'team-plan-finish', 'team-plan-reopen']) {
    expect(CHAT_CONNECTION_TYPES as readonly string[]).toContain(type)
  }
})

/** The detail push after a write is fire-and-forget; poll briefly for it. */
async function waitForPush() {
  const start = all('team-plan-detail').length
  for (let waited = 0; waited < 100; waited += 1) {
    const arrived = all('team-plan-detail').slice(start).filter(message => message.validation)
    if (arrived.length > 0) return arrived[0]!
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('no validation detail push arrived')
}

describe('plan validation commands and pushes (plan-validation 10.1/10.2)', () => {
  test('an unknown team path is refused as unknown-team; another team\'s plan is refused', async () => {
    const foreign = bench.plans.insertPlan({ teamId: world.otherTeam.teamId, title: 'Secret', creator: { kind: 'human', sessionId: null } })
    await send({ type: 'team-plan-validate', teamPath: '/no/such/repo', requestId: 'v1', planId: foreign, revision: 1 })
    expect(last('team-plan-result')).toMatchObject({ requestId: 'v1', error: expect.stringContaining('unknown-team') })
    await send({ type: 'team-plan-validate', teamPath: world.repo, requestId: 'v2', planId: foreign, revision: 1 })
    expect(last('team-plan-result')).toMatchObject({ requestId: 'v2', error: expect.stringContaining('Plan not found in this team') })
    await send({ type: 'team-plan-assess', teamPath: world.repo, requestId: 'v3', planId: foreign, revision: 1, alignment: { assessment: 'aligned', outcomes: [], conditions: [], experiment: null, conflicts: [], rationale: 'r' }, commandId: 'a' })
    expect(last('team-plan-result')).toMatchObject({ requestId: 'v3', error: expect.stringContaining('Plan not found in this team') })
    await send({ type: 'team-plan-validation-decide', teamPath: world.repo, requestId: 'v4', planId: foreign, revision: 1, kind: 'answer', target: 'pas-1', text: 'yes', commandId: 'd' })
    expect(last('team-plan-result')).toMatchObject({ requestId: 'v4', error: expect.stringContaining('Plan not found in this team') })
  })

  test('validate, assess, and decide each answer and push the open detail', async () => {
    bench.approveStrategy({ useCases: [{ ref: 'UC1' }] })
    const { planId, revision } = await bench.draftInReview()
    await send({ type: 'team-plan-open', teamPath: world.repo, planId })
    messages.length = 0

    // The owner's alignment assessment first — a pinned revision without one
    // is blocked as not assessed (D7), and the push shows the record.
    await send({ type: 'team-plan-assess', teamPath: world.repo, requestId: 'v2', planId, revision, alignment: { assessment: 'aligned', outcomes: [], conditions: [], experiment: null, conflicts: [], rationale: 'fits' }, commandId: 'assess-1' })
    expect(last('team-plan-result')).toMatchObject({ requestId: 'v2', assessment: { replayed: false } })
    const afterAssess = await waitForPush()
    expect(afterAssess.validation![0]).toMatchObject({ revision, standing: { state: 'not-validated' } })
    expect(afterAssess.validation![0].assessments).toHaveLength(1)

    await send({ type: 'team-plan-validate', teamPath: world.repo, requestId: 'v1', planId, revision })
    expect(last('team-plan-result')).toMatchObject({ requestId: 'v1', validation: { stored: true, dryRun: false, report: { ready: true } } })
    const pushed = await waitForPush()
    expect(pushed.validation![0]).toMatchObject({ revision, standing: { state: 'current', reportSeq: 1 }, report: { seq: 1 } })

    // A question from an agent, answered by the owner: the push follows the
    // decision, and the standing goes out of date (records changed).
    const asked = await composedServices.validation.assess({ kind: 'agent', sessionId: 'dev' }, {
      plan_id: planId, revision, questions: [{ text: 'which?', mandatory: true, subject: null }],
    })
    const questionId = asked.ok ? asked.ids.questions[0]! : ''
    await send({ type: 'team-plan-validation-decide', teamPath: world.repo, requestId: 'v3', planId, revision, kind: 'answer', target: questionId, text: 'documented', commandId: 'decide-1' })
    expect(last('team-plan-result')).toMatchObject({ requestId: 'v3', replayed: false })
    const afterDecide = await waitForPush()
    expect(afterDecide.validation![0].decisions).toHaveLength(1)
    expect(afterDecide.validation![0].standing).toMatchObject({ state: 'out-of-date', reportSeq: 1 })
  })

  test('the standing names the changed parts after an artifact edit', async () => {
    const { planId, revision } = await bench.draftInReview()
    await send({ type: 'team-plan-validate', teamPath: world.repo, requestId: 'v1', planId, revision })
    fs.writeFileSync(path.join(world.repo, 'openspec', 'changes', 'api', 'proposal.md'), '# api (moved on)\n')
    await send({ type: 'team-plan-open', teamPath: world.repo, planId })
    // The open's own detail is awaited by the connection, so it has arrived.
    const detail = all('team-plan-detail').filter(message => message.validation).at(-1)!
    expect(detail.validation![0].standing).toMatchObject({ state: 'out-of-date', changedParts: expect.arrayContaining(["api's artifacts"]) })
  })
})
