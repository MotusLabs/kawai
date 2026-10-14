// Structural guard on the WS router's forwarding: every client message type
// ChatConnections handles must reach it, and none may answer "Unknown message
// type". The types this missed before — the Messages feed, product strategy's
// actions, chat-dismiss-notification — were covered only by tests that call
// ChatConnections directly, so they never saw the router that actually sits in
// front of it.
import { describe, expect, test } from 'bun:test'
import type { ServerWebSocket } from 'bun'
import {
  CHAT_CONNECTION_TYPES,
  isChatConnectionMessage,
  type ChatConnectionMessage,
} from '../chat/chatConnectionTypes'
import { handleMessage, type MessageRouterContext } from '../ws/messageRouter'
import type { ClientMessage, ServerMessage } from '../../shared/types'

interface Harness {
  handled: ChatConnectionMessage[]
  sent: ServerMessage[]
  route: (raw: string) => void
}

/**
 * A MessageRouterContext whose only real collaborator is the chat forward.
 * The chat family never touches the other deps, so they stay empty stubs.
 */
function harness(): Harness {
  const handled: ChatConnectionMessage[] = []
  const sent: ServerMessage[] = []
  const ws = {} as ServerWebSocket<never>
  const chatConnections = {
    handle: async (_connection: unknown, message: ClientMessage) => {
      handled.push(message as ChatConnectionMessage)
    },
  }
  const ctx = {
    hub: { send: (_ws: unknown, message: ServerMessage) => { sent.push(message) } },
    registry: {},
    sessionManager: {},
    refresh: {},
    chatSessionManager: {},
    chatConnections,
    chatPeer: () => ({ send: () => {} }),
    remote: {},
    workspaceCoordinator: {},
    sessionOps: {},
    terminal: {},
    copyMode: {},
  } as unknown as MessageRouterContext
  return {
    handled,
    sent,
    route: (raw) => handleMessage(ctx, ws as ServerWebSocket<never>, raw),
  }
}

/** Minimal frame per type: the router forwards the chat family by type alone. */
const frame = (type: ChatConnectionMessage['type']): string =>
  JSON.stringify({ type, sessionId: 'chat-1', requestId: 'r-1', threadId: 't-1', messageId: 'm-1', key: 'k', workerId: 'w', taskId: 'task-1', revision: 1, contentHash: 'h', commandId: 'c', body: 'b' })

describe('WS router forwards every ChatConnections type', () => {
  test('each handled type reaches ChatConnections and never "Unknown message type"', () => {
    for (const type of CHAT_CONNECTION_TYPES) {
      const h = harness()
      h.route(frame(type))
      expect(h.handled.map((m) => m.type)).toEqual([type])
      expect(h.sent).toEqual([])
    }
  })

  test('a stale tab\'s retired team-task-amend gets "Unknown message type"; its replacements are forwarded (task-revision-publication)', () => {
    const h = harness()
    h.route(JSON.stringify({ type: 'team-task-amend', teamPath: '/repo', requestId: 'r', taskId: 'task-1', direction: 'x' }))
    expect(h.handled).toEqual([])
    expect(h.sent).toEqual([{ type: 'error', message: 'Unknown message type' }])
    expect(CHAT_CONNECTION_TYPES).toEqual(expect.arrayContaining(['team-task-draft', 'team-task-publish', 'team-task-notify']))
    expect(CHAT_CONNECTION_TYPES).not.toContain('team-task-amend' as never)
  })

  test('an unlisted type still answers "Unknown message type"', () => {
    const h = harness()
    h.route(JSON.stringify({ type: 'not-a-real-message' }))
    expect(h.handled).toEqual([])
    expect(h.sent).toEqual([{ type: 'error', message: 'Unknown message type' }])
  })
})

describe('the handled set matches ChatConnections dispatch', () => {
  test('isChatConnectionMessage accepts exactly the listed types', () => {
    for (const type of CHAT_CONNECTION_TYPES) {
      expect(isChatConnectionMessage({ type } as ClientMessage)).toBe(true)
    }
    expect(isChatConnectionMessage({ type: 'ping' } as ClientMessage)).toBe(false)
    expect(isChatConnectionMessage({ type: 'session-refresh' } as ClientMessage)).toBe(false)
    expect(isChatConnectionMessage({ type: 'workspace-refresh' } as ClientMessage)).toBe(false)
    expect(isChatConnectionMessage({ type: 'terminal-attach' } as ClientMessage)).toBe(false)
  })

  // The eleven types the router used to drop, named so a regression that
  // removes one of them from the list fails here as well as at compile time.
  test('the previously unforwarded types are all listed', () => {
    const previouslyDropped = [
      'team-messages-open', 'team-messages-close', 'team-thread-open',
      'team-thread-close', 'team-message-send',
      'strategy-open', 'strategy-close', 'strategy-save-draft',
      'strategy-submit', 'strategy-approve', 'strategy-withdraw',
      'chat-dismiss-notification',
    ] as const
    for (const type of previouslyDropped) {
      expect(CHAT_CONNECTION_TYPES).toContain(type)
      expect(isChatConnectionMessage({ type } as ClientMessage)).toBe(true)
    }
  })
})
