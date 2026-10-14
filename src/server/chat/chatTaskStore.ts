// Sidecar persistence for the background-task roster (background tasks
// design D6): one JSON file per chat session under <dataDir>/chat-tasks/,
// beside chat-wire/ and chat-workers/. Written at promotion and settle,
// keyed on the persisted shape so `live` toggles never touch the disk. A
// restart reads it back: entries still marked running are recovered as
// stopped (the process that could have written their outcome is gone), and
// the corrected roster is rewritten so the file and the rows agree. Kill
// deletes the file; archive keeps it. Modeled on ChatWorkerStore: session
// ids become file names, so only safe ids are accepted, and writes are
// chained per session so a delete queued behind a write cannot be overtaken.
import fs from 'node:fs'
import path from 'node:path'
import type { BackgroundTaskRecord } from './chatBackgroundTasks'
import type { ChatBackgroundTaskKind, ChatBackgroundTaskStatus } from '../../shared/chat'
import { logger } from '../logger'

const SAFE_SESSION_ID = /^[A-Za-z0-9_-]+$/

/** What survives a restart: `BackgroundTaskRecord` by another name. */
export type PersistedChatBackgroundTask = BackgroundTaskRecord

export class ChatTaskStore {
  readonly dir: string
  /** Last content written per session, so no-op writes skip the disk. */
  private readonly written = new Map<string, string>()
  /**
   * Per-session operation chain: a delete queued behind the write it cancels
   * (kill settles tasks through process_end, which rewrites the file) runs
   * after it, so the file cannot resurrect.
   */
  private readonly chains = new Map<string, Promise<void>>()

  constructor(options: { dir: string }) {
    this.dir = options.dir
  }

  private fileOf(sessionId: string): string {
    if (!SAFE_SESSION_ID.test(sessionId)) {
      throw new Error(`Unsafe chat session id for a task sidecar: ${sessionId}`)
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
  write(sessionId: string, tasks: BackgroundTaskRecord[]): Promise<void> {
    if (!SAFE_SESSION_ID.test(sessionId)) return Promise.resolve()
    return this.enqueue(sessionId, async () => {
      const records = tasks.map(toPersisted)
      const content = JSON.stringify(records, null, 2)
      if (this.written.get(sessionId) === content) return
      await fs.promises.mkdir(this.dir, { recursive: true })
      const target = this.fileOf(sessionId)
      const staging = `${target}.tmp`
      await fs.promises.writeFile(staging, content, 'utf8')
      await fs.promises.rename(staging, target)
      // Record the write only once it landed: a failed write must not be
      // treated as persisted, or the identical roster would never retry.
      this.written.set(sessionId, content)
    })
  }

  /**
   * The persisted records, [] when no file exists. A corrupt file reads as
   * empty (a missing row degrades to the plain tool entry) and is reported.
   */
  read(sessionId: string): PersistedChatBackgroundTask[] {
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
        .filter((record): record is PersistedChatBackgroundTask => record !== null)
      // The file's content is now known; no-op writes can skip the disk.
      // fromPersisted normalizes to the same key order write() produces.
      this.written.set(sessionId, JSON.stringify(records, null, 2))
      return records
    } catch (error) {
      logger.warn('chat_task_sidecar_unreadable', {
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
function toPersisted(task: BackgroundTaskRecord): PersistedChatBackgroundTask {
  return {
    taskId: task.taskId,
    ...(task.toolCallId !== undefined ? { toolCallId: task.toolCallId } : {}),
    kind: task.kind,
    ...(task.description !== undefined ? { description: task.description } : {}),
    status: task.status,
    ...(task.summary !== undefined ? { summary: task.summary } : {}),
    ...(task.outputFile !== undefined ? { outputFile: task.outputFile } : {}),
    startedAtMs: task.startedAtMs,
    ...(task.endedAtMs !== undefined ? { endedAtMs: task.endedAtMs } : {}),
  }
}

/** Structural read of one stored record; null when it is not usable. */
function fromPersisted(value: unknown): PersistedChatBackgroundTask | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  if (typeof record.taskId !== 'string' || !record.taskId) return null
  if (record.kind !== 'shell' && record.kind !== 'monitor') return null
  const status = record.status
  if (
    status !== 'running' &&
    status !== 'completed' &&
    status !== 'failed' &&
    status !== 'stopped'
  ) {
    return null
  }
  if (typeof record.startedAtMs !== 'number') return null
  return {
    taskId: record.taskId,
    ...(typeof record.toolCallId === 'string' ? { toolCallId: record.toolCallId } : {}),
    kind: record.kind,
    ...(typeof record.description === 'string' ? { description: record.description } : {}),
    status,
    ...(typeof record.summary === 'string' ? { summary: record.summary } : {}),
    ...(typeof record.outputFile === 'string' ? { outputFile: record.outputFile } : {}),
    startedAtMs: record.startedAtMs,
    ...(typeof record.endedAtMs === 'number' ? { endedAtMs: record.endedAtMs } : {}),
  }
}
