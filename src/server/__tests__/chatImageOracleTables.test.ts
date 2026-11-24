import { expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import { Hono } from 'hono'
import type { ServerMessage } from '../../shared/types'
import { SEND_ORACLES, UPLOAD_ORACLES, oracleRows } from '../../../tests/fixtures/chatImageOracles'
import { CHAT_IMAGE_RED_BASE64 } from '../../../tests/fixtures/chatImage'
import { ChatImageStore, imageDescriptor, type TrustedChatImage } from '../chat/images/ChatImageStore'
import { createChatImageRoutes } from '../routes/chatImages'
import { ChatConnections } from '../chat/ChatConnections'
import type { ChatSessionManager } from '../chat/ChatSessionManager'
import { createHarness } from './fixtures/chatDriverHarness'
import { Script, sentRequest, startHarness, until } from './codexDriverHarness'

const bytes = Buffer.from(CHAT_IMAGE_RED_BASE64, 'base64')
const image: TrustedChatImage = { ...imageDescriptor(bytes, 'image/png'), bytes, path: '/assets/original.png' }

for (const [id, category, result] of oracleRows(UPLOAD_ORACLES)) {
  test(`${id}: ${category} -> ${result}`, async () => {
    const dir = await fs.mkdtemp('/tmp/kawai-upload-table-')
    try {
      const store = new ChatImageStore(dir + '/images')
      if (id === 'U6') await fs.writeFile(store.dir, 'not a directory')
      const app = new Hono().route('/api/chat', createChatImageRoutes(store, { has: () => id !== 'U1', isArchived: () => id === 'U2' }))
      const form = new FormData()
      if (id !== 'U4') form.append('image', new Blob([id === 'U3' ? Buffer.alloc(6 * 1024 * 1024) : bytes], { type: id === 'U5' ? 'image/jpeg' : 'image/png' }), id === 'U5' ? 'image.jpg' : 'image.png')
      const response = await app.request('/api/chat/a/images', { method: 'POST', body: form })
      const status: Record<string, number> = { U1: 404, U2: 409, U3: 413, U4: 400, U5: 415, U6: 500, U7: 200 }
      expect(response.status).toBe(status[id])
      expect(response.headers.get('Content-Type')).toContain('application/json')
      const payload = await response.json()
      if (id !== 'U7') { expect(payload.error).toBeString(); expect(payload.image).toBeUndefined() }
      else {
        expect(payload.image).toEqual(imageDescriptor(bytes, 'image/png'))
        const loaded = await app.request(`/api/chat/a/images/${payload.image.id}`)
        expect(Buffer.from(await loaded.arrayBuffer())).toEqual(bytes)
      }
    } finally { await fs.rm(dir, { recursive: true, force: true }) }
  })
}

for (const [id, category, result] of oracleRows(SEND_ORACLES)) {
  test(`${id}: ${category} -> ${result}`, async () => {
    if (id === 'S5' || id === 'S7') {
      const h = createHarness()
      try {
        h.driver.send(id === 'S7' ? 'text only' : '', id === 'S7' ? undefined : [image])
        await h.nextWrite()
      const prompt = h.prompts.at(-1)!
        if (id === 'S7') expect(prompt?.message.content).toBe('text only')
        else expect(prompt?.message.content).toEqual([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: CHAT_IMAGE_RED_BASE64 } }])
        const users = h.events.filter(e => e.type === 'user_message')
        expect(users).toHaveLength(1)
        expect(users[0].images?.length ?? 0).toBe(id === 'S7' ? 0 : 1)
      } finally { await h.cleanup() }
      return
    }
    if (id === 'S6') {
      const h = startHarness(new Script().boot().turn('image-table'))
      try {
        h.driver.send('', [image])
        await until(() => !!sentRequest(h, 'turn/start'))
        expect(sentRequest(h, 'turn/start')?.input).toEqual([{ type: 'localImage', path: image.path }])
        expect(h.events.filter(e => e.type === 'user_message')).toHaveLength(1)
      } finally { await h.cleanup() }
      return
    }
    let calls = 0
    const manager = { whenRestored: () => Promise.resolve(), has: () => id !== 'S1',
      send: async () => { calls++; return { ok: false, error: 'Driver refused before admission.' } },
    } as unknown as ChatSessionManager
    const answers: ServerMessage[] = []
    await new ChatConnections(manager).handle({ send: message => answers.push(message) }, {
      type: 'chat-send', sessionId: 'a', text: '', requestId: id === 'S0' ? undefined : id,
      images: id === 'S2' ? [{ id: '/private/image.png' }] : id === 'S3' ? [] : [image],
    })
    expect(answers).toHaveLength(1)
    expect(answers[0].type).toBe('error')
    if (id !== 'S0') expect(answers[0]).toMatchObject({ requestId: id, sessionId: 'a' })
    expect(calls).toBe(id === 'S4' ? 1 : 0)
  })
}
