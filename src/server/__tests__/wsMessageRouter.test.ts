// The WebSocket router forwards chat/team frames by an explicit case list
// (src/server/ws/messageRouter.ts); anything missing gets 'Unknown message
// type' in production while direct ChatConnections tests keep passing — the
// gap a threads-PR CI run caught. This drives the real router with a minimal
// context so every task-assignment client message provably reaches
// ChatConnections, and stays there.
import { describe, expect, test } from 'bun:test'
import type { ServerWebSocket } from 'bun'
import { handleMessage, type MessageRouterContext } from '../ws/messageRouter'
import type { ChatConnection, ChatConnections } from '../chat/ChatConnections'
import type { ClientMessage } from '../../shared/types'
import type { WSData } from '../ws/wsTypes'

const forwarded: ClientMessage[] = []
const sent: Array<{ type: string; message?: string }> = []

const context = {
  hub: { send: (_ws: unknown, message: { type: string; message?: string }) => { sent.push(message) } },
  chatPeer: () => ({ send: () => {} }) as unknown as ChatConnection,
  chatConnections: {
    handle: async (_connection: ChatConnection, message: ClientMessage) => { forwarded.push(message) },
  } as unknown as ChatConnections,
} as unknown as MessageRouterContext

const ws = {} as ServerWebSocket<WSData>

const deliver = (message: ClientMessage) => handleMessage(context, ws, JSON.stringify(message))

describe('messageRouter task-assignment forwarding', () => {
  test('every assignment client message reaches ChatConnections, never the unknown-type error', async () => {
    const assign: ClientMessage = {
      type: 'team-task-assign', sessionId: 'dev', requestId: 'r1', taskId: 'task-1',
      target: { kind: 'group', id: 'devs' }, instruction: 'Go', requestKey: 'k1',
    }
    const preview: ClientMessage = {
      type: 'team-task-preview', sessionId: 'dev', requestId: 'r2', target: { kind: 'group', id: 'devs' },
    }
    const targets: ClientMessage = { type: 'team-task-targets', sessionId: 'dev', requestId: 'r3' }
    const create: ClientMessage = {
      type: 'team-task-create', sessionId: 'dev', requestId: 'r4', title: 'T', direction: 'D', requestKey: 'k2',
    }
    deliver(assign)
    deliver(preview)
    deliver(targets)
    deliver(create)
    await Promise.resolve()
    expect(forwarded.map(message => message.type)).toEqual([
      'team-task-assign', 'team-task-preview', 'team-task-targets', 'team-task-create',
    ])
    expect(forwarded[0]).toMatchObject(assign)
    expect(sent.filter(message => message.type === 'error')).toEqual([])
  })

  test('an unknown type still errors instead of forwarding', async () => {
    deliver({ type: 'team-task-nonsense', sessionId: 'dev' } as unknown as ClientMessage)
    await Promise.resolve()
    expect(forwarded.map(message => message.type)).not.toContain('team-task-nonsense')
    expect(sent.at(-1)).toMatchObject({ type: 'error', message: 'Unknown message type' })
  })
})
