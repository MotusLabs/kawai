// The owner's hold and pause commands over the socket (revision-control
// 9.1, design D14; oracles PT1–PT7 of the design's "Remainder"). Every row
// runs through the real WS router (`handleMessage`), the real ChatConnections
// and PlanConnections, and the services `composePlanServices` builds — the
// construction the server runs. Each frame is a JSON string the router
// parses; the answers come back on the socket peer.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import type { ServerWebSocket } from 'bun'
import type { ChatSessionManager } from '../chat/ChatSessionManager'
import { ChatConnections } from '../chat/ChatConnections'
import { CHAT_CONNECTION_TYPES } from '../chat/chatConnectionTypes'
import { handleMessage, type MessageRouterContext } from '../ws/messageRouter'
import { TeamScopes } from '../team/teamScope'
import type { SessionTeams } from '../team/sessionTeams'
import { teamToolTable } from '../team/mailboxTools'
import type { TeamMailbox } from '../team/TeamMailbox'
import type { ClientMessage, ServerMessage } from '../../shared/types'
import { createPlanWorld, writeGroup, type PlanWorld } from './planHarness'
import { createImpactBench, type ImpactBench } from './impactHarness'
import { composePlanServices } from '../plans/planComposition'
import type { OpenspecAdapter } from '../plans/validation/openspecAdapter'

const FLOOR = { lint: ['ci'], typecheck: ['ci'], 'unit-tests': ['ci'], 'ci-e2e': ['e2e'] }
const NEW_TYPES = ['team-plan-hold-place', 'team-plan-hold-release', 'team-plan-hold-extend', 'team-plan-pause', 'team-plan-pause-resolve'] as const

let world: PlanWorld
let bench: ImpactBench
let messages: ServerMessage[]
let composed: ReturnType<typeof composePlanServices>
let route: (frame: ClientMessage) => void

const inDays = (days: number): string => new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString()

beforeAll(async () => {
  world = await createPlanWorld('kawai-rc-connections-')
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
  composed = composePlanServices({
    db: bench.db.db, plans: bench.plans, strategies: bench.strategies, impact: bench.impact, adapter: fakeAdapter(),
    getSession: id => bench.records.get(id), homeDir: world.home,
    caps: { planExecution: async () => ({ floorChecks: FLOOR, maxParallelChanges: 2, mergeMethod: 'merge' }) },
    executionValidation: { prepareStanding: async () => ({}), standing: () => ({ state: 'current', report: { id: 'r', inputHash: 'i', readiness: { carriedConditions: [] } } }) },
    executionProbe: async () => ({ findings: [], repo: 'acme/app', base: { branch: 'master', head: 'abc', tree: 'ttt' } }),
  })
  bench.service = composed.plans
  const teamScopes = new TeamScopes({ teams: { hasTeam: async () => false } as unknown as SessionTeams, repositories: () => [world.team.teamId, world.otherTeam.teamId] })
  const manager = {
    whenRestored: () => Promise.resolve(), teamScopes, plans: composed.plans, executions: composed.executions,
    impact: bench.impact, validation: composed.validation, validationDetail: composed.validationDetail,
  } as unknown as ChatSessionManager
  const connections = new ChatConnections(manager)
  bench.plans.subscribe(plan => connections.publishPlans(plan.teamId, plan.id))
  const peer = { send: (message: ServerMessage) => { messages.push(message) } }
  const ctx = {
    hub: { send: (_ws: unknown, message: ServerMessage) => { messages.push(message) } },
    chatConnections: connections, chatPeer: () => peer,
  } as unknown as MessageRouterContext
  route = frame => handleMessage(ctx, {} as ServerWebSocket<never>, JSON.stringify(frame))
})

const fakeAdapter = (): OpenspecAdapter => ({
  probe: async () => ({ tool: 'openspec', version: '1.14.2', capabilities: ['validate-strict-json', 'show-deltas-json'], ok: true, error: null }),
  validate: async () => ({ ok: true, error: null, valid: true, issues: [], issueCount: 0 }),
  showDeltas: async () => ({ ok: true, error: null, touches: [] }),
}) as unknown as OpenspecAdapter

const all = <T extends ServerMessage['type']>(type: T) =>
  messages.filter((message): message is Extract<ServerMessage, { type: T }> => message.type === type)

async function until(probe: () => boolean, tries = 200): Promise<void> {
  for (let attempt = 0; attempt < tries && !probe(); attempt += 1) await new Promise(resolve => setTimeout(resolve, 10))
}

/** Route one command frame and wait for its `team-plan-result` (or the router's error). */
async function command(frame: ClientMessage & { requestId: string }): Promise<Extract<ServerMessage, { type: 'team-plan-result' }> | Extract<ServerMessage, { type: 'error' }>> {
  route(frame)
  const answer = () => all('team-plan-result').find(message => message.requestId === frame.requestId) ?? all('error').at(-1)
  await until(() => answer() !== undefined)
  return answer()!
}

const holdRows = () => (bench.db.db.prepare('SELECT COUNT(*) AS n FROM plan_holds').get() as { n: number }).n
const holdEvents = () => (bench.db.db.prepare("SELECT COUNT(*) AS n FROM plan_events WHERE kind = 'hold-placed'").get() as { n: number }).n

/** An approved plan with a running execution of `api` and `ui`. */
async function runningPlan(): Promise<{ planId: string; executionId: string }> {
  const { planId, revision, hash } = await bench.draftInReview()
  await bench.approve(planId, revision)
  const started = await composed.executions.start({ kind: 'human', team: world.team }, { planId, revision, contentHash: hash, commandId: `start-${planId}` })
  if (!started.ok) throw new Error(started.message)
  return { planId, executionId: started.execution.id }
}

const place = (planId: string, requestId: string, overrides: Record<string, unknown> = {}) => ({
  type: 'team-plan-hold-place' as const, teamPath: world.repo, requestId, planId, scope: 'changes' as const,
  changes: ['api'], rationale: 'rethink the API', deadline: inDays(2), commandId: `cmd-${requestId}`, ...overrides,
}) as ClientMessage & { requestId: string }

describe('revision-control protocol through the router and planComposition (PT)', () => {
  test('PT1: each of the five new message types is listed in CHAT_CONNECTION_TYPES and the router forwards it', async () => {
    for (const type of NEW_TYPES) expect(CHAT_CONNECTION_TYPES).toContain(type)
    // Forwarded: each type reaches the plan handler and answers on the
    // socket — never the router's "Unknown message type".
    for (const type of NEW_TYPES) {
      messages = []
      const answer = await command({ type, teamPath: world.repo, requestId: `pt1-${type}`, planId: 'plan-none', holdId: 'hold-none', pauseId: 'pause-none', change: 'api', choice: 'continue', deadline: inDays(1), rationale: 'r', reason: 'r', scope: 'plan', commandId: `pt1-${type}` } as never)
      expect(answer.type).toBe('team-plan-result')
      expect(all('error')).toEqual([])
    }
  })

  test('PT2: a message naming an unknown teamPath is refused unknown-team and writes nothing', async () => {
    const { planId } = await runningPlan()
    const unknown = path.join(world.root, 'nowhere')
    for (const type of NEW_TYPES) {
      const answer = await command({ ...place(planId, `pt2-${type}`), type, teamPath: unknown, holdId: 'h', pauseId: 'p', change: 'api', choice: 'continue', reason: 'r' } as never)
      expect(answer).toMatchObject({ type: 'team-plan-result', reason: 'unknown-team', error: expect.stringContaining(unknown) })
    }
    expect(holdRows()).toBe(0)
    expect(holdEvents()).toBe(0)
  })

  // @covers: plan-holds › Only the owner places a hold › Unknown change names are refused
  test('PT3: team-plan-hold-place naming an unknown change carries the service refusal naming it and writes nothing', async () => {
    const { planId } = await runningPlan()
    const answer = await command(place(planId, 'pt3', { changes: ['api', 'nope'] }))
    expect(answer).toMatchObject({ type: 'team-plan-result', reason: 'invalid', error: expect.stringContaining('unknown change: nope') })
    expect((answer as { failures?: unknown[] }).failures).toEqual([{ name: 'invalid', message: 'unknown change: nope' }])
    expect((answer as { hold?: unknown }).hold).toBeUndefined()
    expect(holdRows()).toBe(0)
    expect(holdEvents()).toBe(0)
  })

  test('PT4: a command resent with the same command id and payload carries the first outcome and writes no second row or event', async () => {
    const { planId } = await runningPlan()
    const first = await command(place(planId, 'pt4a', { commandId: 'pt4' }))
    const second = await command(place(planId, 'pt4b', { commandId: 'pt4', deadline: (first as { hold: { deadline: string } }).hold.deadline }))
    expect(first).toMatchObject({ replayed: false, hold: { scope: 'changes', changes: ['api'] } })
    expect(second).toMatchObject({ replayed: true, hold: { id: (first as { hold: { id: string } }).hold.id } })
    expect(holdRows()).toBe(1)
    expect(holdEvents()).toBe(1)
  })

  test('PT5: the same command id with a different payload is refused naming the first differing field', async () => {
    const { planId } = await runningPlan()
    await command(place(planId, 'pt5a', { commandId: 'pt5' }))
    const answer = await command(place(planId, 'pt5b', { commandId: 'pt5', rationale: 'a different reason' }))
    expect(answer).toMatchObject({ type: 'team-plan-result', reason: 'payload', error: expect.stringContaining('rationale') })
    expect(holdRows()).toBe(1)
  })

  test('PT6: team-plan-hold-place for a running execution\'s change carries the hold, and the next team-plan-detail push lists it', async () => {
    const { planId, executionId } = await runningPlan()
    expect(composed.executionStore.change(executionId, 'api')).not.toBeNull()
    route({ type: 'team-plan-open', teamPath: world.repo, planId })
    await until(() => all('team-plan-detail').length > 0)
    expect(all('team-plan-detail').at(-1)?.holds).toEqual([])
    const before = all('team-plan-detail').length
    const answer = await command(place(planId, 'pt6'))
    expect(answer).toMatchObject({ type: 'team-plan-result', replayed: false, hold: { scope: 'changes', changes: ['api'], rationale: 'rethink the API', releasedAt: null } })
    const holdId = (answer as { hold: { id: string } }).hold.id
    await until(() => all('team-plan-detail').length > before)
    const pushed = all('team-plan-detail').at(-1)!
    expect(pushed.holds?.map(hold => hold.id)).toEqual([holdId])
    expect(pushed.holds?.[0]).toMatchObject({ scope: 'changes', changes: ['api'], releasedChanges: [], cites: null, releaseReason: null })
  })

  // @covers: plan-holds › Only the owner places a hold › Agents cannot hold
  test('PT7: no agent tool places, releases, or extends a hold, pauses, or resolves a pause; task_checkpoint stays the only revision-control tool', () => {
    const stub = {} as never
    const names = teamToolTable({} as TeamMailbox, 'chat-agent', {
      tasks: stub, results: stub, strategies: stub, plans: stub, validation: stub, decisions: stub, impact: stub,
      releases: stub, management: stub, metrics: stub, reports: stub, checkpoints: stub, capacity: stub,
    }).map(spec => spec.name)
    expect(names).toContain('task_checkpoint')
    expect(names.filter(name => /hold|pause|resume|checkpoint|apply/i.test(name))).toEqual(['task_checkpoint'])
  })
})
