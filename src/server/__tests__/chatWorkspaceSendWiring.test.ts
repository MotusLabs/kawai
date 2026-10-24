// The connection boundary of a contextual send (plan-workspace §4): the
// chat-send field passes through to manager.send whole, an absent field is
// an unscoped send, a malformed envelope refuses at the connection, a
// refusal echoes the error frame, and the type is registered in
// CHAT_CONNECTION_TYPES (the structural test). The Q2 describe covers the
// client-minted correlation id: every refusal of a send that carried a
// readable bounded requestId echoes it with the session id — malformed
// context, unknown session, manager refusal — while sends without one keep
// today's exact error shape. Harness slimmed from chatConnections.test.ts,
// which is far past 500 lines.
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

  test('an accepted send with requestId answers nothing', async () => {
    const calls: Array<{ sessionId: string; text: string; context: WorkspaceMessageEnvelope | undefined }> = []
    const messages: ServerMessage[] = []
    await new ChatConnections(fakeManager(calls)).handle(connection(messages), {
      type: 'chat-send', sessionId: 'chat-1', text: 'x', requestId: 'req-ok', workspaceContext: envelope,
    })
    expect(calls).toHaveLength(1)
    expect(messages).toEqual([])
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
