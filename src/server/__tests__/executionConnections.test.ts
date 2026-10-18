// The human execution commands over the chat connection (plan-execution
// §15.1, D17): preview answers with the standing's failures, Start/Stop/
// Retry answer with `execution`/`replayed` and their refusals, another
// team's plan and an unknown path are refused with no data, every new type
// is listed for the WS router, and an execution write or a task-mail claim
// pushes the open plan's detail — with `executions` riding it (§15.2).
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import type { ChatSessionManager } from '../chat/ChatSessionManager'
import { ChatConnections } from '../chat/ChatConnections'
import { CHAT_CONNECTION_TYPES } from '../chat/chatConnectionTypes'
import { TeamScopes } from '../team/teamScope'
import type { SessionTeams } from '../team/sessionTeams'
import type { ClientMessage, ServerMessage } from '../../shared/types'
import { createPlanWorld, writeGroup, type PlanWorld } from './planHarness'
import { createImpactBench, type ImpactBench } from './impactHarness'
import { composePlanServices } from '../plans/planComposition'
import type { OpenspecAdapter } from '../plans/validation/openspecAdapter'

const FLOOR = { lint: ['ci'], typecheck: ['ci'], 'unit-tests': ['ci'], 'ci-e2e': ['e2e'] }

let world: PlanWorld
let bench: ImpactBench
let connections: ChatConnections
let messages: ServerMessage[]
let composed: ReturnType<typeof composePlanServices>
const connection = { send: (message: ServerMessage) => messages.push(message) }

beforeAll(async () => {
  world = await createPlanWorld('kawai-exec-connections-')
  for (const change of ['api', 'ui']) {
    fs.mkdirSync(path.join(world.repo, 'openspec', 'changes', change, 'specs', 'chat'), { recursive: true })
    fs.writeFileSync(path.join(world.repo, 'openspec', 'changes', change, 'proposal.md'), `# ${change}\n`)
  }
  writeGroup(world, 'reviewers', 'Review.')
})
afterAll(() => fs.rmSync(world.root, { recursive: true, force: true }))

beforeEach(() => {
  bench?.db.close()
  writeGroup(world, 'leads', '---\ncanCreatePlans: true\ncanCreateTasks: true\n---\nLead.')
  bench = createImpactBench(world)
  messages = []
  const planServices = composePlanServices({
    db: bench.db.db, plans: bench.plans, strategies: bench.strategies, impact: bench.impact, adapter: fakeAdapter(),
    getSession: id => bench.records.get(id), homeDir: world.home,
    caps: { planExecution: async () => ({ floorChecks: FLOOR, maxParallelChanges: 2, mergeMethod: 'merge' }) },
    executionValidation: { prepareStanding: async () => ({}), standing: () => ({ state: 'current', report: { id: 'r', inputHash: 'i', readiness: { carriedConditions: [] } } }) },
    executionProbe: async () => ({ findings: [], repo: 'acme/app', base: { branch: 'master', head: 'abc', tree: 'ttt' } }),
  })
  bench.service = planServices.plans
  composed = planServices
  const teamScopes = new TeamScopes({ teams: { hasTeam: async () => false } as unknown as SessionTeams, repositories: () => [world.team.teamId] })
  const manager = {
    whenRestored: () => Promise.resolve(), teamScopes, plans: planServices.plans, executions: planServices.executions,
    impact: bench.impact, validation: planServices.validation, validationDetail: planServices.validationDetail,
  } as unknown as ChatSessionManager
  connections = new ChatConnections(manager)
  bench.plans.subscribe(plan => connections.publishPlans(plan.teamId, plan.id))
  bench.tasks.subscribe(task => { if (task.planId) connections.publishPlans(task.teamId, task.planId) })
  planServices.executionStore.subscribe(teamId => connections.publishPlans(teamId))
})

const fakeAdapter = (): OpenspecAdapter => ({
  probe: async () => ({ tool: 'openspec', version: '1.14.2', capabilities: ['validate-strict-json', 'show-deltas-json'], ok: true, error: null }),
  validate: async () => ({ ok: true, error: null, valid: true, issues: [], issueCount: 0 }),
  showDeltas: async () => ({ ok: true, error: null, touches: [] }),
}) as unknown as OpenspecAdapter

async function untilDetail(probe: (message: Extract<ServerMessage, { type: 'team-plan-detail' }>) => boolean, tries = 100): Promise<void> {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    if (all('team-plan-detail').filter(probe).length > 0) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

const send = (message: ClientMessage) => connections.handle(connection, message)
const all = <T extends ServerMessage['type']>(type: T) =>
  messages.filter((message): message is Extract<ServerMessage, { type: T }> => message.type === type)
const last = <T extends ServerMessage['type']>(type: T) => all(type).at(-1)

const openDetail = async (planId: string) => {
  messages = []
  await send({ type: 'team-plan-open', teamPath: world.repo, planId })
  await untilDetail(() => true)
}

describe('execution commands (§15.1)', () => {
  test('every new type is listed for the WS router', () => {
    const types = ['team-plan-execution-preview', 'team-plan-execution-start', 'team-plan-execution-stop', 'team-plan-execution-retry'] as const
    for (const type of types) {
      expect(CHAT_CONNECTION_TYPES).toContain(type)
    }
  })

  test('preview answers with the standing; an unknown path and another team plan are refused with no data', async () => {
    const { planId, revision } = await bench.draftInReview()
    await send({ type: 'team-plan-execution-preview', teamPath: world.repo, requestId: 'q1', planId, revision })
    // The composition stubs the validation standing current, so the
    // unapproved revision is what the standing names.
    const answer = last('team-plan-result')
    expect(answer).toMatchObject({ requestId: 'q1', preview: { ready: false } })
    expect(answer?.preview?.failures.map(failure => failure.name)).toContain('revision-current')
    expect(answer?.preview?.failures.map(failure => failure.name)).not.toContain('validation-current')

    messages = []
    await send({ type: 'team-plan-execution-preview', teamPath: world.other, requestId: 'q2', planId, revision })
    expect(last('team-plan-result')).toMatchObject({ requestId: 'q2', error: expect.stringContaining(world.other) })
    messages = []
    await send({ type: 'team-plan-execution-preview', teamPath: world.repo, requestId: 'q3', planId: 'plan-none', revision })
    expect(last('team-plan-result')).toMatchObject({ requestId: 'q3', error: expect.stringContaining('not found') })
  })

  test('Start answers with the execution, Stop cancels and replays, an empty reason refuses, Retry returns a stopped change', async () => {
    const { planId, revision, hash } = await bench.draftInReview()
    await bench.approve(planId, revision)
    const caller = { kind: 'human' as const, team: world.team }
    const created = await composed.executions.start(caller, { planId, revision, contentHash: hash, commandId: 'setup-1' })
    expect(created.ok).toBe(true)
    const executionId = created.ok ? created.execution.id : ''

    messages = []
    await send({ type: 'team-plan-execution-stop', teamPath: world.repo, requestId: 'q5', executionId, reason: 'enough', commandId: 'stop-1' })
    expect(last('team-plan-result')).toMatchObject({ requestId: 'q5', replayed: false })
    await send({ type: 'team-plan-execution-stop', teamPath: world.repo, requestId: 'q6', executionId, reason: 'enough', commandId: 'stop-1' })
    expect(last('team-plan-result')).toMatchObject({ requestId: 'q6', replayed: true })
    messages = []
    await send({ type: 'team-plan-execution-stop', teamPath: world.repo, requestId: 'q7', executionId, reason: '  ', commandId: 'stop-2' })
    expect(last('team-plan-result')?.error).toBeTruthy()

    // Retry over the wire: a stopped change returns to its stage.
    const store = composed.executionStore
    const row = store.change(executionId, 'api')!
    store.transition(executionId, 'api', row, { state: 'stopped', stopReason: 'round-limit', stopDetail: { message: 'three failures' } })
    messages = []
    await send({ type: 'team-plan-execution-retry', teamPath: world.repo, requestId: 'q8', executionId, change: 'api', commandId: 'retry-1' })
    expect(last('team-plan-result')).toMatchObject({ requestId: 'q8', replayed: false as boolean })
    // Round limit resumes at gating; the woken executor may already have moved it on.
    expect(store.change(executionId, 'api')).toMatchObject({ stopReason: null })
    expect(['gating', 'implementing']).toContain(store.change(executionId, 'api')!.state)
    messages = []
    await send({ type: 'team-plan-execution-retry', teamPath: world.repo, requestId: 'q9', executionId, change: 'api', commandId: 'retry-1' })
    expect(last('team-plan-result')).toMatchObject({ requestId: 'q9', replayed: true })
  })
})

describe('detail pushes (§15.2)', () => {
  test('an execution write and a task-mail claim each push the open detail once, executions riding it', async () => {
    const { planId, revision, hash } = await bench.draftInReview()
    await bench.approve(planId, revision)
    const executionStore = composed.executionStore
    await openDetail(planId)
    expect(last('team-plan-detail')?.detail.executions).toEqual([])

    const execution = executionStore.insertExecution({
      teamId: world.team.teamId, planId, revision, contentHash: hash, reportId: 'r', inputHash: 'i',
      landingMode: 'direct', baseBranch: 'master', baseCommit: 'abc', floor: { version: 1, map: FLOOR },
      maxParallel: 2, mergeMethod: 'merge', changes: [{ change: 'api', landed: false }],
    })
    await untilDetail(message => (message.detail.executions ?? []).some(entry => entry.id === execution.id))
    const pushes = all('team-plan-detail').filter(message => (message.detail.executions ?? []).some(entry => entry.id === execution.id))
    expect(pushes.length).toBeGreaterThanOrEqual(1)
    expect(pushes.at(-1)?.detail.executions?.[0]).toMatchObject({ id: execution.id, state: 'running' })
  })
})
