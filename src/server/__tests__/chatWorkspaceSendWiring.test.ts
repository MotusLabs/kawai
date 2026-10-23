// The connection boundary of a contextual send (plan-workspace §4): the
// chat-send field passes through to manager.send whole, an absent field is
// an unscoped send, a malformed envelope refuses at the connection, a
// refusal echoes the error frame, and the type is registered in
// CHAT_CONNECTION_TYPES (the structural test). Harness slimmed from
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

function fakeManager(calls: Array<{ sessionId: string; text: string; context: WorkspaceMessageEnvelope | undefined }>, result: { ok: boolean; error?: string } = { ok: true }): ChatSessionManager {
  return {
    whenRestored: () => Promise.resolve(),
    has: () => true,
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
