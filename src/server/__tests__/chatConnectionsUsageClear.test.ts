// The client-observable end of openrouter follow-up N3: a provider whose
// meters were just cleared (a zero-meter pull) must reach every sibling
// profile subscribed to it as one chat-usage message per profile carrying
// report: null — the bar is removed, never skipped (usage bar design D4,
// providers-and-workers 5.3). Harness copied slim from
// chatConnections.test.ts, which is far past 500 lines.
import { describe, expect, test } from 'bun:test'
import type { ServerMessage } from '../../shared/types'
import { ChatConnections } from '../chat/ChatConnections'
import type { ChatSessionManager } from '../chat/ChatSessionManager'

/** Sibling profiles of one provider: chat-4 → glm, chat-5 → glm-flash, both → zai. */
function fakeManager(): ChatSessionManager {
  return {
    isArchived: () => false,
    whenRestored: () => Promise.resolve(),
    loadHistory: async (_id: string) => {},
    start: (_id: string) => Promise.resolve({ ok: true } as const),
    has: (id: string) => id === 'chat-4' || id === 'chat-5',
    profileIdOf: (id: string) => (id === 'chat-4' ? 'glm' : 'glm-flash'),
    providerIdOf: () => 'zai',
    getSnapshot: (id: string) => ({ sessionId: id }),
  } as unknown as ChatSessionManager
}

describe('ChatConnections.publishUsage with a cleared provider (openrouter N3)', () => {
  test('a null report reaches every sibling profile of the provider, one message per profile id', async () => {
    const messages: ServerMessage[] = []
    const connection = { send: (message: ServerMessage) => messages.push(message) }
    const connections = new ChatConnections(fakeManager())
    await connections.handle(connection, { type: 'chat-attach', sessionId: 'chat-4' })
    await connections.handle(connection, { type: 'chat-attach', sessionId: 'chat-5' })
    messages.length = 0 // drop the attach snapshots

    connections.publishUsage('zai', null)
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(messages.filter(message => message.type === 'chat-usage')).toEqual([
      { type: 'chat-usage', profileId: 'glm', providerId: 'zai', report: null },
      { type: 'chat-usage', profileId: 'glm-flash', providerId: 'zai', report: null },
    ])
  })

  test('a provider nobody subscribed to publishes nothing', async () => {
    const messages: ServerMessage[] = []
    const connection = { send: (message: ServerMessage) => messages.push(message) }
    const connections = new ChatConnections(fakeManager())
    await connections.handle(connection, { type: 'chat-attach', sessionId: 'chat-4' })
    messages.length = 0

    connections.publishUsage('openrouter', null)
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(messages.filter(message => message.type === 'chat-usage')).toEqual([])
  })
})
