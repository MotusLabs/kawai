// The Audit subscriptions' guards (execution-safety-recovery D9; task rev 2),
// over a recording service and a resolver each test releases by hand: a
// close cancels a slow open and a slow more, a newer open supersedes an older
// one still resolving, and every filter field — plus a more's cursor —
// reaches the service exactly as sent; a disconnect ends the pushes; an
// acknowledge passes its note and refuses an unknown team. Each assertion is
// exact.
import { describe, expect, test } from 'bun:test'
import type { ChatSessionManager } from '../chat/ChatSessionManager'
import type { ChatConnection } from '../chat/ChatConnections'
import { OutboundConnections } from '../outbound/outboundConnections'
import type { TeamIdentity } from '../team/teamIdentity'
import type { OutboundAuditFilters } from '../../shared/outbound'
import type { ServerMessage } from '../../shared/types'
import { unknownTeamError } from '../../shared/team'

const TEAM = { teamId: '/repo/.git' } as TeamIdentity

function harness(options: { known?: boolean } = {}) {
  const gates: Array<() => void> = []
  const pages: Array<{ filters: OutboundAuditFilters; cursor?: string }> = []
  const acks: unknown[] = []
  const sent: ServerMessage[] = []
  const manager = {
    teamScopes: {
      resolve: () => options.known === false
        ? Promise.resolve(undefined)
        : new Promise<TeamIdentity>(resolve => { gates.push(() => resolve(TEAM)) }),
    },
    outboundAudit: {
      acknowledge: (_caller: unknown, input: unknown) => { acks.push(input); return { ok: true, replayed: false } },
      page: (_teamId: string, filters: OutboundAuditFilters, cursor?: string) => {
        pages.push({ filters, ...(cursor !== undefined ? { cursor } : {}) })
        return { rows: [], cursor: null }
      },
      callGroup: () => null,
    },
  } as unknown as ChatSessionManager
  const connections = new OutboundConnections(manager)
  const connection = { send: (message: ServerMessage) => sent.push(message) } as unknown as ChatConnection
  const handle = (message: Parameters<OutboundConnections['handle']>[1]) => connections.handle(connection, message)
  const answered = () => sent.filter(message => message.type === 'team-audit-page').map(message => (message as { requestId: string }).requestId)
  return { gates, pages, acks, sent, connections, connection, handle, answered }
}

describe('pending tokens', () => {
  test('a close cancels a slow open: it answers nothing', async () => {
    const h = harness()
    const open = h.handle({ type: 'team-audit-open', teamPath: '/repo', requestId: 'r1', filters: {} })
    await h.handle({ type: 'team-audit-close', teamPath: '/repo' })
    h.gates[0]!()
    await open
    expect(h.answered()).toEqual([])
  })

  test('a close cancels a slow more: it answers nothing', async () => {
    const h = harness()
    const more = h.handle({ type: 'team-audit-more', teamPath: '/repo', requestId: 'm1', filters: {}, cursor: 'c1' })
    await h.handle({ type: 'team-audit-close', teamPath: '/repo' })
    h.gates[0]!()
    await more
    expect(h.answered()).toEqual([])
  })

  test('a newer open supersedes an older one still resolving', async () => {
    const h = harness()
    const first = h.handle({ type: 'team-audit-open', teamPath: '/repo', requestId: 'r1', filters: {} })
    const second = h.handle({ type: 'team-audit-open', teamPath: '/repo', requestId: 'r2', filters: {} })
    h.gates[1]!()
    await second
    h.gates[0]!()
    await first
    expect(h.answered()).toEqual(['r2'])
  })
})

test('every filter field and the cursor reach the service as sent', async () => {
  const h = harness()
  const filters: OutboundAuditFilters = {
    verdict: 'violation', rule: 'gh-write', destination: 'github:other/repo', sessionId: 'chat-9',
    from: '2026-01-01T00:00:00.000Z', to: '2026-01-02T00:00:00.000Z',
  }
  const open = h.handle({ type: 'team-audit-open', teamPath: '/repo', requestId: 'r1', filters })
  h.gates[0]!()
  await open
  const more = h.handle({ type: 'team-audit-more', teamPath: '/repo', requestId: 'm1', filters, cursor: 'c1' })
  h.gates[1]!()
  await more
  expect(h.pages).toEqual([{ filters }, { filters, cursor: 'c1' }])
})

test('a disconnect ends the pushes', async () => {
  const h = harness()
  const open = h.handle({ type: 'team-audit-open', teamPath: '/repo', requestId: 'r1', filters: {} })
  h.gates[0]!()
  await open
  h.connections.publish(TEAM.teamId)
  expect(h.sent.filter(message => message.type === 'team-audit-changed')).toHaveLength(1)
  h.connections.disconnect(h.connection)
  h.connections.publish(TEAM.teamId)
  expect(h.sent.filter(message => message.type === 'team-audit-changed')).toHaveLength(1)
})

describe('acknowledge', () => {
  test('the note reaches the service', async () => {
    const h = harness()
    const ack = h.handle({ type: 'team-audit-acknowledge', teamPath: '/repo', requestId: 'a1', callId: 'obc-1', commandId: 'cmd-1', note: 'seen' })
    h.gates[0]!()
    await ack
    expect(h.acks).toEqual([{ callId: 'obc-1', commandId: 'cmd-1', note: 'seen' }])
    expect(h.sent).toEqual([{ type: 'team-audit-result', teamPath: '/repo', requestId: 'a1' }])
  })

  test('an unknown team is refused and the service is never asked', async () => {
    const h = harness({ known: false })
    await h.handle({ type: 'team-audit-acknowledge', teamPath: '/nowhere', requestId: 'a1', callId: 'obc-1', commandId: 'cmd-1' })
    expect(h.acks).toEqual([])
    expect(h.sent).toEqual([{ type: 'team-audit-result', teamPath: '/nowhere', requestId: 'a1', error: unknownTeamError('/nowhere') }])
  })
})
