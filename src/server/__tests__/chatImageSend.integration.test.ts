import { afterEach, expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { ServerMessage } from '../../shared/types'
import { freshTestDatabase } from './helpers/testDatabase'
import { ChatSessionManager } from '../chat/ChatSessionManager'
import { ChatConnections } from '../chat/ChatConnections'
import { SessionRegistry } from '../SessionRegistry'
import { ChatImageStore } from '../chat/images/ChatImageStore'
import { fakeQueryFactory, type FakeHandle } from './helpers/chatSessionManagerHarness'
import { CHAT_IMAGE_RED_BASE64 } from '../../../tests/fixtures/chatImage'

let cleanup: (() => Promise<void>) | undefined
afterEach(async () => { await cleanup?.(); cleanup = undefined })

test('S0-S5/S7: production connection and manager validate whole image sends before emitting or enqueueing', async () => {
  const dir = await fs.mkdtemp('/tmp/kawai-image-send-')
  const db = freshTestDatabase(dir + '/db.sqlite')
  const store = new ChatImageStore(dir + '/images')
  const handles: FakeHandle[] = [], prompts: AsyncIterable<SDKUserMessage>[] = []
  const events: unknown[] = []
  const factory = fakeQueryFactory(handles)
  const manager = new ChatSessionManager({ db, registry: new SessionRegistry(), authCheck: () => true,
    isDirectory: () => true, profileCatalogHome: dir, imageStore: store,
    onEvent: (_id, event) => events.push(event),
    queryFactory: options => { prompts.push(options.prompt); return factory(options) },
    providerUsageFetch: (async () => { throw Error('No network in tests') }) as unknown as typeof fetch,
  })
  cleanup = async () => { manager.shutdown(); expect(await manager.retiredSettled()).toEqual([]); manager.dispatcher.close(); manager.observations.stop(); db.close(); await fs.rm(dir, { recursive: true, force: true }) }
  await manager.whenRestored()
  const created = manager.createSession({ projectPath: dir })
  if (!created.ok) throw Error(created.error)
  const id = created.session.id
  const image = await store.put(id, Buffer.from(CHAT_IMAGE_RED_BASE64, 'base64'), 'image/png')
  const connections = new ChatConnections(manager), answers: ServerMessage[] = []
  const peer = { send: (message: ServerMessage) => answers.push(message) }
  for (const [requestId, images] of [
    ['invalid', [{ id: '/etc/hosts' }]], ['too-many', Array(5).fill({ id: image.id })], ['empty', []],
  ] as const) {
    await connections.handle(peer, { type: 'chat-send', sessionId: id, text: '', requestId, images: [...images] })
    expect(answers.at(-1)).toMatchObject({ type: 'error', sessionId: id, requestId })
  }
  await connections.handle(peer, { type: 'chat-send', sessionId: id, text: '', images: [image] })
  expect(answers.at(-1)?.type).toBe('error')
  expect(prompts).toHaveLength(0)
  expect(events).toHaveLength(0)
  await connections.handle(peer, { type: 'chat-send', sessionId: id, text: '', requestId: 'good', images: [image, image] })
  expect(answers.at(-1)).toMatchObject({ type: 'chat-send-result', requestId: 'good' })
  const prompt = await prompts[0][Symbol.asyncIterator]().next()
  expect(prompt.value.message.content).toEqual([
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: CHAT_IMAGE_RED_BASE64 } },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: CHAT_IMAGE_RED_BASE64 } },
  ])
  const accepted = events.length
  manager.archive(id)
  await connections.handle(peer, { type: 'chat-send', sessionId: id, text: '', requestId: 'archived', images: [image] })
  expect(answers.at(-1)).toMatchObject({ type: 'error', requestId: 'archived' })
  expect(prompts).toHaveLength(1)
  expect(events.length).toBeGreaterThanOrEqual(accepted)
})
