// The lossless diff reader behind `task_result_diff_read` (bounded-task-reads
// D8a), mirroring `task_journal_read` for a result's diff: one statement
// reads the diff's byte total and up to 8,192 bytes from the offset, and only
// for a result of the task. The chunk is trimmed back to a whole character
// unless it ends the diff; bytes that do not decode exactly are returned
// untrimmed with null text. `dataBase64` is authoritative. Diff bytes are
// not sealed (independent-verification D6 seals maps and check outcomes).
// The caller and team rules are TaskJournalReads'.
import type { Database } from 'bun:sqlite'
import type { TaskResultDiffChunk } from '../../shared/teamTasks'
import { JOURNAL_CHUNK_BYTES, blobOf, trimIncompleteTail, utf8Exact } from './taskJournalWindow'

/** Throws for an offset that is not a safe non-negative integer, a result not of the task, or an offset past the end. */
export function readResultDiff(db: Database, taskId: string, resultId: string, offsetBytes = 0): TaskResultDiffChunk {
  if (!Number.isSafeInteger(offsetBytes) || offsetBytes < 0) {
    throw new Error(`offset_bytes must be a safe non-negative integer: ${offsetBytes}`)
  }
  const row = db.prepare(`SELECT length(CAST(diff_ref AS BLOB)) AS total,
    substr(CAST(diff_ref AS BLOB), $offset + 1, ${JOURNAL_CHUNK_BYTES}) AS chunk
    FROM team_task_results WHERE id = $result AND task_id = $task`)
    .get({ $offset: offsetBytes, $result: resultId, $task: taskId }) as { total: number | null; chunk: unknown } | null
  if (!row) throw new Error(`Result not found for this task: ${resultId}`)
  // A result with no diff reads as an empty one.
  const total = row.total === null ? 0 : Number(row.total)
  if (offsetBytes > total) throw new Error(`offset_bytes ${offsetBytes} is beyond the diff's ${total} bytes`)
  const base = { resultId, offsetBytes, totalBytes: total }
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
