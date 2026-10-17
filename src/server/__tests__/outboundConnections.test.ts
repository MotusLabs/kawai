// The Audit tab's subscriptions over the shared team-scope resolver
// (execution-safety-recovery 4.1): opened by a repository path through the
// real resolver, an unknown path refused with no data, a page scoped to its
// team (another team's calls never appear and never notify), a committed
// row pushing `team-audit-changed` only to that team's subscribers, and
// every new type listed for the WS router. The recording store the manager
// hands the observer notifies only committed rows.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import type { ChatSessionManager } from '../chat/ChatSessionManager'
import { ChatConnections } from '../chat/ChatConnections'
import { CHAT_CONNECTION_TYPES } from '../chat/chatConnectionTypes'
import { TeamScopes } from '../team/teamScope'
import type { SessionTeams } from '../team/sessionTeams'
import type { ClientMessage, ServerMessage } from '../../shared/types'
import { createPlanWorld, type PlanWorld } from './planHarness'
import { initDatabase } from '../db'
import { OutboundStore, type OutboundCallInsert } from '../outbound/store'
import { OutboundService, recordingStore } from '../outbound/service'

let world: PlanWorld
let store: OutboundStore
let service: OutboundService
let connections: ChatConnections
let messages: ServerMessage[]
const dbs: Array<{ close(): void }> = []
const connection = { send: (message: ServerMessage) => messages.push(message) }

beforeAll(async () => {
  world = await createPlanWorld('kawai-outbound-connections-')
})
afterAll(() => {
  for (const db of dbs) db.close()
  fs.rmSync(world.root, { recursive: true, force: true })
})
beforeEach(() => {
  const db = initDatabase({ path: `${world.root}/db-${Math.random().toString(36).slice(2)}.db` })
  dbs.push(db)
  store = new OutboundStore(db.db)
  service = new OutboundService({
    store,
    sessionOf: (teamId, sessionId) => ({ name: `${sessionId}@${teamId.endsWith('/other/.git') ? 'other' : 'repo'}`, clickable: false }),
    spawnLive: () => false,
    // As the manager wires it: a committed acknowledgement notifies the views.
    onCommit: teamId => connections!.publishOutbound(teamId),
  })
  messages = []
  // Only this repository is discovered; the other one is no known team.
  const teamScopes = new TeamScopes({ teams: { hasTeam: async () => false } as unknown as SessionTeams, repositories: () => [world.team.teamId] })
  const manager = { whenRestored: () => Promise.resolve(), teamScopes, outboundAudit: service } as unknown as ChatSessionManager
  connections = new ChatConnections(manager)
})

let seq = 0
function call(overrides: Partial<OutboundCallInsert> = {}): OutboundCallInsert {
  seq += 1
  return {
    id: `obc-${seq}`,
    teamId: world.team.teamId,
    sessionId: 'chat-1',
    spawnId: 'sp-1',
    tool: 'Bash',
    toolUseId: `tu-${seq}`,
    command: 'git push origin main',
    truncated: false,
    rule: 'git-push',
    verdict: 'allowed',
    destination: 'github:origin',
    matches: '[]',
    classifierVersion: 3,
    cwd: world.repo,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

const send = (message: ClientMessage) => connections.handle(connection, message)
const last = <T extends ServerMessage['type']>(type: T) =>
  messages.filter((message): message is Extract<ServerMessage, { type: T }> => message.type === type).at(-1)

describe('subscriptions', () => {
  test('an unknown path is refused with no data', async () => {
    await send({ type: 'team-audit-open', teamPath: '/nowhere', requestId: 'r1', filters: {} })
    expect(messages.map(message => message.type)).toEqual(['error'])
    expect(messages[0]).toMatchObject({ message: expect.stringContaining('/nowhere') })
  })

  test('a page is scoped to its team: another team\'s calls never appear', async () => {
    store.insertCall(call({ id: 'obc-mine' }))
    store.insertCall(call({ id: 'obc-theirs', teamId: world.otherTeam.teamId, sessionId: 'chat-2' }))
    await send({ type: 'team-audit-open', teamPath: world.repo, requestId: 'r2', filters: {} })
    const page = last('team-audit-page')!
    expect(page).toMatchObject({ teamPath: world.repo, teamId: world.team.teamId, requestId: 'r2' })
    expect(page.page.rows.map(row => row.id)).toEqual(['obc-mine'])
  })

  test('a committed row of the team pushes changed; another team\'s commits do not', async () => {
    await send({ type: 'team-audit-open', teamPath: world.repo, requestId: 'r3', filters: {} })
    messages = []
    // The manager wires the recording store's commits to publishOutbound.
    connections.publishOutbound(world.otherTeam.teamId)
    expect(messages).toEqual([])
    connections.publishOutbound(world.team.teamId)
    expect(last('team-audit-changed')).toMatchObject({ teamPath: world.repo, teamId: world.team.teamId })
  })

  test('close ends the pushes; filters ride the subscription and the page', async () => {
    store.insertCall(call({ id: 'obc-a', verdict: 'allowed', rule: 'git-push' }))
    store.insertCall(call({ id: 'obc-b', verdict: 'violation', rule: 'gh-write', destination: 'github:other/repo', createdAt: '2026-01-02T00:00:00.000Z' }))
    await send({ type: 'team-audit-open', teamPath: world.repo, requestId: 'r4', filters: { verdict: 'violation' } })
    expect(last('team-audit-page')!.page.rows.map(row => row.id)).toEqual(['obc-b'])
    // The counts stay over the range, not the verdict filter (D9).
    expect(last('team-audit-page')!.page.counts).toMatchObject({ violations: 1, allowedPerRule: { 'git-push': 1 } })
    await send({ type: 'team-audit-close', teamPath: world.repo })
    messages = []
    connections.publishOutbound(world.team.teamId)
    expect(messages).toEqual([])
  })
})

describe('acknowledge over the wire', () => {
  test('another team\'s call id is refused with nothing written', async () => {
    const foreign = call({ id: 'obc-foreign', teamId: world.otherTeam.teamId, verdict: 'violation', rule: 'gh-write', destination: 'github:other/repo' })
    store.insertCall(foreign)
    await send({ type: 'team-audit-acknowledge', teamPath: world.repo, requestId: 'r5', callId: 'obc-foreign', commandId: 'cmd-1' })
    expect(last('team-audit-result')).toMatchObject({ requestId: 'r5', error: expect.stringContaining('not found') })
    expect(store.acknowledgementByCommand(world.team.teamId, 'cmd-1')).toBeNull()
  })

  test('a violation of the team acknowledges once and replays', async () => {
    store.insertCall(call({ id: 'obc-v', verdict: 'violation', rule: 'gh-write', destination: 'github:other/repo', createdAt: '2026-01-03T00:00:00.000Z' }))
    await send({ type: 'team-audit-open', teamPath: world.repo, requestId: 'r-open', filters: {} })
    messages = []
    await send({ type: 'team-audit-acknowledge', teamPath: world.repo, requestId: 'r6', callId: 'obc-v', commandId: 'cmd-2', note: 'mine' })
    expect(last('team-audit-result')).toEqual({ type: 'team-audit-result', teamPath: world.repo, requestId: 'r6' })
    await send({ type: 'team-audit-acknowledge', teamPath: world.repo, requestId: 'r7', callId: 'obc-v', commandId: 'cmd-2', note: 'mine' })
    expect(last('team-audit-result')).toMatchObject({ requestId: 'r7', replayed: true })
    // The commit notified the subscribers.
    expect(messages.filter(message => message.type === 'team-audit-changed')).toHaveLength(1)
  })
})

describe('the recording store', () => {
  test('a committed call and outcome notify their team; a repeat notifies nothing', () => {
    const commits: string[] = []
    const recording = recordingStore(store, teamId => commits.push(teamId))
    recording.insertCall(call({ id: 'obc-rc', toolUseId: 'tu-rc' }))
    expect(commits).toEqual([world.team.teamId])
    recording.insertCall(call({ id: 'obc-rc-dup', toolUseId: 'tu-rc' }))
    expect(commits).toHaveLength(1)
    recording.insertOutcome({ sessionId: 'chat-1', toolUseId: 'tu-rc', outcome: 'completed', createdAt: '2026-01-01T00:00:01.000Z' })
    expect(commits).toHaveLength(2)
    // An outcome whose call row does not exist yet notifies nobody: the
    // deferred call row's own commit does, moments later.
    recording.insertOutcome({ sessionId: 'chat-1', toolUseId: 'tu-never', outcome: 'denied', createdAt: '2026-01-01T00:00:02.000Z' })
    expect(commits).toHaveLength(2)
    // A repeat of the same outcome is a no-op.
    recording.insertOutcome({ sessionId: 'chat-1', toolUseId: 'tu-rc', outcome: 'completed', createdAt: '2026-01-01T00:00:03.000Z' })
    expect(commits).toHaveLength(2)
  })
})

describe('the router whitelist', () => {
  test('every team-audit type is listed', () => {
    expect(CHAT_CONNECTION_TYPES).toEqual(expect.arrayContaining([
      'team-audit-open', 'team-audit-more', 'team-audit-close', 'team-audit-acknowledge',
    ]))
  })
})

describe('the group open (findings-bee1aa24 B1)', () => {
  test('a destination filter rides the request and the page', async () => {
    store.insertCall(call({ id: 'obc-a', destination: 'github:origin', rule: 'git-push', verdict: 'allowed' }))
    store.insertCall(call({ id: 'obc-b', destination: 'github:other/repo', rule: 'gh-write', verdict: 'violation' }))
    await send({ type: 'team-audit-open', teamPath: world.repo, requestId: 'rd', filters: { destination: 'github:other/repo' } })
    expect(last('team-audit-page')!.page.rows.map(row => row.id)).toEqual(['obc-b'])
  })

  test("an open naming a call id answers the group's page with the applied filters", async () => {
    store.insertCall(call({ id: 'obc-link', verdict: 'violation', rule: 'gh-write', destination: 'github:other/repo' }))
    store.insertCall(call({ id: 'obc-other', verdict: 'allowed', rule: 'git-push', destination: 'github:origin' }))
    await send({ type: 'team-audit-open', teamPath: world.repo, requestId: 'rlink', filters: {}, callId: 'obc-link' })
    const page = last('team-audit-page')!
    expect(page.page.rows.map(row => row.id)).toEqual(['obc-link'])
    expect(page.appliedFilters).toEqual({ rule: 'gh-write', destination: 'github:other/repo' })
    expect(page.notice).toBeUndefined()
  })

  test('an unknown or other-team call id answers the default view with a notice, leaking nothing', async () => {
    store.insertCall(call({ id: 'obc-theirs', teamId: world.otherTeam.teamId, verdict: 'violation', rule: 'gh-write', destination: 'github:other/repo' }))
    store.insertCall(call({ id: 'obc-mine', verdict: 'allowed', rule: 'git-push', destination: 'github:origin' }))
    await send({ type: 'team-audit-open', teamPath: world.repo, requestId: 'rmiss', filters: {}, callId: 'obc-nope' })
    let page = last('team-audit-page')!
    expect(page.page.rows.map(row => row.id)).toEqual(['obc-mine'])
    expect(page.notice).toContain('obc-nope')
    expect(page.appliedFilters).toBeUndefined()
    await send({ type: 'team-audit-open', teamPath: world.repo, requestId: 'rforeign', filters: {}, callId: 'obc-theirs' })
    page = last('team-audit-page')!
    expect(page.notice).toContain('obc-theirs')
    // No fact of the foreign call (rule or destination) leaks.
    expect(JSON.stringify(page)).not.toContain('gh-write')
  })
})
