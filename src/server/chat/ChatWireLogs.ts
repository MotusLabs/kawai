// Registry of per-session chat wire logs under one directory (beside
// agentboard.db): lazy log creation, live fan-out of recorded frames to debug
// subscribers, deletion on kill, and startup pruning of logs whose session no
// longer exists. Session ids become file names, so only safe ids are accepted.
import fs from 'node:fs'
import type { ChatWireFrame } from '../../shared/chat'
import { logger } from '../logger'
import { ChatWireLog, type ChatWirePage } from './ChatWireLog'

const SAFE_SESSION_ID = /^[A-Za-z0-9_-]+$/
const LOG_FILE = /^([A-Za-z0-9_-]+)(?:\.1)?\.jsonl$/

export type ChatWireListener = (sessionId: string, frame: ChatWireFrame) => void

export interface ChatWireLogsOptions {
  dir: string
  maxFileBytes?: number
}

export class ChatWireLogs {
  readonly dir: string
  private readonly maxFileBytes: number | undefined
  private readonly logs = new Map<string, ChatWireLog>()
  private readonly listeners = new Map<string, Set<(frame: ChatWireFrame) => void>>()

  constructor(options: ChatWireLogsOptions) {
    this.dir = options.dir
    this.maxFileBytes = options.maxFileBytes
  }

  /** The session's log, created on first use. */
  get(sessionId: string): ChatWireLog {
    assertSafe(sessionId)
    let log = this.logs.get(sessionId)
    if (!log) {
      log = new ChatWireLog({
        dir: this.dir,
        sessionId,
        ...(this.maxFileBytes !== undefined ? { maxFileBytes: this.maxFileBytes } : {}),
        onFrame: frame => {
          for (const listener of this.listeners.get(sessionId) ?? []) listener(frame)
        },
        onWriteError: error => logger.warn('chat_wire_log_write_failed', {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        }),
      })
      this.logs.set(sessionId, log)
    }
    return log
  }

  readPage(sessionId: string, options: { beforeSeq?: number; limit: number }): Promise<ChatWirePage> {
    return this.get(sessionId).readPage(options)
  }

  /** Receive every frame recorded for the session from now on. */
  subscribe(sessionId: string, listener: (frame: ChatWireFrame) => void): () => void {
    const listeners = this.listeners.get(sessionId) ?? new Set()
    listeners.add(listener)
    this.listeners.set(sessionId, listeners)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0 && this.listeners.get(sessionId) === listeners) {
        this.listeners.delete(sessionId)
      }
    }
  }

  /** Delete both generations of the session's log. */
  async delete(sessionId: string): Promise<void> {
    if (!SAFE_SESSION_ID.test(sessionId)) return
    const log = this.get(sessionId)
    this.logs.delete(sessionId)
    this.listeners.delete(sessionId)
    await log.delete()
  }

  /** Remove logs left behind by sessions that no longer exist. */
  async pruneOrphans(knownSessionIds: Set<string>): Promise<void> {
    let names: string[]
    try {
      names = await fs.promises.readdir(this.dir)
    } catch {
      return
    }
    const orphans = new Set<string>()
    for (const name of names) {
      const sessionId = LOG_FILE.exec(name)?.[1]
      if (sessionId && !knownSessionIds.has(sessionId)) orphans.add(sessionId)
    }
    await Promise.all(Array.from(orphans, sessionId => this.delete(sessionId)))
  }
}

function assertSafe(sessionId: string): void {
  if (!SAFE_SESSION_ID.test(sessionId)) {
    throw new Error(`Unsafe chat session id for a wire log: ${sessionId}`)
  }
}
