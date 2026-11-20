import { afterEach, expect, spyOn, test } from 'bun:test'
import fs from 'node:fs/promises'
import { Hono } from 'hono'
import { ChatImageStore, imageDescriptor } from '../chat/images/ChatImageStore'
import { createChatImageRoutes } from '../routes/chatImages'
import { CHAT_IMAGE_MAX_BYTES } from '../../shared/chatImages'

const dirs: string[] = []
afterEach(async () => { for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true }) })
const png = Buffer.from('89504e470d0a1a0a0000', 'hex')
async function harness() {
  const dir = await fs.mkdtemp('/tmp/kawai-chat-images-'); dirs.push(dir)
  const store = new ChatImageStore(dir + '/images')
  const archived = new Set<string>()
  const app = new Hono().route('/api/chat', createChatImageRoutes(store, {
    has: id => ['a', 'b'].includes(id), isArchived: id => archived.has(id),
  }))
  const upload = (bytes = png, type = 'image/png', session = 'a') => {
    const form = new FormData(); form.append('image', new Blob([bytes], { type }), `image.${type.split('/')[1]}`)
    return app.request(`/api/chat/${session}/images`, { method: 'POST', body: form })
  }
  return { store, app, upload, archived, dir }
}

// @covers: chat-image-attachments › Image submissions are bounded and session scoped › Archived or missing chat
test('U1/U2/U4/U5: upload refusals do not publish assets', async () => {
  const h = await harness()
  expect((await h.upload(png, 'image/png', 'missing')).status).toBe(404)
  h.archived.add('a'); expect((await h.upload()).status).toBe(409); h.archived.clear()
  expect((await h.upload(Buffer.alloc(0))).status).toBe(400)
  expect((await h.upload(png, 'image/jpeg')).status).toBe(415)
  expect((await h.app.request('/api/chat/a/images', { method: 'POST', body: 'bad' })).status).toBe(400)
  expect(await fs.readdir(h.dir)).toEqual([])
})

// @covers: chat-image-attachments › Image submissions are bounded and session scoped › Accepted boundary
// @covers: chat-image-attachments › Image submissions are bounded and session scoped › Invalid image or limit exceeded
test('U3/U7: actual streamed bytes and exact 5 MiB boundary', async () => {
  const h = await harness()
  const boundary = Buffer.alloc(CHAT_IMAGE_MAX_BYTES); png.copy(boundary)
  expect((await h.upload(boundary)).status).toBe(200)
  expect((await h.upload(Buffer.concat([boundary, Buffer.from([0])]))).status).toBe(413)
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(CHAT_IMAGE_MAX_BYTES + 65537)); controller.close() } })
  expect((await h.app.request('/api/chat/a/images', { method: 'POST', body: stream, headers: { 'Content-Length': '1' } })).status).toBe(413)
})

// @covers: chat-image-attachments › Image submissions are bounded and session scoped › Another session's image reference
// @covers: chat-image-attachments › Sent images remain part of conversation history › Archived and older history
test('U7/H3/H6/H7: immutable assets survive reopen and archive and refuse foreign or symlinked reads', async () => {
  const h = await harness()
  const image = (await (await h.upload()).json()).image
  await Promise.all([h.store.put('a', png, 'image/png'), h.store.put('a', png, 'image/png')])
  h.archived.add('a')
  const result = await h.app.request(`/api/chat/a/images/${image.id}`)
  expect(result.headers.get('Content-Type')).toBe('image/png')
  expect(result.headers.get('X-Content-Type-Options')).toBe('nosniff')
  expect(Buffer.from(await result.arrayBuffer())).toEqual(png)
  expect((await new ChatImageStore(h.store.dir).read('a', image.id)).bytes).toEqual(png)
  expect((await h.app.request(`/api/chat/b/images/${image.id}`)).status).toBe(404)
  await fs.mkdir(h.store.dir + '/b')
  await fs.symlink(h.store.dir + '/a/' + image.id, h.store.dir + '/b/' + image.id)
  expect((await h.app.request(`/api/chat/b/images/${image.id}`)).status).toBe(404)
  await h.store.delete('a')
  await expect(h.store.read('a', image.id)).rejects.toThrow()
  await expect(h.store.put('a', png, 'image/png')).rejects.toThrow()
})

test('U6: storage failure returns an error rather than a successful reference', async () => {
  const h = await harness()
  await fs.writeFile(h.store.dir, 'not a directory')
  const response = await h.upload()
  expect(response.status).toBe(500)
  expect(await response.json()).toEqual({ error: 'Could not store the image. Try again.' })
})

test('U2: archive during body read refuses publication', async () => {
  const h = await harness()
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const body = new ReadableStream({ async start(controller) {
    await gate; controller.enqueue(new TextEncoder().encode('body')); controller.close()
  } })
  const pending = h.app.request('/api/chat/a/images', { method: 'POST', body })
  h.archived.add('a'); release()
  expect((await pending).status).toBe(409)
  expect(await fs.readdir(h.dir)).toEqual([])
})

test('U6/U7: failed publication exposes no partial asset and a fresh store sees complete publication', async () => {
  const h = await harness()
  const failed = spyOn(fs, 'link').mockRejectedValueOnce(Error('publication interrupted'))
  try { await expect(h.store.put('a', png, 'image/png')).rejects.toThrow('publication interrupted') }
  finally { failed.mockRestore() }
  await expect(new ChatImageStore(h.store.dir).read('a', imageDescriptor(png, 'image/png').id)).rejects.toThrow()
  expect(await fs.readdir(h.store.dir + '/a')).toEqual([])
  const good = await h.store.put('a', png, 'image/png')
  expect((await new ChatImageStore(h.store.dir).read('a', good.id)).bytes).toEqual(png)
})

test('H2: kill waits for pending writes and cannot leave a resurrected namespace', async () => {
  const h = await harness()
  const pending = h.store.put('a', png, 'image/png').catch(() => null)
  await h.store.delete('a'); await pending
  expect(await fs.lstat(h.store.dir + '/a').catch(() => null)).toBeNull()
})

// Store validation remains independent of the route's validation.
test('U3/U5: direct store calls reject invalid size and mismatched signatures', async () => {
  const h = await harness()
  await expect(h.store.put('a', png, 'image/jpeg')).rejects.toThrow('mismatched')
  await expect(h.store.put('a', Buffer.alloc(0), 'image/png')).rejects.toThrow('5 MiB')
  await expect(h.store.put('a', Buffer.alloc(CHAT_IMAGE_MAX_BYTES + 1), 'image/png')).rejects.toThrow('5 MiB')
  expect(await fs.readdir(h.dir)).toEqual([])
})
