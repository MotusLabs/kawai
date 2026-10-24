// The team bindings subscription (plan-workspace §6.2, Lead-authorized Q1):
// the panel's lazy `team-plan-workspace-bindings-open`/`-close` over the real
// connection path — the open's first push needs no plan open, a committed
// bind re-pushes the team bindings through it, an unchanged payload stays
// quiet (the O6 diff), a close stops the pushes, an unknown path is refused
// storing nothing, another team never receives this team's bindings, and a
// disconnect drops the subscription. Every path asserts zero agent starts
// (invariant I6) — the manager double's start seams throw and count.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import type { ChatSessionManager } from '../chat/ChatSessionManager'
import { ChatConnections } from '../chat/ChatConnections'
import type { ClientMessage, ServerMessage } from '../../shared/types'
import { planInput } from '../../shared/__tests__/planFixtures'
import { createPlanBench, createPlanWorld, sessionRow, writeGroup, type PlanWorld } from './planHarness'
import { PlanWorkspaceStore } from '../plans/workspace/workspaceStore'
import { PlanWorkspaceRefs } from '../plans/workspace/workspaceRefs'
import { TeamScopes } from '../team/teamScope'
import type { SessionTeams } from '../team/sessionTeams'
import type { TeamIdentity } from '../team/teamIdentity'

let world: PlanWorld
let bench: ReturnType<typeof createPlanBench>
let connections: ChatConnections
let messages: ServerMessage[]
let agentStarts = 0
let records: Map<string, ReturnType<typeof sessionRow>>
const teamOfMap = new Map<string, TeamIdentity>()
const connection = { send: (message: ServerMessage) => messages.push(message) }

beforeAll(async () => {
  world = await createPlanWorld('kawai-plan-workspace-bindings-')
})
afterAll(() => fs.rmSync(world.root, { recursive: true, force: true }))
beforeEach(() => {
  writeGroup(world, 'leads', '---\ncanCreatePlans: true\n---\nLead.')
  bench = createPlanBench(world)
  messages = []
  agentStarts = 0
  records = new Map<string, ReturnType<typeof sessionRow>>([
    ['lead-chat', sessionRow('lead-chat', 'leads', world.repo)],
  ])
  teamOfMap.clear()
  for (const id of records.keys()) teamOfMap.set(id, world.team)
  const forbidden = (what: string) => () => { agentStarts += 1; throw new Error(`I6: ${what} must not be called`) }
  const manager = {
    whenRestored: () => Promise.resolve(),
    teamScopes: new TeamScopes({ teams: { hasTeam: async () => false } as unknown as SessionTeams, repositories: () => [world.team.teamId] }),
    plans: bench.service,
    planWorkspace: new PlanWorkspaceStore(bench.db.db),
    planWorkspaceRefs: new PlanWorkspaceRefs(bench.db.db),
    tasks: { worktrees: { list: async () => [world.repo] } },
    has: (id: string) => records.has(id),
    isArchived: (id: string) => records.get(id)?.archivedAt != null,
    teams: { teamOf: (id: string) => teamOfMap.get(id) },
    directory: { get: (teamId: string, id: string) => (records.has(id) ? { sessionId: id, name: `name-${id}`, group: null } : null) },
    ensureDriver: forbidden('ensureDriver'),
    start: forbidden('start'),
    restore: forbidden('restore'),
    loadHistory: forbidden('loadHistory'),
  } as unknown as ChatSessionManager
  connections = new ChatConnections(manager)
})

const send = (message: ClientMessage) => connections.handle(connection, message)
const all = <T extends ServerMessage['type']>(type: T) =>
  messages.filter((message): message is Extract<ServerMessage, { type: T }> => message.type === type)
const last = <T extends ServerMessage['type']>(type: T) => all(type).at(-1)
const bind = (over: Partial<Extract<ClientMessage, { type: 'team-plan-workspace-bind' }>> = {}) =>
  ({ type: 'team-plan-workspace-bind', teamPath: world.repo, requestId: 'bq', commandId: 'bind-q', role: 'lead', sessionId: 'lead-chat', expectedVersion: null, ...over }) as Extract<ClientMessage, { type: 'team-plan-workspace-bind' }>

describe('team bindings subscription (Q1)', () => {
  const bindings = () => all('team-plan-workspace-bindings')

  test('open pushes the current bindings; a committed bind re-pushes through the same subscription', async () => {
    await bench.service.create(bench.agent('lead'), { title: 'Wave C', content: planInput() })
    await send({ type: 'team-plan-workspace-bindings-open', teamPath: world.repo })
    // The open answers its first push synchronously, no plan open required.
    expect(bindings()).toHaveLength(1)
    expect(bindings()[0]).toMatchObject({ teamPath: world.repo, teamId: world.team.teamId, bindings: [] })
    // A committed bind re-pushes the team bindings (unbound → bound) without
    // any plan subscription on this connection.
    await send(bind())
    expect(last('team-plan-workspace-result')).toMatchObject({ requestId: 'bq', replayed: false })
    await connections.flushPlanWorkspace()
    expect(bindings()).toHaveLength(2)
    expect(bindings()[1]!.bindings).toEqual([
      { role: 'lead', sessionId: 'lead-chat', version: 1, availability: 'live', name: 'name-lead-chat' },
    ])
    expect(agentStarts).toBe(0)
  })

  test('an unchanged state stays quiet (diff): a replayed bind pushes nothing', async () => {
    await send({ type: 'team-plan-workspace-bindings-open', teamPath: world.repo })
    await send(bind())
    await connections.flushPlanWorkspace()
    const seen = bindings().length
    // The replay writes nothing, so the bindings payload is unchanged and the
    // O6 diff keeps the pass quiet.
    await send(bind({ requestId: 'bq2' }))
    expect(last('team-plan-workspace-result')).toMatchObject({ requestId: 'bq2', replayed: true })
    await connections.flushPlanWorkspace()
    expect(bindings()).toHaveLength(seen)
  })

  test('close stops the pushes; a later committed bind answers but pushes nothing', async () => {
    await send({ type: 'team-plan-workspace-bindings-open', teamPath: world.repo })
    await send({ type: 'team-plan-workspace-bindings-close', teamPath: world.repo })
    const seen = bindings().length
    await send(bind())
    expect(last('team-plan-workspace-result')).toMatchObject({ requestId: 'bq', replayed: false })
    await connections.flushPlanWorkspace()
    expect(bindings()).toHaveLength(seen)
  })

  test('an unknown path is refused and stores no subscription; teams stay isolated', async () => {
    await send({ type: 'team-plan-workspace-bindings-open', teamPath: world.other })
    expect(messages).toEqual([{ type: 'error', message: expect.stringContaining('unknown-team') }])
    expect(bindings()).toHaveLength(0)
    // The refused open subscribed to nothing: the bind of the real team
    // reaches only connections that subscribed to it.
    const otherMessages: ServerMessage[] = []
    await connections.handle({ send: (message: ServerMessage) => otherMessages.push(message) },
      { type: 'team-plan-workspace-bindings-open', teamPath: world.repo })
    expect(otherMessages.filter(message => message.type === 'team-plan-workspace-bindings')).toHaveLength(1)
    await send(bind())
    await connections.flushPlanWorkspace()
    // The refused connection: nothing. The subscribed one: the bound state.
    expect(bindings()).toHaveLength(0)
    expect(otherMessages.filter(message => message.type === 'team-plan-workspace-bindings')).toHaveLength(2)
    expect(agentStarts).toBe(0)
  })

  test('a disconnect drops the subscription: a later bind pushes it nothing', async () => {
    await send({ type: 'team-plan-workspace-bindings-open', teamPath: world.repo })
    expect(bindings()).toHaveLength(1)
    connections.disconnect(connection)
    await send(bind())
    expect(last('team-plan-workspace-result')).toMatchObject({ requestId: 'bq', replayed: false })
    await connections.flushPlanWorkspace()
    expect(bindings()).toHaveLength(1)
    expect(agentStarts).toBe(0)
  })
})
