// One chat session's captured protocol frames on disk: `<id>.jsonl` plus one
// rotated generation `<id>.1.jsonl`, each line a JSON-encoded ChatWireFrame.
// `record` assigns the sequence synchronously and never blocks or throws; a
// single serialized chain performs batched appends, rotation, page reads, and
// deletion, so readers always see a consistent pair of files. The sequence
// resumes from the newest frame on disk, so it keeps increasing across process
// respawns and server restarts.
import fs from 'node:fs'
import path from 'node:path'
import type { ChatWireDirection, ChatWireFrame } from '../../shared/chat'
import type { ChatWireRecorder } from './wireTap'

/** Rotate the current file once it reaches this size (16 MiB). */
export const DEFAULT_WIRE_LOG_MAX_FILE_BYTES = 16 * 1024 * 1024

export interface ChatWireLogOptions {
  dir: string
  sessionId: string
  maxFileBytes?: number
  /** Called for every recorded frame (live fan-out). */
  onFrame?: (frame: ChatWireFrame) => void
  /** Called once per log on the first write failure. */
  onWriteError?: (error: unknown) => void
}

export interface ChatWirePage {
  frames: ChatWireFrame[]
  hasOlder: boolean
}

export class ChatWireLog implements ChatWireRecorder {
  readonly currentPath: string
  readonly rotatedPath: string
  private readonly options: ChatWireLogOptions
  private readonly maxFileBytes: number
  private seq: number
  private currentBytes: number
  private pending: ChatWireFrame[] = []
  private chain: Promise<unknown> = Promise.resolve()
  private flushScheduled = false
  private writeFailed = false
  /** The current file ends in a torn line; terminate it before appending. */
  private needsNewline: boolean
  private deleted = false

  constructor(options: ChatWireLogOptions) {
    this.options = options
    this.maxFileBytes = options.maxFileBytes ?? DEFAULT_WIRE_LOG_MAX_FILE_BYTES
    this.currentPath = path.join(options.dir, `${options.sessionId}.jsonl`)
    this.rotatedPath = path.join(options.dir, `${options.sessionId}.1.jsonl`)
    this.currentBytes = fileSize(this.currentPath)
    this.needsNewline = endsTorn(this.currentPath, this.currentBytes)
    this.seq = lastSeq(this.currentPath) ?? lastSeq(this.rotatedPath) ?? 0
  }

  /** Highest sequence assigned so far (0 when nothing was ever recorded). */
  get lastSeq(): number {
    return this.seq
  }

  record(dir: ChatWireDirection, raw: string): void {
    if (this.deleted) return
    this.seq += 1
    const frame: ChatWireFrame = { seq: this.seq, at: new Date().toISOString(), dir, raw }
    this.pending.push(frame)
    if (!this.flushScheduled) {
      this.flushScheduled = true
      setTimeout(() => this.enqueue(() => this.writePending()), 0)
    }
    this.options.onFrame?.(frame)
  }

  /** Resolve once every frame recorded so far is on disk (or dropped). */
  flush(): Promise<void> {
    return this.enqueue(() => this.writePending())
  }

  /** Up to `limit` frames before `beforeSeq` (newest frames when omitted). */
  readPage(options: { beforeSeq?: number; limit: number }): Promise<ChatWirePage> {
    return this.enqueue(async () => {
      await this.writePending()
      const frames = [
        ...(await readFrames(this.rotatedPath)),
        ...(await readFrames(this.currentPath)),
      ].filter(frame => options.beforeSeq === undefined || frame.seq < options.beforeSeq)
      const start = Math.max(0, frames.length - options.limit)
      return { frames: frames.slice(start), hasOlder: start > 0 }
    })
  }

  /** Remove both generations; later records are ignored. */
  delete(): Promise<void> {
    this.deleted = true
    this.pending = []
    return this.enqueue(async () => {
      await fs.promises.rm(this.currentPath, { force: true })
      await fs.promises.rm(this.rotatedPath, { force: true })
    })
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.chain.then(task)
    this.chain = next.catch(() => {})
    return next
  }

  private async writePending(): Promise<void> {
    this.flushScheduled = false
    const batch = this.pending
    this.pending = []
    if (batch.length === 0 || this.deleted) return
    const data = (this.needsNewline ? '\n' : '') +
      batch.map(frame => `${JSON.stringify(frame)}\n`).join('')
    try {
      await fs.promises.mkdir(this.options.dir, { recursive: true, mode: 0o700 })
      await fs.promises.appendFile(this.currentPath, data, { mode: 0o600 })
      this.needsNewline = false
      this.currentBytes += Buffer.byteLength(data)
      if (this.currentBytes >= this.maxFileBytes) {
        await fs.promises.rename(this.currentPath, this.rotatedPath)
        this.currentBytes = 0
      }
    } catch (error) {
      // Capture must never break the chat: drop the batch, report once.
      if (!this.writeFailed) {
        this.writeFailed = true
        this.options.onWriteError?.(error)
      }
    }
  }
}

function fileSize(filePath: string): number {
  try {
    return fs.statSync(filePath).size
  } catch {
    return 0
  }
}

function endsTorn(filePath: string, size: number): boolean {
  if (size === 0) return false
  let fd: number | undefined
  try {
    fd = fs.openSync(filePath, 'r')
    const last = Buffer.alloc(1)
    fs.readSync(fd, last, 0, 1, size - 1)
    return last[0] !== 0x0a
  } catch {
    return false
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

function parseFrame(line: string): ChatWireFrame | null {
  if (!line) return null
  try {
    const frame = JSON.parse(line) as ChatWireFrame
    return typeof frame?.seq === 'number' && typeof frame.raw === 'string' ? frame : null
  } catch {
    // A torn final line (crash mid-append) is skipped.
    return null
  }
}

async function readFrames(filePath: string): Promise<ChatWireFrame[]> {
  let text: string
  try {
    text = await fs.promises.readFile(filePath, 'utf8')
  } catch {
    return []
  }
  const frames: ChatWireFrame[] = []
  for (const line of text.split('\n')) {
    const frame = parseFrame(line)
    if (frame) frames.push(frame)
  }
  return frames
}

/**
 * Sequence of the newest parseable frame in a file, reading backwards in
 * growing windows so a large log is not loaded whole to resume.
 */
function lastSeq(filePath: string): number | null {
  let fd: number
  try {
    fd = fs.openSync(filePath, 'r')
  } catch {
    return null
  }
  try {
    const size = fs.fstatSync(fd).size
    for (let window = 64 * 1024; ; window *= 4) {
      const length = Math.min(window, size)
      const buffer = Buffer.alloc(length)
      fs.readSync(fd, buffer, 0, length, size - length)
      const lines = buffer.toString('utf8').split('\n')
      // Unless the window covers the whole file, its first line may be cut.
      const complete = length === size ? lines : lines.slice(1)
      for (let index = complete.length - 1; index >= 0; index -= 1) {
        const frame = parseFrame(complete[index]!)
        if (frame) return frame.seq
      }
      if (length === size) return null
    }
  } finally {
    fs.closeSync(fd)
  }
}
