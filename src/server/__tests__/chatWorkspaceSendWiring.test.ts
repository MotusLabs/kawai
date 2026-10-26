// The connection boundary of a contextual send (plan-workspace §4): the
// chat-send field passes through to manager.send whole, an absent field is
// an unscoped send, a malformed envelope refuses at the connection, a
// refusal echoes the error frame, and the type is registered in
// CHAT_CONNECTION_TYPES (the structural test). The Q2 describe covers the
// client-minted correlation id: every refusal of a send that carried a
// readable bounded requestId echoes it with the session id — malformed
// context, unknown session, manager refusal — while sends without one keep
// today's exact error shape. The B1 describe covers the sender-only
// acceptance answer: an accepted send with a readable requestId gets exactly
// one `chat-send-result` on the sending connection, after the manager
// accepted, never beside a refusal. Harness slimmed from
// chatConnections.test.ts, which is far past 500 lines.
import { describe, expect, test } from 'bun:test'
import type { ServerMessage } from '../../shared/types'
import type { WorkspaceMessageEnvelope } from '../../shared/planWorkspace'
import { CHAT_CONNECTION_TYPES } from '../chat/chatConnectionTypes'
import { ChatConnections } from '../chat/ChatConnections'
import type { ChatSessionManager } from '../chat/ChatSessionManager'

const envelope: WorkspaceMessageEnvelope = {
  teamId: '/repo/example/main',
  planId: 'plan-1',
  version: { kind: 'revision', revision: 2, contentHash: 'a'.repeat(64) },
}

function fakeManager(
  calls: Array<{ sessionId: string; text: string; context: WorkspaceMessageEnvelope | undefined }>,
  result: { ok: boolean; error?: string; has?: boolean } = { ok: true },
): ChatSessionManager {
  return {
    whenRestored: () => Promise.resolve(),
    has: () => result.has ?? true,
    send: async (sessionId: string, text: string, context?: WorkspaceMessageEnvelope) => {
      calls.push({ sessionId, text, context })
      return result.ok ? { ok: true as const } : { ok: false as const, error: result.error ?? 'refused' }
    },
  } as unknown as ChatSessionManager
}

const connection = (messages: ServerMessage[]) => ({ send: (message: ServerMessage) => messages.push(message) })

describe('chatWorkspaceSendWiring', () => {
  test('a chat-send with a workspaceContext passes the envelope through to manager.send', async () => {
    const calls: Array<{ sessionId: string; text: string; context: WorkspaceMessageEnvelope | undefined }> = []
    const messages: ServerMessage[] = []
    const connections = new ChatConnections(fakeManager(calls))
    await connections.handle(connection(messages), {
      type: 'chat-send', sessionId: 'chat-1', text: 'Ship the checklist', workspaceContext: envelope,
    })
    expect(calls).toEqual([{ sessionId: 'chat-1', text: 'Ship the checklist', context: envelope }])
    expect(messages).toEqual([])
  })

  test('a chat-send without a workspaceContext sends unscoped', async () => {
    const calls: Array<{ sessionId: string; text: string; context: WorkspaceMessageEnvelope | undefined }> = []
    const connections = new ChatConnections(fakeManager(calls))
    await connections.handle(connection([]), { type: 'chat-send', sessionId: 'chat-1', text: 'Hello there' })
    expect(calls).toEqual([{ sessionId: 'chat-1', text: 'Hello there', context: undefined }])
  })

  test('a malformed workspaceContext refuses at the connection and reaches nothing', async () => {
    const calls: Array<{ sessionId: string; text: string; context: WorkspaceMessageEnvelope | undefined }> = []
    const messages: ServerMessage[] = []
    const connections = new ChatConnections(fakeManager(calls))
    await connections.handle(connection(messages), {
      type: 'chat-send', sessionId: 'chat-1', text: 'Hello there',
      // Deliberately malformed on the wire, so the type cast is the point.
      workspaceContext: { teamId: '/repo/example/main', version: { kind: 'revision' } } as unknown as WorkspaceMessageEnvelope,
    })
    expect(calls).toEqual([])
    expect(messages).toEqual([
      { type: 'error', message: "The message's plan context is malformed; nothing was sent." },
    ])
  })

  test('a refusal from the manager echoes the error frame', async () => {
    const calls: Array<{ sessionId: string; text: string; context: WorkspaceMessageEnvelope | undefined }> = []
    const messages: ServerMessage[] = []
    const connections = new ChatConnections(fakeManager(calls, { ok: false, error: 'Plan not found in this repository: plan-1' }))
    await connections.handle(connection(messages), {
      type: 'chat-send', sessionId: 'chat-1', text: 'Ship the checklist', workspaceContext: envelope,
    })
    expect(calls).toHaveLength(1)
    expect(messages).toEqual([{ type: 'error', message: 'Plan not found in this repository: plan-1' }])
  })

  test('chat-send is registered in CHAT_CONNECTION_TYPES', () => {
    expect(CHAT_CONNECTION_TYPES).toContain('chat-send')
  })
})

describe('chatWorkspaceSendWiring: the client-minted correlation (§6.3, Q2)', () => {
  test('every refusal of a send carrying requestId echoes it with the session id', async () => {
    // Malformed context refusal.
    const malformed: ServerMessage[] = []
    await new ChatConnections(fakeManager([])).handle(connection(malformed), {
      type: 'chat-send', sessionId: 'chat-1', text: 'x', requestId: 'req-1',
      workspaceContext: { teamId: '/repo/example/main', version: { kind: 'revision' } } as unknown as WorkspaceMessageEnvelope,
    })
    expect(malformed).toEqual([{
      type: 'error',
      message: "The message's plan context is malformed; nothing was sent.",
      requestId: 'req-1', sessionId: 'chat-1',
    }])
    // Manager refusal (stale hash, wrong team, …) echoes the same pair.
    const refused: ServerMessage[] = []
    await new ChatConnections(fakeManager([], { ok: false, error: 'stale' })).handle(connection(refused), {
      type: 'chat-send', sessionId: 'chat-1', text: 'x', requestId: 'req-2', workspaceContext: envelope,
    })
    expect(refused).toEqual([{ type: 'error', message: 'stale', requestId: 'req-2', sessionId: 'chat-1' }])
    // Unknown session: the guard refusal correlates too.
    const unknown: ServerMessage[] = []
    await new ChatConnections(fakeManager([], { ok: true, has: false })).handle(connection(unknown), {
      type: 'chat-send', sessionId: 'gone', text: 'x', requestId: 'req-3', workspaceContext: envelope,
    })
    expect(unknown).toEqual([{
      type: 'error', message: 'Unknown chat session gone', requestId: 'req-3', sessionId: 'gone',
    }])
  })

  test('an accepted send with requestId answers exactly one chat-send-result, on the sending connection only', async () => {
    const order: string[] = []
    const calls: Array<{ sessionId: string; text: string; context: WorkspaceMessageEnvelope | undefined }> = []
    const manager = {
      whenRestored: () => Promise.resolve(),
      has: () => true,
      send: async (sessionId: string, text: string, context?: WorkspaceMessageEnvelope) => {
        order.push('manager-accepted')
        calls.push({ sessionId, text, context })
        return { ok: true as const }
      },
    } as unknown as ChatSessionManager
    const messages: ServerMessage[] = []
    await new ChatConnections(manager).handle(connection(messages), {
      type: 'chat-send', sessionId: 'chat-1', text: 'x', requestId: 'req-ok', workspaceContext: envelope,
    })
    // The acceptance follows the manager's accept — it is the terminal
    // answer, past the last refusal point — exactly once, shaped accepted.
    // The handler's only send target is the sending `connection` (the
    // `messages` array): no broadcast path exists in the answer at all.
    expect(order).toEqual(['manager-accepted'])
    expect(messages).toEqual([
      { type: 'chat-send-result', sessionId: 'chat-1', requestId: 'req-ok', accepted: true },
    ])
  })

  test('a refused send never gains the acceptance answer (the answers are exclusive)', async () => {
    const messages: ServerMessage[] = []
    await new ChatConnections(fakeManager([], { ok: false, error: 'stale hash' })).handle(connection(messages), {
      type: 'chat-send', sessionId: 'chat-1', text: 'x', requestId: 'req-no', workspaceContext: envelope,
    })
    expect(messages).toEqual([{ type: 'error', message: 'stale hash', requestId: 'req-no', sessionId: 'chat-1' }])
  })

  test('a requestId that is not readable and bounded keeps the legacy shape; the boundary is inclusive', async () => {
    const legacy = async (requestId: unknown): Promise<ServerMessage[]> => {
      const messages: ServerMessage[] = []
      await new ChatConnections(fakeManager([])).handle(connection(messages), {
        type: 'chat-send', sessionId: 'chat-1', text: 'x',
        ...(requestId !== undefined ? { requestId } : {}),
        workspaceContext: { teamId: '/repo/example/main', version: { kind: 'revision' } } as unknown as WorkspaceMessageEnvelope,
      } as Parameters<ChatConnections['handle']>[1])
      return messages
    }
    // Absent, non-string, empty, and over the bound: today's exact shape.
    for (const requestId of [undefined, 42, '', 'r'.repeat(201)]) {
      expect(await legacy(requestId)).toEqual([
        { type: 'error', message: "The message's plan context is malformed; nothing was sent." },
      ])
    }
    // Exactly at the bound it is still a correlation id.
    expect(await legacy('r'.repeat(200))).toEqual([{
      type: 'error', message: "The message's plan context is malformed; nothing was sent.",
      requestId: 'r'.repeat(200), sessionId: 'chat-1',
    }])
  })

  test('a non-chat-send message type never gains a correlation echo', async () => {
    const calls: Array<{ sessionId: string; text: string; context: WorkspaceMessageEnvelope | undefined }> = []
    const messages: ServerMessage[] = []
    // The same unknown-session guard that echoes a chat-send's requestId
    // answers every other chat message in the legacy shape.
    await new ChatConnections(fakeManager(calls, { ok: true, has: false })).handle(connection(messages), {
      type: 'chat-interrupt', sessionId: 'gone',
    } as Parameters<ChatConnections['handle']>[1])
    expect(messages).toEqual([{ type: 'error', message: 'Unknown chat session gone' }])
  })
})

describe('chatWorkspaceSendWiring: a throwing manager.send still answers (F-C1)', () => {
  const explodingManager = () => ({
    whenRestored: () => Promise.resolve(),
    has: () => true,
    send: async () => { throw new Error('driver exploded') },
  }) as unknown as ChatSessionManager

  test('a send carrying requestId gets exactly one correlated error, no acceptance, and the throw propagates', async () => {
    const messages: ServerMessage[] = []
    let thrown: unknown
    try {
      await new ChatConnections(explodingManager()).handle(connection(messages), {
        type: 'chat-send', sessionId: 'chat-1', text: 'x', requestId: 'req-boom', workspaceContext: envelope,
      })
    } catch (cause) { thrown = cause }
    // The client learns the send did not land — the correlated refusal is the
    // terminal answer, so a pending send never waits forever on an exception
    // boundary, and it arrives before the rethrow (never post-acceptance).
    expect(messages).toEqual([{
      type: 'error',
      message: 'The chat could not accept the message: driver exploded',
      requestId: 'req-boom', sessionId: 'chat-1',
    }])
    expect((thrown as Error)?.message).toBe('driver exploded')
  })

  test('a throw in a send without requestId keeps the frame-less shape, throw still propagates', async () => {
    const messages: ServerMessage[] = []
    let thrown: unknown
    try {
      await new ChatConnections(explodingManager()).handle(connection(messages), {
        type: 'chat-send', sessionId: 'chat-1', text: 'x',
      })
    } catch (cause) { thrown = cause }
    // Today's exact behavior for uncorrelated sends: no frame, the error logs.
    expect(messages).toEqual([])
    expect((thrown as Error)?.message).toBe('driver exploded')
  })

  test('a socket failure delivering the acceptance never reads as a refusal', async () => {
    const frames: ServerMessage[] = []
    const failingConnection = {
      send: (message: ServerMessage) => {
        if (message.type === 'chat-send-result') throw new Error('socket gone')
        frames.push(message)
      },
    }
    const acceptedManager = {
      whenRestored: () => Promise.resolve(),
      has: () => true,
      send: async () => ({ ok: true as const }),
    } as unknown as ChatSessionManager
    let thrown: unknown
    try {
      await new ChatConnections(acceptedManager).handle(failingConnection, {
        type: 'chat-send', sessionId: 'chat-1', text: 'x', requestId: 'req-dead', workspaceContext: envelope,
      })
    } catch (cause) { thrown = cause }
    // The manager accepted, so the dead acceptance send must not convert
    // into a correlated refusal of an accepted send (no post-acceptance
    // error, F-C1); the throw surfaces to the router's logging as-is.
    expect(frames).toEqual([])
    expect((thrown as Error)?.message).toBe('socket gone')
  })
})
