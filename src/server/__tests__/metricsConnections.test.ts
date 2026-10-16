// Metrics tab subscriptions (team-process-metrics 6.2): open answers with a
// snapshot through the shared read cache, refresh recomputes, close ends the
// subscription, an unknown team path is refused with no data, mail changes
// push nothing, a report/decision publish re-sends subscribers, and every new
// type is listed for the WS router.
import { expect, test } from 'bun:test'
import type { ChatSessionManager } from '../chat/ChatSessionManager'
import { ChatConnections } from '../chat/ChatConnections'
import { CHAT_CONNECTION_TYPES } from '../chat/chatConnectionTypes'
import { MetricsReader } from '../metrics/computeMetrics'
import type { ClientMessage, ServerMessage } from '../../shared/types'
import { END, Seed, TEAM } from './metricsSeed'

function setup() {
  const s = new Seed()
  s.task('t1', 3 * 24)
  s.status('t1', 'active', 'done', 24)
  let now = END
  const metrics = new MetricsReader(s.db, () => now)
  const teamScopes = { resolve: async (path: string) => (path === '/repo' || path === '/repo/.worktrees/x' ? { teamId: TEAM } : null) }
  const manager = { whenRestored: () => Promise.resolve(), teamScopes, metrics } as unknown as ChatSessionManager
  const connections = new ChatConnections(manager)
  const messages: ServerMessage[] = []
  const connection = { send: (message: ServerMessage) => messages.push(message) }
  const send = (message: ClientMessage) => connections.handle(connection, message)
  const snapshots = () => messages.filter((m): m is Extract<ServerMessage, { type: 'process-metrics-snapshot' }> => m.type === 'process-metrics-snapshot')
  const leadN = (m: Extract<ServerMessage, { type: 'process-metrics-snapshot' }>) => m.metrics.metrics.find(v => v.id === 'lead_time_p50')!.n
  return { s, connections, messages, send, snapshots, leadN, tick: (ms: number) => { now += ms } }
}

test('open answers with a snapshot; refresh recomputes; close ends publishes', async () => {
  const { s, connections, send, snapshots, leadN, tick } = setup()
  await send({ type: 'process-metrics-open', teamPath: '/repo', window: '7d', slice: { kind: 'group' } })
  const [first] = snapshots()
  expect(first).toMatchObject({ teamPath: '/repo', teamId: TEAM, window: '7d', slice: { kind: 'group' }, computedAt: new Date(END).toISOString() })
  expect(leadN(first!)).toBe(1)

  s.task('t2', 3 * 24)
  s.status('t2', 'active', 'done', 12)
  tick(1000)
  // A second open within 30 s shares the cached read; refresh recomputes.
  await send({ type: 'process-metrics-open', teamPath: '/repo', window: '7d', slice: { kind: 'group' } })
  expect(leadN(snapshots()[1]!)).toBe(1)
  await send({ type: 'process-metrics-refresh', teamPath: '/repo', window: '7d', slice: { kind: 'group' } })
  expect(leadN(snapshots()[2]!)).toBe(2)
  expect(snapshots()[2]!.computedAt).toBe(new Date(END + 1000).toISOString())

  connections.publishMetrics(TEAM)
  expect(snapshots()).toHaveLength(4)
  connections.publishMetrics('/other/.git')
  expect(snapshots()).toHaveLength(4)
  await send({ type: 'process-metrics-close', teamPath: '/repo' })
  connections.publishMetrics(TEAM)
  expect(snapshots()).toHaveLength(4)
  s.db.close()
})

test('an unknown team path or window is refused with no data', async () => {
  const { s, messages, send, snapshots } = setup()
  await send({ type: 'process-metrics-open', teamPath: '/nowhere', window: '7d', slice: null })
  await send({ type: 'process-metrics-open', teamPath: '/repo', window: '30d' as '7d', slice: null })
  await send({ type: 'process-metrics-open', teamPath: '/repo', window: '7d', slice: { kind: 'model' } as unknown as null })
  expect(snapshots()).toEqual([])
  expect(messages.map(m => m.type === 'error' && m.message)).toEqual([
    expect.stringContaining('/nowhere'), 'Unknown metrics window: 30d', expect.stringContaining('Unknown slice kind'),
  ])
  s.db.close()
})

test('mail and task changes push nothing; only open, refresh, and publish send', async () => {
  const { s, connections, send, snapshots } = setup()
  await send({ type: 'process-metrics-open', teamPath: '/repo/.worktrees/x', window: '1d', slice: null })
  s.message({ createdHoursAgo: 1, deliveredHoursAgo: 0.5 })
  connections.publishTasks(TEAM)
  connections.publishWorkspace(TEAM)
  expect(snapshots()).toHaveLength(1)
  s.db.close()
})

test('the metrics types are listed for the WS router', () => {
  for (const type of ['process-metrics-open', 'process-metrics-close', 'process-metrics-refresh']) {
    expect(CHAT_CONNECTION_TYPES as readonly string[]).toContain(type)
  }
})
