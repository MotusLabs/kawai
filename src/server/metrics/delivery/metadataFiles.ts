// Process-free Linux metadata reads. Kernel fd aliases pin opened directories;
// only repository-relative components use O_NOFOLLOW. No worktree writes.
import fs from 'node:fs'
import path from 'node:path'
import { TextDecoder } from 'node:util'
import { DELIVERY_METADATA_BOUND } from './readerTypes'
import type { PhysicalIdentity } from './readerTypes'

export class MetadataError extends Error {
  constructor(readonly kind: 'missing' | 'unsafe' | 'unreadable' | 'exceeds-bound' | 'changed' | 'unsupported-platform') {
    super(kind)
    this.name = 'MetadataError'
  }
}

function failure(error: unknown): MetadataError {
  if (error instanceof MetadataError) return error
  const code = (error as NodeJS.ErrnoException | null)?.code
  return new MetadataError(code === 'ENOENT' ? 'missing' : code === 'ELOOP' || code === 'ENOTDIR' ? 'unsafe' : 'unreadable')
}

function identity(stat: fs.BigIntStats): PhysicalIdentity {
  if (typeof stat.dev !== 'bigint' || typeof stat.ino !== 'bigint' || stat.ino <= 0n) {
    throw new MetadataError('unsupported-platform')
  }
  return Object.freeze({ dev: String(stat.dev), ino: String(stat.ino) })
}

/** Token rejection disables reuse; it never relaxes fresh snapshot checks. */
export function reliableMetadataToken(stat: unknown): string | null {
  if (stat === null || typeof stat !== 'object') return null
  const record = stat as Record<string, unknown>
  const fields = ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].map(key => record[key])
  if (!fields.every(value => typeof value === 'bigint' && value >= 0n) || fields[1] === 0n) return null
  return fields.map(String).join(':')
}

const SNAPSHOT_FIELDS = ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'] as const
type Snapshot = Readonly<Record<typeof SNAPSHOT_FIELDS[number], bigint>>

/** Fresh-read capability is mandatory; cache-token trust is a separate choice. */
function snapshot(stat: unknown): Snapshot {
  if (stat === null || typeof stat !== 'object') throw new MetadataError('unsupported-platform')
  const field = (key: typeof SNAPSHOT_FIELDS[number]): bigint => {
    const value = (stat as Record<string, unknown>)[key]
    if (typeof value !== 'bigint') throw new MetadataError('unsupported-platform')
    return value
  }
  const captured = { dev: field('dev'), ino: field('ino'), size: field('size'),
    mtimeNs: field('mtimeNs'), ctimeNs: field('ctimeNs') }
  if (captured.dev < 0n || captured.ino <= 0n || captured.size < 0n) throw new MetadataError('unsupported-platform')
  return Object.freeze(captured)
}

function sameStat(before: Snapshot, after: unknown): boolean {
  const current = snapshot(after)
  return SNAPSHOT_FIELDS.every(key => before[key] === current[key])
}

export interface MetadataFile {
  readonly stat: fs.BigIntStats
  readBytes(): Buffer
  readText(): string
  mtimeMs(): number
}

export class MetadataRoot {
  readonly repository: string
  readonly identity: PhysicalIdentity
  private fd: number | null

  constructor(input: string) {
    if (process.platform !== 'linux' || ![fs.constants.O_NOFOLLOW, fs.constants.O_DIRECTORY, fs.constants.O_NONBLOCK]
      .every(flag => typeof flag === 'number' && flag > 0)) throw new MetadataError('unsupported-platform')
    try {
      this.repository = fs.realpathSync(path.resolve(input))
      this.fd = fs.openSync(this.repository, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW)
      try {
        const stat = fs.fstatSync(this.fd, { bigint: true })
        snapshot(stat)
        if (!stat.isDirectory()) throw new MetadataError('unsafe')
        this.identity = identity(stat)
      } catch (error) {
        fs.closeSync(this.fd)
        this.fd = null
        throw error
      }
    } catch (error) { throw failure(error) }
  }

  private descriptor(): number {
    if (this.fd === null) throw new MetadataError('unreadable')
    return this.fd
  }

  /** Callback paths stay internal; all parent descriptors close here. */
  private at<T>(relative: string, callback: (file: string) => T): T {
    const parts = relative.split('/')
    if (parts.some(part => part === '' || part === '.' || part === '..' || /[\0\\]/.test(part))) {
      throw new MetadataError('unsafe')
    }
    const opened: number[] = []
    let parent = this.descriptor()
    try {
      for (const part of parts.slice(0, -1)) {
        parent = fs.openSync(`/proc/self/fd/${parent}/${part}`,
          fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW)
        opened.push(parent)
        const stat = fs.fstatSync(parent, { bigint: true })
        snapshot(stat)
        if (!stat.isDirectory()) throw new MetadataError('unsafe')
      }
      return callback(`/proc/self/fd/${parent}/${parts.at(-1)!}`)
    } catch (error) { throw failure(error) }
    finally {
      let failed = false
      for (const fd of opened.reverse()) { try { fs.closeSync(fd) } catch { failed = true } }
      if (failed) throw new MetadataError('unreadable')
    }
  }

  withFile<T>(relative: string, maxBytes: number | undefined, callback: (file: MetadataFile) => T): T {
    return this.at(relative, file => {
      const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
      let active = true
      const requireActive = (): void => { if (!active) throw new MetadataError('unreadable') }
      try {
        const stat = fs.fstatSync(fd, { bigint: true })
        const before = snapshot(stat)
        if (!stat.isFile()) throw new MetadataError('unsafe')
        if (maxBytes !== undefined && before.size > BigInt(maxBytes)) throw new MetadataError('exceeds-bound')
        let captured: Buffer | undefined
        const readBytes = (): Buffer => {
          requireActive()
          if (captured !== undefined) return captured
          if (maxBytes === undefined) throw new MetadataError('unreadable')
          const chunks: Buffer[] = []
          let bytes = 0
          for (;;) {
            const buffer = Buffer.alloc(Math.min(65536, maxBytes + 1 - bytes))
            const count = fs.readSync(fd, buffer, 0, buffer.length, null)
            if (count === 0) break
            bytes += count
            if (bytes > maxBytes) throw new MetadataError('exceeds-bound')
            chunks.push(buffer.subarray(0, count))
          }
          captured = Buffer.concat(chunks, bytes)
          return captured
        }
        const result = callback({
          stat,
          mtimeMs: () => {
            requireActive()
            return before.mtimeNs < 0n ? NaN : Number(before.mtimeNs / 1000000n)
          },
          readBytes,
          readText: () => new TextDecoder('utf-8', { fatal: true }).decode(readBytes()),
        })
        if (!sameStat(before, fs.fstatSync(fd, { bigint: true }))) throw new MetadataError('changed')
        return result
      } finally { active = false; fs.closeSync(fd) }
    })
  }

  text(relative: string, bound: number): string {
    return this.withFile(relative, bound, file => file.readText())
  }

  hasFile(relative: string): boolean {
    try { return this.withFile(relative, undefined, () => true) }
    catch (error) { if (error instanceof MetadataError && error.kind === 'missing') return false; throw error }
  }

  /** Stream directory entries with bounded name bytes, never a partial scan. */
  hasPromisorPack(): boolean {
    try {
      return this.at('objects/pack', file => {
        const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW)
        try {
          const before = snapshot(fs.fstatSync(fd, { bigint: true }))
          const directory = fs.opendirSync(`/proc/self/fd/${fd}`)
          try {
            let bytes = 0
            for (;;) {
              const entry = directory.readSync()
              if (entry === null) {
                if (!sameStat(before, fs.fstatSync(fd, { bigint: true }))) throw new MetadataError('changed')
                return false
              }
              bytes += Buffer.byteLength(entry.name, 'utf8') + 1
              if (bytes > DELIVERY_METADATA_BOUND) throw new MetadataError('exceeds-bound')
              if (entry.name.endsWith('.promisor')) {
                let marker: number
                try {
                  marker = fs.openSync(`/proc/self/fd/${fd}/${entry.name}`,
                    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
                } catch (error) {
                  if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new MetadataError('changed')
                  throw error
                }
                try {
                  const stat = fs.fstatSync(marker, { bigint: true })
                  snapshot(stat)
                  if (!stat.isFile()) throw new MetadataError('unsafe')
                }
                finally { fs.closeSync(marker) }
                return true
              }
            }
          } finally { directory.closeSync() }
        } finally { fs.closeSync(fd) }
      })
    } catch (error) { if (error instanceof MetadataError && error.kind === 'missing') return false; throw error }
  }

  assertCurrent(): void {
    const stat = fs.lstatSync(this.repository, { bigint: true })
    snapshot(stat)
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev.toString() !== this.identity.dev
      || stat.ino.toString() !== this.identity.ino) throw new MetadataError('changed')
  }

  close(): void {
    const fd = this.fd
    this.fd = null
    if (fd !== null) fs.closeSync(fd)
  }
}
