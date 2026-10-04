import { describe, expect, test } from 'bun:test'
import type { ChatEvent } from '../../shared/chat'
import type { ServerMessage } from '../../shared/types'
import { ChatConnections } from '../chat/ChatConnections'
import type { ChatSessionManager } from '../chat/ChatSessionManager'

function harness() {
  const calls: unknown[] = []
  const snapshot: Extract<ServerMessage, { type: 'chat-snapshot' }> = {
    type: 'chat-snapshot', sessionId: 'chat-1', events: [],
    pendingRequests: [{ kind: 'approval', requestId: 'approval-1', tool: 'Bash', input: {}, at: 'now' }],
    status: 'permission', throughSequence: 0,
  }
  let pending = true
  const manager = {
    has: (id: string) => id === 'chat-1',
    getSnapshot: () => snapshot,
    send: async (...args: unknown[]) => { calls.push(['send', ...args]); return { ok: true } },
    interrupt: (...args: unknown[]) => { calls.push(['interrupt', ...args]); return { ok: true } },
    resolveApproval: (...args: unknown[]) => {
      calls.push(['approval', ...args])
      if (!pending) return { ok: false, error: 'Already resolved' }
      pending = false
      connections.publish('chat-1', { id: 'resolved', sequence: 3, at: 'now', type: 'request_resolved', requestId: 'approval-1', outcome: 'allowed' })
      return { ok: true }
    },
    answerQuestion: (...args: unknown[]) => { calls.push(['answer', ...args]); return { ok: true } },
  } as unknown as ChatSessionManager
  const connections = new ChatConnections(manager)
  const messages: ServerMessage[] = []
  const connection = { send: (message: ServerMessage) => messages.push(message) }
  return { connections, connection, messages, calls, snapshot }
}

const delta = (sequence: number, turnId = 'turn-1'): ChatEvent => ({
  type: 'assistant_delta', id: `event-${sequence}`, sequence, at: 'now', turnId, messageId: 'message-1', delta: `${sequence}`,
})

describe('chat WebSocket subscriptions', () => {
  test('routes send, interrupt, approval, and question answers', async () => {
    const h = harness()
    await h.connections.handle(h.connection, { type: 'chat-send', sessionId: 'chat-1', text: 'hello' })
    await h.connections.handle(h.connection, { type: 'chat-interrupt', sessionId: 'chat-1' })
    await h.connections.handle(h.connection, { type: 'chat-answer', sessionId: 'chat-1', requestId: 'question-1', answers: {} })
    await h.connections.handle(h.connection, { type: 'chat-approval', sessionId: 'chat-1', requestId: 'approval-1', decision: 'allow' })
    expect(h.calls).toEqual([
      ['send', 'chat-1', 'hello'], ['interrupt', 'chat-1'], ['answer', 'chat-1', 'question-1', {}], ['approval', 'chat-1', 'approval-1', 'allow'],
    ])
  })

  test('snapshot precedes coalesced live events and contains pending approval', async () => {
    const h = harness()
    await h.connections.handle(h.connection, { type: 'chat-attach', sessionId: 'chat-1' })
    h.connections.publish('chat-1', delta(1))
    h.connections.publish('chat-1', delta(2))
    expect(h.messages).toEqual([h.snapshot])
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(h.messages[1]).toEqual({ type: 'chat-events', sessionId: 'chat-1', events: [delta(1), delta(2)] })
  })

  test('deltas from different turns remain in different batches', async () => {
    const h = harness()
    await h.connections.handle(h.connection, { type: 'chat-attach', sessionId: 'chat-1' })
    h.connections.publish('chat-1', delta(1))
    h.connections.publish('chat-1', delta(2, 'turn-2'))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(h.messages.slice(1)).toEqual([
      { type: 'chat-events', sessionId: 'chat-1', events: [delta(1)] },
      { type: 'chat-events', sessionId: 'chat-1', events: [delta(2, 'turn-2')] },
    ])
  })

  test('detach and disconnect discard buffered output', async () => {
    const h = harness()
    await h.connections.handle(h.connection, { type: 'chat-attach', sessionId: 'chat-1' })
    h.connections.publish('chat-1', delta(1))
    await h.connections.handle(h.connection, { type: 'chat-detach', sessionId: 'chat-1' })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(h.messages).toHaveLength(1)
    await h.connections.handle(h.connection, { type: 'chat-attach', sessionId: 'chat-1' })
    h.connections.publish('chat-1', delta(2))
    h.connections.disconnect(h.connection)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(h.messages).toHaveLength(2)
  })

  test('only the first approval succeeds and both browsers receive its resolution', async () => {
    const h = harness()
    const secondMessages: ServerMessage[] = []
    const second = { send: (message: ServerMessage) => secondMessages.push(message) }
    await h.connections.handle(h.connection, { type: 'chat-attach', sessionId: 'chat-1' })
    await h.connections.handle(second, { type: 'chat-attach', sessionId: 'chat-1' })
    const answer = { type: 'chat-approval', sessionId: 'chat-1', requestId: 'approval-1', decision: 'allow' } as const
    await h.connections.handle(h.connection, answer)
    await h.connections.handle(second, answer)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(h.messages.some(message => message.type === 'chat-events')).toBe(true)
    expect(secondMessages.some(message => message.type === 'chat-events')).toBe(true)
    expect(secondMessages).toContainEqual({ type: 'error', message: 'Already resolved' })
  })

  test('unknown sessions return an actionable error', async () => {
    const h = harness()
    await h.connections.handle(h.connection, { type: 'chat-send', sessionId: 'missing', text: 'hello' })
    expect(h.messages).toEqual([{ type: 'error', message: 'Unknown chat session missing' }])
    expect(h.calls).toEqual([])
  })
})
