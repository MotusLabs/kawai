import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import { Hono } from 'hono'
import { CHAT_IMAGE_RED_BASE64 } from '../../../tests/fixtures/chatImage'
import { createHarness } from './fixtures/chatDriverHarness'
import { codexDriver } from '../../../packages/agent-runtime/__tests__/helpers/codexDriverHarness'
import { openSync, readSync, fstatSync, closeSync } from 'node:fs'
import { propertyCases } from './helpers/propertyCases'
import { ChatImageStore, type TrustedChatImage } from '../chat/images/ChatImageStore'
import { createChatImageRoutes } from '../routes/chatImages'
import { parseTranscriptContent } from '../chat/transcriptReplay'
import { parseCodexRollout } from '../chat/codex/codexRollout'

function random() {
  let seed = 0x1a6e2026
  return () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0 }
}

test('Q2/Q5: seeded native payloads and replay preserve ordered occurrences (seed 1a6e2026, 200x40)', async () => {
  const next = random(), claude = createHarness()
  const pool: TrustedChatImage[] = [0, 1, 2].map(index => {
    const bytes = Buffer.concat([Buffer.from(CHAT_IMAGE_RED_BASE64, 'base64'), Buffer.from([index])])
    const id = `${createHash('sha256').update(bytes).digest('hex')}.png`
    return { id, mediaType: 'image/png', byteSize: bytes.length, bytes, path: `/assets/${id}` }
  })
  try {
    for (let sample = 0; sample < propertyCases(200); sample++) {
      const codex = codexDriver({ inProcess: true, enroll: () => {} })
      let descriptor: number | undefined, offset = 0
      const latestInput = () => {
        descriptor ??= openSync(codex.root.home + '/received.jsonl', 'r')
        const size = fstatSync(descriptor).size
        const buffer = Buffer.alloc(size - offset)
        readSync(descriptor, buffer, 0, buffer.length, offset); offset = size
        return buffer.toString().split('\n').filter(Boolean).map(line => JSON.parse(line))
          .filter(call => call.method === 'turn/start').at(-1)?.params?.input
      }
      try {
        await codex.driver.start()
        for (let command = 0; command < 40; command++) {
          const images = Array.from({ length: 1 + next() % 4 }, () => pool[next() % pool.length])
          const text = next() % 2 ? `note-${sample}-${command}` : ''
          claude.driver.send(text, images)
          await claude.nextWrite()
          const actual = claude.prompts.at(-1)!.message.content
          const content = [
            ...(text ? [{ type: 'text' as const, text }] : []),
            ...images.map(image => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png' as const, data: image.bytes.toString('base64') } })),
          ]
          expect(actual).toEqual(content)
          const handle = await codex.driver.send(text, { images: images.map(image => ({ type: 'localImage', path: image.path })) })
          await handle.result
          expect(latestInput()).toEqual([
            ...(text ? [{ type: 'text', text, text_elements: [] }] : []),
            ...images.map(image => ({ type: 'localImage', path: image.path })),
          ])
          const nativeClaude = JSON.stringify({ type: 'user', uuid: 'fixed', message: { role: 'user', content } })
          const nativeCodex = JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [
            ...(text ? [{ type: 'input_text', text }] : []),
            ...images.flatMap(image => [
              { type: 'input_text', text: `<image name=[Image #1] path="${image.path}">` },
              { type: 'input_image', image_url: `data:image/png;base64,${image.bytes.toString('base64')}` },
              { type: 'input_text', text: '</image>' },
            ]),
          ] } })
          for (const events of [parseTranscriptContent(nativeClaude).events, parseCodexRollout(nativeCodex)]) {
            const users = events.filter(event => event.type === 'user_message')
            expect(users).toHaveLength(1)
            expect(users[0].images?.map(image => image.id)).toEqual(images.map(image => image.id))
            expect(users[0].text).toBe(text)
            expect(JSON.stringify(users)).not.toContain('base64')
            expect(JSON.stringify(users)).not.toContain('/assets/')
          }
        }
      } finally {
        await codex.driver.kill()
        if (descriptor !== undefined) closeSync(descriptor)
        await fs.rm(codex.root.root, { recursive: true, force: true })
      }
    }
  } finally { await claude.cleanup() }
})

test('Q4: seeded HTTP reads never escape a session namespace (seed 1a6e2026, 200x40)', async () => {
  const dir = await fs.mkdtemp('/tmp/kawai-images-property-'), store = new ChatImageStore(dir + '/images')
  try {
    const aBytes = Buffer.from(CHAT_IMAGE_RED_BASE64, 'base64'), bBytes = Buffer.concat([aBytes, Buffer.from([1])])
    const a = await store.put('a', aBytes, 'image/png'), b = await store.put('b', bBytes, 'image/png')
    await fs.symlink(store.dir + '/b/' + b.id, store.dir + '/a/' + b.id)
    const app = new Hono().route('/api/chat', createChatImageRoutes(store, { has: id => ['a', 'b'].includes(id), isArchived: () => false }))
    const next = random()
    for (let sample = 0; sample < propertyCases(200); sample++) for (let command = 0; command < 40; command++) {
      const session = next() % 2 ? 'a' : 'b'
      const id = [a.id, b.id, `${'0'.repeat(64)}.png`, '..%2Fprivate', 'https%3A%2F%2Fexample.com%2Fimage'][next() % 5]
      const valid = session === 'a' ? id === a.id : id === b.id
      const response = await app.request(`/api/chat/${session}/images/${id}`)
      expect(response.status).toBe(valid ? 200 : 404)
      if (valid) expect(Buffer.from(await response.arrayBuffer())).toEqual(session === 'a' ? aBytes : bBytes)
    }
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
})
