// Browser uploads are bounded HTTP bodies; small session-owned references
// travel over the chat socket. Reading an asset never starts an agent.
import { Hono } from 'hono'
import { CHAT_IMAGE_MAX_BYTES } from '../../shared/chatImages'
import { ChatImageStore, imageMediaType } from '../chat/images/ChatImageStore'

interface ImageSessions { has(id: string): boolean; isArchived(id: string): boolean }
const MAX_BODY = CHAT_IMAGE_MAX_BYTES + 64 * 1024

export function createChatImageRoutes(store: ChatImageStore, sessions: ImageSessions) {
  const app = new Hono()
  app.post('/:sessionId/images', async c => {
    const sessionId = c.req.param('sessionId')
    const state = () => !sessions.has(sessionId) ? 404 : sessions.isArchived(sessionId) ? 409 : null
    const before = state()
    if (before) return c.json({ error: before === 404 ? 'Unknown chat session.' : 'Restore this chat before uploading images.' }, before)
    const tooLarge = () => c.json({ error: 'Images must be at most 5 MiB.' }, 413)
    if (Number(c.req.header('content-length')) > MAX_BODY) return tooLarge()
    const reader = c.req.raw.body?.getReader()
    if (!reader) return c.json({ error: 'Paste an image first.' }, 400)
    let body: Buffer
    try {
      const chunks: Uint8Array[] = []
      let length = 0
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        length += value.byteLength
        if (length > MAX_BODY) { await reader.cancel(); return tooLarge() }
        chunks.push(value)
      }
      body = Buffer.concat(chunks, length)
    } catch { return c.json({ error: 'Image upload failed. Try again.' }, 400) }
    finally { reader.releaseLock() }
    const after = state()
    if (after) return c.json({ error: 'This chat is no longer available for upload.' }, after)
    let file: File
    try {
      const form = await new Response(new Uint8Array(body), { headers: { 'Content-Type': c.req.header('content-type') ?? '' } }).formData()
      const files = form.getAll('image')
      if (files.length !== 1 || !(files[0] instanceof File) || files[0].size === 0) throw Error('Missing image')
      file = files[0]
    } catch { return c.json({ error: 'Upload one nonempty image.' }, 400) }
    if (file.size > CHAT_IMAGE_MAX_BYTES) return tooLarge()
    const bytes = Buffer.from(await file.arrayBuffer())
    if (!imageMediaType(bytes) || imageMediaType(bytes) !== file.type) return c.json({ error: 'Unsupported image type or mismatched signature.' }, 415)
    const current = state()
    if (current) return c.json({ error: 'This chat is no longer available for upload.' }, current)
    try {
      const image = await store.put(sessionId, bytes, file.type)
      const final = state()
      if (final) return c.json({ error: 'This chat is no longer available for upload.' }, final)
      c.header('Cache-Control', 'no-store')
      return c.json({ image })
    } catch { return c.json({ error: 'Could not store the image. Try again.' }, 500) }
  })
  app.get('/:sessionId/images/:imageId', async c => {
    const sessionId = c.req.param('sessionId')
    if (!sessions.has(sessionId)) return c.json({ error: 'Image unavailable.' }, 404)
    try {
      const image = await store.read(sessionId, c.req.param('imageId'))
      if (!sessions.has(sessionId)) return c.json({ error: 'Image unavailable.' }, 404)
      c.header('Content-Type', image.mediaType)
      c.header('X-Content-Type-Options', 'nosniff')
      c.header('Cache-Control', 'private, max-age=3600')
      return c.body(new Uint8Array(image.bytes))
    } catch { return c.json({ error: 'Image unavailable.' }, 404) }
  })
  return app
}
