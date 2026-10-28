// The agent's bounded task reads (bounded-log-reads-and-task-get D4–D6). Not
// wired to a tool yet: `task_get` still serves `TaskStore.detail`, and the
// bounded detail and the lossless entry reader are registered together later
// (design D7, Sequencing), so a bounded `task_get` never ships alone.
// - The detail reads its anchor, the journal, subtask, and message windows,
//   and their counts in one synchronous read transaction, newest first by
//   `(created_at, rowid)` with the limits in SQL, then returns each list
//   oldest first. The other sections stay whole.
// - Journal text reaches JavaScript only as byte projections of a BLOB cast:
//   a ≤ 2,000-byte preview here, a ≤ 8,192-byte chunk in the reader. Stored
//   entries are never rewritten.
// - One exact UTF-8 decode serves both: fatal, keeping a byte-order mark,
//   and accepted only when the text re-encodes to the same bytes.
import type { Database } from 'bun:sqlite'
import type { AgentTaskDetail, TaskJournalChunk, TaskJournalPreview } from '../../shared/teamTasks'
import { rawCoverage } from '../../shared/coverageMaps'
import { partyFromRow } from './actorRow'
import type { MailboxStore } from './mailboxStore'
import { refuseSystem } from './systemCaller'
import type { TaskCaller, TaskService } from './TaskService'
import type { TaskStore } from './taskStore'

export const JOURNAL_PREVIEW_BYTES = 2000
export const JOURNAL_CHUNK_BYTES = 8192
export const JOURNAL_LIMIT_DEFAULT = 50
export const JOURNAL_LIMIT_MAX = 200
export const SUBTASK_WINDOW = 100
export const MESSAGE_WINDOW = 50

export interface JournalWindowRequest {
  /** An entry id of the task; the window holds entries strictly older than it. */
  journalBefore?: string
  /** 1–200, default 50. */
  journalLimit?: number
}

const exactDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

/**
 * The text of `bytes` when they are valid UTF-8 that encodes back to exactly
 * these bytes, else null. A byte-order mark and NUL characters are kept.
 */
export function utf8Exact(bytes: Uint8Array): string | null {
  let text: string
  try { text = exactDecoder.decode(bytes) } catch { return null }
  return Buffer.from(text, 'utf8').equals(bytes) ? text : null
}

/**
 * `bytes` without a trailing lead sequence too short for its character (at
 * most three bytes dropped), never trimmed to empty. Applied only to a cut
 * that is not the end of the entry.
 */
export function trimIncompleteTail(bytes: Uint8Array): Uint8Array {
  for (let back = 1; back <= Math.min(3, bytes.length); back++) {
    const byte = bytes[bytes.length - back]!
    if ((byte & 0xc0) === 0x80) continue
    const length = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1
    return length > back && back < bytes.length ? bytes.subarray(0, bytes.length - back) : bytes
  }
  return bytes
}

/** The preview partition (D4, I-P): T-small, T-invalid, or T-large-readable, from the projected bytes. */
export function journalPreview(totalBytes: number, projected: Uint8Array): Omit<TaskJournalPreview, 'id' | 'author' | 'createdAt'> {
  const cut = totalBytes > JOURNAL_PREVIEW_BYTES
  const bytes = cut ? trimIncompleteTail(projected) : projected
  const text = utf8Exact(bytes)
  return { text, previewBytes: bytes.length, totalBytes, cut, resumeOffsetBytes: text === null ? 0 : bytes.length }
}

/** A projected BLOB of the length SQL promised; anything else is refused rather than guessed. */
function blobOf(value: unknown, length: number): Uint8Array {
  if (value instanceof Uint8Array && value.length === length) return value
  if ((value === null || value === undefined) && length === 0) return new Uint8Array(0)
  throw new Error(`Journal projection returned ${value instanceof Uint8Array ? `${value.length} bytes` : typeof value}, expected ${length} bytes`)
}

const unknownEntry = (id: string) => new Error(`Unknown journal entry for this task: ${id}`)

/** The store side: SQL windows over the task tables, run against the store's database. */
export class TaskJournalWindow {
  constructor(private readonly db: Database, private readonly store: TaskStore, private readonly mail?: MailboxStore) {}

  /**
   * The agent's bounded detail of an existing task (D4/D5). Throws for an
   * unknown task, a foreign or unknown anchor, or a limit outside 1–200.
   */
  agentDetail(taskId: string, window: JournalWindowRequest = {}): AgentTaskDetail {
    const limit = window.journalLimit ?? JOURNAL_LIMIT_DEFAULT
    if (!Number.isInteger(limit) || limit < 1 || limit > JOURNAL_LIMIT_MAX) {
      throw new Error(`journal_limit must be an integer from 1 to ${JOURNAL_LIMIT_MAX}: ${limit}`)
    }
    return this.db.transaction((): AgentTaskDetail => {
      const task = this.store.get(taskId)
      if (!task) throw new Error(`Task not found: ${taskId}`)
      const anchor = window.journalBefore === undefined ? null : this.anchor(taskId, window.journalBefore)
      const rows = this.journalRows(taskId, anchor, limit + 1)
      const subtaskIds = this.db.prepare(`SELECT id FROM team_tasks WHERE parent_id = ?
        ORDER BY created_at DESC, rowid DESC LIMIT ${SUBTASK_WINDOW}`).all(taskId) as Array<{ id: string }>
      const messages = this.mail?.forTaskNewest(taskId, MESSAGE_WINDOW) ?? []
      const counts = this.db.prepare(`SELECT
        (SELECT COUNT(*) FROM team_task_journal WHERE task_id = $id) AS journal,
        (SELECT COUNT(*) FROM team_tasks WHERE parent_id = $id) AS subtasks,
        (SELECT COUNT(*) FROM team_messages WHERE task_id = $id) AS messages`).get({ $id: taskId }) as Record<string, number>
      const journal = rows.slice(0, limit).reverse()
      const olderRemaining = rows.length > limit
      const subtasks = subtaskIds.reverse().map(row => this.store.summary(this.store.get(row.id)!))
      const messageTotal = this.mail ? counts.messages! : 0
      const revisions = this.store.revisions(taskId)
      return {
        task: this.store.summary(task),
        revisions,
        journal,
        subtasks,
        assignments: this.store.assignmentsOf(taskId),
        messages,
        publications: this.store.notices?.publications(task, revisions) ?? [],
        acknowledgements: this.store.acknowledgements.list(taskId),
        // Mapped as `TaskStore.detail` maps them; the seal applies after (D4).
        results: this.store.results.listByTask(taskId).map(result => ({
          ...result,
          checks: this.store.checks.viewForResult(result.id),
          reviewerMaps: this.store.results.reviewerMapsOf(result.id, rawCoverage(result.coverage)),
        })),
        bounds: {
          journal: { total: counts.journal!, returned: journal.length, olderRemaining, nextBefore: olderRemaining ? journal[0]!.id : null },
          subtasks: { total: counts.subtasks!, returned: subtasks.length, truncated: counts.subtasks! > subtasks.length },
          messages: { total: messageTotal, returned: messages.length, truncated: messageTotal > messages.length },
        },
      }
    })()
  }

  /**
   * One chunk of an entry of the task (D6): its byte total and up to 8,192
   * bytes from `offsetBytes`, in one statement. The chunk is trimmed back to
   * a whole character unless it ends the entry; bytes that do not decode
   * exactly are returned untrimmed with null text.
   */
  readEntry(taskId: string, entryId: string, offsetBytes = 0): TaskJournalChunk {
    if (!Number.isSafeInteger(offsetBytes) || offsetBytes < 0) {
      throw new Error(`offset_bytes must be a safe non-negative integer: ${offsetBytes}`)
    }
    const row = this.db.prepare(`SELECT length(CAST(text AS BLOB)) AS total,
      substr(CAST(text AS BLOB), $offset + 1, ${JOURNAL_CHUNK_BYTES}) AS chunk
      FROM team_task_journal WHERE id = $entry AND task_id = $task`)
      .get({ $offset: offsetBytes, $entry: entryId, $task: taskId }) as { total: number; chunk: unknown } | null
    if (!row) throw unknownEntry(entryId)
    const total = Number(row.total)
    if (offsetBytes > total) throw new Error(`offset_bytes ${offsetBytes} is beyond the entry's ${total} bytes`)
    const base = { entryId, offsetBytes, totalBytes: total }
    if (offsetBytes === total) return { ...base, returnedBytes: 0, dataBase64: '', text: '', nextOffsetBytes: null }
    const raw = blobOf(row.chunk, Math.min(JOURNAL_CHUNK_BYTES, total - offsetBytes))
    const trimmed = offsetBytes + raw.length === total ? raw : trimIncompleteTail(raw)
    const text = utf8Exact(trimmed)
    const bytes = text === null ? raw : trimmed
    const next = offsetBytes + bytes.length
    return {
      ...base, returnedBytes: bytes.length, dataBase64: Buffer.from(bytes).toString('base64'), text,
      nextOffsetBytes: next === total ? null : next,
    }
  }

  private anchor(taskId: string, entryId: string): { at: string; rowid: number } {
    const row = this.db.prepare('SELECT created_at AS at, rowid FROM team_task_journal WHERE id = ? AND task_id = ?')
      .get(entryId, taskId) as { at: string; rowid: number } | null
    if (!row) throw unknownEntry(entryId)
    return row
  }

  /** Newest first, `take` rows, strictly older than the anchor; the text only as its byte length and preview. */
  private journalRows(taskId: string, anchor: { at: string; rowid: number } | null, take: number): TaskJournalPreview[] {
    const older = anchor ? 'AND (created_at < $at OR (created_at = $at AND rowid < $rowid))' : ''
    const rows = this.db.prepare(`SELECT id, author_kind, author_session, created_at,
      length(CAST(text AS BLOB)) AS total_bytes, substr(CAST(text AS BLOB), 1, ${JOURNAL_PREVIEW_BYTES}) AS preview
      FROM team_task_journal WHERE task_id = $task ${older}
      ORDER BY created_at DESC, rowid DESC LIMIT $take`)
      .all({ $task: taskId, $take: take, ...(anchor ? { $at: anchor.at, $rowid: anchor.rowid } : {}) }) as Record<string, unknown>[]
    return rows.map(row => {
      const totalBytes = Number(row.total_bytes)
      return {
        id: String(row.id),
        author: partyFromRow(row.author_kind, row.author_session),
        createdAt: String(row.created_at),
        ...journalPreview(totalBytes, blobOf(row.preview, Math.min(totalBytes, JOURNAL_PREVIEW_BYTES))),
      }
    })
  }
}

/**
 * The service side: `task_get`'s caller and team rules before any read
 * (D6 step 1). A foreign team's task is refused as not found.
 */
export class TaskJournalReads {
  constructor(private readonly tasks: TaskService) {}

  async agentGet(caller: TaskCaller, taskId: string, window: JournalWindowRequest = {}): Promise<AgentTaskDetail> {
    await this.readable(caller, taskId)
    return this.tasks.store.journalWindow.agentDetail(taskId, window)
  }

  async journalRead(caller: TaskCaller, taskId: string, entryId: string, offsetBytes = 0): Promise<TaskJournalChunk> {
    await this.readable(caller, taskId)
    return this.tasks.store.journalWindow.readEntry(taskId, entryId, offsetBytes)
  }

  private async readable(caller: TaskCaller, taskId: string): Promise<void> {
    refuseSystem(caller, 'read')
    const { team } = await this.tasks.context(caller)
    this.tasks.sameTeamTask(team, taskId)
  }
}
