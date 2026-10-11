// Sidecar persistence for the worker roster (design D6): one JSON file per
// chat session under <dataDir>/chat-workers/, beside chat-wire/. Written at
// spawn and rewritten on every settle — with the write keyed on the persisted
// shape, a last-tool update that changes nothing on disk is skipped, so the
// file churns exactly when a row's identity or outcome changes. A restart
// reads it back: entries still marked running are recovered as stopped,
// because the process that could have written their outcome is gone. Session
// ids become file names, so only safe ids are accepted.
import fs from 'node:fs'
import path from 'node:path'
import type { ChatWorker, ChatWorkerStatus } from '../../shared/chat'
import { logger } from '../logger'

const SAFE_SESSION_ID = /^[A-Za-z0-9_-]+$/

/** What survives a restart: identity plus outcome, never live state. */
export interface PersistedChatWorker {
  workerId: string
  taskId?: string
  agentType?: string
  description?: string
  depth?: number
  status: ChatWorkerStatus
  summary?: string
}

export class ChatWorkerStore {
  readonly dir: string
  /** Last content written per session, so no-op writes skip the disk. */
  private readonly written = new Map<string, string>()
  /**
   * Per-session operation chain: a delete queued behind the write it cancels
   * (kill settles workers through process_end, which rewrites the file)
   * runs after it, so the file cannot resurrect.
   */
  private readonly chains = new Map<string, Promise<void>>()

  constructor(options: { dir: string }) {
    this.dir = options.dir
  }

  private fileOf(sessionId: string): string {
    if (!SAFE_SESSION_ID.test(sessionId)) {
      throw new Error(`Unsafe chat session id for a worker sidecar: ${sessionId}`)
    }
    return path.join(this.dir, `${sessionId}.json`)
  }

  /** Queue an operation behind the session's earlier ones, in order. */
  private enqueue(sessionId: string, operation: () => Promise<void>): Promise<void> {
    const chain = (this.chains.get(sessionId) ?? Promise.resolve()).then(
      operation,
      operation
    )
    this.chains.set(
      sessionId,
      chain.catch(() => {})
    )
    return chain
  }

  /**
   * Persist the roster's restart-relevant shape. Fire-and-forget by the
   * caller; write errors propagate to that caller's catch. The write is
   * atomic (temp file + rename) so a concurrent read never sees a partial
   * roster.
   */
  write(sessionId: string, workers: ChatWorker[]): Promise<void> {
    if (!SAFE_SESSION_ID.test(sessionId)) return Promise.resolve()
    return this.enqueue(sessionId, async () => {
      const records = workers.map(toPersisted)
      const content = JSON.stringify(records, null, 2)
      if (this.written.get(sessionId) === content) return
      this.written.set(sessionId, content)
      await fs.promises.mkdir(this.dir, { recursive: true })
      const target = this.fileOf(sessionId)
      const staging = `${target}.tmp`
      await fs.promises.writeFile(staging, content, 'utf8')
      await fs.promises.rename(staging, target)
    })
  }

  /**
   * The persisted records, [] when no file exists. A corrupt file reads as
   * empty (a missing row degrades to the plain tool card) and is reported.
   */
  read(sessionId: string): PersistedChatWorker[] {
    if (!SAFE_SESSION_ID.test(sessionId)) return []
    let raw: string
    try {
      raw = fs.readFileSync(this.fileOf(sessionId), 'utf8')
    } catch {
      return []
    }
    try {
      const parsed = JSON.parse(raw) as unknown
      if (!Array.isArray(parsed)) return []
      const records = parsed
        .map(fromPersisted)
        .filter((record): record is PersistedChatWorker => record !== null)
      // The file's content is now known; no-op writes can skip the disk.
      // fromPersisted normalizes to the same key order write() produces.
      this.written.set(sessionId, JSON.stringify(records, null, 2))
      return records
    } catch (error) {
      logger.warn('chat_worker_sidecar_unreadable', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      })
      return []
    }
  }

  /** Delete the session's sidecar (kill: the session is gone for good). */
  delete(sessionId: string): Promise<void> {
    if (!SAFE_SESSION_ID.test(sessionId)) return Promise.resolve()
    return this.enqueue(sessionId, async () => {
      this.written.delete(sessionId)
      // Staging from a lost race would outlive the session; take it too.
      await fs.promises.rm(`${this.fileOf(sessionId)}.tmp`, { force: true })
      await fs.promises.rm(this.fileOf(sessionId), { force: true })
      this.chains.delete(sessionId)
    })
  }
}

/** The projection that survives a restart (design D6). */
function toPersisted(worker: ChatWorker): PersistedChatWorker {
  return {
    workerId: worker.workerId,
    ...(worker.taskId !== undefined ? { taskId: worker.taskId } : {}),
    ...(worker.agentType !== undefined ? { agentType: worker.agentType } : {}),
    ...(worker.description !== undefined
      ? { description: worker.description }
      : {}),
    ...(worker.depth !== undefined ? { depth: worker.depth } : {}),
    status: worker.status,
    ...(worker.summary !== undefined ? { summary: worker.summary } : {}),
  }
}

/** Structural read of one stored record; null when it is not usable. */
function fromPersisted(value: unknown): PersistedChatWorker | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  if (typeof record.workerId !== 'string' || !record.workerId) return null
  const status = record.status
  if (
    status !== 'running' &&
    status !== 'completed' &&
    status !== 'failed' &&
    status !== 'stopped'
  ) {
    return null
  }
  return {
    workerId: record.workerId,
    ...(typeof record.taskId === 'string' ? { taskId: record.taskId } : {}),
    ...(typeof record.agentType === 'string'
      ? { agentType: record.agentType }
      : {}),
    ...(typeof record.description === 'string'
      ? { description: record.description }
      : {}),
    ...(typeof record.depth === 'number' ? { depth: record.depth } : {}),
    status,
    ...(typeof record.summary === 'string' ? { summary: record.summary } : {}),
  }
}
