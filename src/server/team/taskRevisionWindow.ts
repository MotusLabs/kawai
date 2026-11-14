// The agent's bounded revision reads (bounded-metrics-and-task-get D7), run
// inside `TaskJournalWindow.agentDetail`'s read transaction.
// - The window is the newest 50 revision rows, taken in SQL (`ORDER BY
//   revision DESC LIMIT`), returned oldest first. A row carries no direction
//   or acceptance: SQL gives their byte lengths, and the statement selects
//   the text only of the windowed rows so JavaScript can hash it with the
//   store's own derivation (`identityOf`) and drop it.
// - The rationale is a ≤ 2,000-byte BLOB projection, previewed as a journal
//   entry is. `revision: n` reads one revision whole.
import type { Database } from 'bun:sqlite'
import type { AgentRevisionRow, AgentRevisionText, AgentTaskBounds, TaskRevision } from '../../shared/teamTasks'
import { partyFromRow } from './actorRow'
import { identityOf } from './contractHash'
import { JOURNAL_PREVIEW_BYTES, blobOf, journalPreview } from './taskJournalWindow'

export const REVISION_WINDOW = 50

export interface RevisionWindowRequest {
  /** A revision number of the task, 2..task.revision; the window holds the revisions below it. */
  revisionsBefore?: number
  /** A revision number of the task, 1..task.revision; its text is returned whole. */
  revision?: number
}

const unknownRevision = (value: unknown) => new Error(`Unknown revision of this task: ${String(value)}`)

/** `value` when it is an integer in `low..high`, else the refusal naming it. */
function inRange(value: number, low: number, high: number): number {
  if (!Number.isInteger(value) || value < low || value > high) throw unknownRevision(value)
  return value
}

/** The window, its bounds, and (when `request.revision` names one) that revision whole. */
export function revisionDetail(db: Database, taskId: string, current: number, request: RevisionWindowRequest):
  { rows: AgentRevisionRow[]; bounds: AgentTaskBounds['revisions']; text?: AgentRevisionText } {
  const before = request.revisionsBefore === undefined ? null : inRange(request.revisionsBefore, 2, current)
  const selected = request.revision === undefined ? null : inRange(request.revision, 1, current)
  const rows = windowRows(db, taskId, before)
  const total = (db.prepare('SELECT COUNT(*) AS n FROM team_task_revisions WHERE task_id = ?').get(taskId) as { n: number }).n
  const oldest = rows[0]?.revision ?? null
  const olderRemaining = oldest !== null && (db.prepare('SELECT EXISTS(SELECT 1 FROM team_task_revisions WHERE task_id = ? AND revision < ?) AS older')
    .get(taskId, oldest) as { older: number }).older === 1
  return {
    rows,
    bounds: { total, returned: rows.length, truncated: olderRemaining, nextBefore: olderRemaining ? oldest : null },
    ...(selected === null ? {} : { text: wholeText(db, taskId, selected) }),
  }
}

/** The newest `REVISION_WINDOW` rows below `before` (or the newest), oldest first. */
function windowRows(db: Database, taskId: string, before: number | null): AgentRevisionRow[] {
  const found = db.prepare(`SELECT revision, author_kind, author_session, created_at, notify,
    CASE WHEN contract IS NOT NULL THEN contract_hash END AS contract_hash,
    length(CAST(direction AS BLOB)) AS direction_bytes, length(CAST(acceptance AS BLOB)) AS acceptance_bytes,
    length(CAST(rationale AS BLOB)) AS rationale_bytes, substr(CAST(rationale AS BLOB), 1, ${JOURNAL_PREVIEW_BYTES}) AS rationale_preview,
    direction, acceptance
    FROM team_task_revisions WHERE task_id = $task ${before === null ? '' : 'AND revision < $before'}
    ORDER BY revision DESC LIMIT ${REVISION_WINDOW}`)
    .all({ $task: taskId, ...(before === null ? {} : { $before: before }) }) as Record<string, unknown>[]
  return found.reverse().map(row => {
    const revision = Number(row.revision)
    const contractHash = typeof row.contract_hash === 'string' ? row.contract_hash : null
    const acceptance = row.acceptance === null || row.acceptance === undefined ? null : String(row.acceptance)
    // The text is hashed here and goes no further: the row keeps only lengths.
    const identity = identityOf({ revision, direction: String(row.direction), acceptance, contractHash })
    const rationaleBytes = row.rationale_bytes === null ? 0 : Number(row.rationale_bytes)
    const preview = row.rationale_bytes === null ? null : journalPreview(rationaleBytes, blobOf(row.rationale_preview, Math.min(rationaleBytes, JOURNAL_PREVIEW_BYTES)))
    return {
      revision, identity, contractHash,
      author: partyFromRow(row.author_kind, row.author_session),
      createdAt: String(row.created_at),
      notify: row.notify === null || row.notify === undefined ? null : Number(row.notify) === 1,
      directionBytes: Number(row.direction_bytes),
      acceptanceBytes: row.acceptance_bytes === null ? 0 : Number(row.acceptance_bytes),
      rationale: preview?.text ?? null, rationaleBytes, rationaleCut: preview?.cut ?? false,
    }
  })
}

function wholeText(db: Database, taskId: string, revision: number): AgentRevisionText {
  const row = db.prepare('SELECT direction, acceptance, rationale FROM team_task_revisions WHERE task_id = ? AND revision = ?')
    .get(taskId, revision) as Record<string, unknown> | null
  if (!row) throw unknownRevision(revision)
  const text = (value: unknown) => value === null || value === undefined ? null : String(value)
  return { revision, direction: String(row.direction), acceptance: text(row.acceptance), rationale: text(row.rationale) }
}

/**
 * The revisions' publication fields, without direction, acceptance, or
 * contract: all `publications` reads (D5) — whole rationale included, as
 * before. The text columns are never selected, so the unwindowed publication
 * section does not carry the revision text.
 */
export function publicationRevisions(db: Database, taskId: string): TaskRevision[] {
  const rows = db.prepare('SELECT revision, author_kind, author_session, created_at, rationale, notify FROM team_task_revisions WHERE task_id = ? ORDER BY revision')
    .all(taskId) as Record<string, unknown>[]
  // `publications` reads only these fields; the text fields it does not read stay empty.
  return rows.map(row => ({
    revision: Number(row.revision), direction: '', acceptance: null,
    author: partyFromRow(row.author_kind, row.author_session), createdAt: String(row.created_at),
    rationale: row.rationale === null ? null : String(row.rationale),
    notify: row.notify === null || row.notify === undefined ? null : Number(row.notify) === 1,
  }))
}
