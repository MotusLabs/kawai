// Immutable session-scoped image assets. Native transcripts own conversation
// rows; these files supply browser bytes and trusted provider image inputs.
import fs from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { CHAT_IMAGE_MAX_BYTES, isChatImageId, type ChatImage, type ChatImageMediaType } from '../../../shared/chatImages'

export interface TrustedChatImage extends ChatImage { path: string; bytes: Buffer }
const extensions: Record<ChatImageMediaType, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp',
}

export function imageMediaType(bytes: Uint8Array): ChatImageMediaType | null {
  const b = Buffer.from(bytes)
  if (b.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png'
  if (b[0] === 255 && b[1] === 216 && b[2] === 255) return 'image/jpeg'
  if (['GIF87a', 'GIF89a'].includes(b.subarray(0, 6).toString())) return 'image/gif'
  if (b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP') return 'image/webp'
  return null
}

export function imageDescriptor(bytes: Buffer, mediaType: ChatImageMediaType): ChatImage {
  return { id: `${createHash('sha256').update(bytes).digest('hex')}.${extensions[mediaType]}`, mediaType, byteSize: bytes.length }
}

export class ChatImageStore {
  private readonly deleted = new Set<string>()
  private readonly writes = new Map<string, Promise<unknown>>()
  constructor(readonly dir: string) {}

  private directory(sessionId: string): string {
    if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) throw Error('Invalid chat session id.')
    return path.join(this.dir, sessionId)
  }

  private async safeDirectory(sessionId: string, create = false): Promise<string> {
    const dir = this.directory(sessionId)
    if (this.deleted.has(sessionId)) throw Error('This chat was killed.')
    if (create) {
      await fs.mkdir(this.dir, { recursive: true, mode: 0o700 })
      const root = await fs.lstat(this.dir)
      if (!root.isDirectory() || root.isSymbolicLink()) throw Error('Unsafe image directory.')
      await fs.mkdir(dir, { recursive: true, mode: 0o700 })
    }
    for (const candidate of [this.dir, dir]) {
      const stat = await fs.lstat(candidate)
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('Unsafe image directory.')
    }
    return dir
  }

  put(sessionId: string, bytes: Buffer, declaredType: string): Promise<ChatImage> {
    const pending = (this.writes.get(sessionId) ?? Promise.resolve()).catch(() => {}).then(() => this.write(sessionId, bytes, declaredType))
    this.writes.set(sessionId, pending)
    void pending.finally(() => { if (this.writes.get(sessionId) === pending) this.writes.delete(sessionId) }).catch(() => {})
    return pending
  }

  private async write(sessionId: string, bytes: Buffer, declaredType: string): Promise<ChatImage> {
    const mediaType = imageMediaType(bytes)
    if (!bytes.length || bytes.length > CHAT_IMAGE_MAX_BYTES) throw Error('Image must contain between 1 byte and 5 MiB.')
    if (!mediaType || mediaType !== declaredType) throw Error('Unsupported image type or mismatched image signature.')
    const image = imageDescriptor(bytes, mediaType)
    const dir = await this.safeDirectory(sessionId, true)
    const temporary = path.join(dir, `.${randomUUID()}.part`)
    const target = path.join(dir, image.id)
    try {
      const handle = await fs.open(temporary, 'wx', 0o600)
      try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
      await this.safeDirectory(sessionId)
      // An exclusive hard-link publishes atomically without replacing a
      // concurrently uploaded identical asset or following an existing link.
      try { await fs.link(temporary, target) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        const existing = await this.read(sessionId, image.id)
        if (!existing.bytes.equals(bytes)) throw Error('Image asset collision.')
      }
      const directoryHandle = await fs.open(dir, constants.O_RDONLY)
      try { await directoryHandle.sync() } finally { await directoryHandle.close() }
      if (this.deleted.has(sessionId)) throw Error('This chat was killed.')
      return image
    } finally { await fs.unlink(temporary).catch(() => {}) }
  }

  async read(sessionId: string, id: string): Promise<TrustedChatImage> {
    if (!isChatImageId(id)) throw Error('Invalid image reference.')
    const dir = await this.safeDirectory(sessionId)
    const filePath = path.join(dir, id)
    const handle = await fs.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const stat = await handle.stat()
      if (!stat.isFile() || stat.size === 0 || stat.size > CHAT_IMAGE_MAX_BYTES) throw Error('Image unavailable.')
      const bytes = await handle.readFile()
      const mediaType = imageMediaType(bytes)
      if (!mediaType) throw Error('Image unavailable.')
      const image = imageDescriptor(bytes, mediaType)
      if (image.id !== id) throw Error('Image unavailable.')
      await this.safeDirectory(sessionId)
      return { ...image, path: filePath, bytes }
    } finally { await handle.close() }
  }

  async delete(sessionId: string): Promise<void> {
    this.deleted.add(sessionId)
    await this.writes.get(sessionId)?.catch(() => {})
    const dir = this.directory(sessionId)
    // Deletion never follows a symlinked namespace.
    const stat = await fs.lstat(dir).catch(() => null)
    if (stat?.isDirectory() && !stat.isSymbolicLink()) await fs.rm(dir, { recursive: true, force: true })
    else if (stat) await fs.unlink(dir)
  }
}

export const publicChatImage = ({ id, mediaType, byteSize }: ChatImage): ChatImage => ({ id, mediaType, byteSize })
