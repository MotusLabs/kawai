// The agent's bounded task sections (bounded-task-reads D5–D10), run inside
// `TaskJournalWindow.agentDetail`'s one synchronous read transaction.
// - Every growing list is a SQL window: newest first by `(created_at, rowid)`
//   (publications by revision number), `LIMIT n + 1` so the extra row says
//   whether older rows remain, strictly older than an anchor of the task.
//   An anchor that is not the task's — unknown, foreign, or malformed — is
//   refused naming it before any window is read.
// - Long text reaches JavaScript only as byte projections: message bodies,
//   result summaries, and publication rationales as 2,000-byte previews, the
//   diff of a whole result as an 8,192-byte preview. Assignment rows never
//   select their instruction; `task.assignment` keeps the current one's.
// - The outstanding result is whole and never consumes history capacity;
//   `result_id` returns one result whole as `resultDetail`. Both pass through
//   the caller's seal here, in the transaction. Rows carry no maps.
import type { Database } from 'bun:sqlite'
import type {
  AcknowledgementKey, AgentAssignmentRow, AgentPublication, AgentResultRow, AgentTaskMessage, AgentTaskRow,
  AgentWholeResult, AnchoredBound, TaskAcknowledgement, TaskResult, TaskRevision, TeamTask,
} from '../../shared/teamTasks'
import { rawCoverage } from '../../shared/coverageMaps'
import { actorFromRow, partyFromRow } from './actorRow'
import type { MailboxStore } from './mailboxStore'
import { AGENT_ROW_COLUMNS, agentTaskRow } from './taskAgentRow'
import { JOURNAL_PREVIEW_BYTES, blobOf, bytePreview, utf8Exact } from './taskJournalWindow'
import type { TaskStore } from './taskStore'

export const SUBTASK_WINDOW = 100
export const MESSAGE_WINDOW = 50
export const RESULT_WINDOW = 50
export const HISTORY_WINDOW = 50
export const DIFF_PREVIEW_BYTES = 8192

/** The section arguments of `task_get` (D5–D9); each anchor names a row of the task. */
export interface TaskReadRequest {
  subtasksBefore?: string
  messagesBefore?: string
  /** Whole bodies in the same message window (D6); false by default. */
  fullMessages?: boolean
  resultsBefore?: string
  resultId?: string
  assignmentsBefore?: string
  publicationsBefore?: number
  acknowledgementsBefore?: AcknowledgementKey
}

/** The caller's blind-first seal over whole results (independent-verification D6); synchronous. */
export type WholeResultSeal = <R extends TaskResult>(results: R[]) => R[]

type Anchor = { at: string; rowid: number }
const OLDER = 'AND (created_at < $at OR (created_at = $at AND rowid < $rowid))'
const anchorParams = (anchor: Anchor | null): Record<string, string | number> => (anchor ? { $at: anchor.at, $rowid: anchor.rowid } : {})
const count = (db: Database, sql: string, ...params: Array<string | number | null>) =>
  (db.prepare(sql).get(...params) as { n: number }).n
const bound = <K>(total: number, returned: number, truncated: boolean, oldest: K | null | undefined): AnchoredBound<K> =>
  ({ total, returned, truncated, nextBefore: truncated && oldest !== undefined && oldest !== null ? oldest : null })

/** A 2,000-byte preview of a projected column, or null text with zero bytes when the column is NULL. */
function textPreview(totalValue: unknown, projected: unknown): { text: string | null; bytes: number; cut: boolean } {
  if (totalValue === null || totalValue === undefined) return { text: null, bytes: 0, cut: false }
  const total = Number(totalValue)
  const preview = bytePreview(total, blobOf(projected, Math.min(total, JOURNAL_PREVIEW_BYTES)), JOURNAL_PREVIEW_BYTES)
  return { text: preview.text, bytes: total, cut: preview.cut }
}

/** D5: the newest 100 subtasks older than the anchor, as `task_list` rows, oldest first. */
export function subtaskWindow(db: Database, store: TaskStore, taskId: string, before?: string): { rows: AgentTaskRow[]; bounds: AnchoredBound<string> } {
  const anchor = before === undefined ? null : db.prepare('SELECT created_at AS at, rowid FROM team_tasks WHERE id = ? AND parent_id = ?')
    .get(before, taskId) as Anchor | null
  if (before !== undefined && !anchor) throw new Error(`Unknown subtask of this task: ${before}`)
  const found = db.prepare(`SELECT ${AGENT_ROW_COLUMNS} FROM team_tasks WHERE parent_id = $task ${anchor ? OLDER : ''}
    ORDER BY created_at DESC, rowid DESC LIMIT $take`).all({ $task: taskId, $take: SUBTASK_WINDOW + 1, ...anchorParams(anchor) }) as Record<string, unknown>[]
  const rows = found.slice(0, SUBTASK_WINDOW).reverse().map(row => agentTaskRow(store, row))
  const total = count(db, 'SELECT COUNT(*) AS n FROM team_tasks WHERE parent_id = ?', taskId)
  return { rows, bounds: bound(total, rows.length, found.length > SUBTASK_WINDOW, rows[0]?.id) }
}

/** D6: the newest 50 messages older than the anchor, oldest first, bodies previewed (or whole). */
export function messageWindow(db: Database, mail: MailboxStore | undefined, taskId: string, before?: string, full = false):
  { rows: AgentTaskMessage[]; bounds: AnchoredBound<string> } {
  const anchor = before === undefined || !mail ? null : mail.taskAnchor(taskId, before)
  if (before !== undefined && !anchor) throw new Error(`Unknown message of this task: ${before}`)
  if (!mail) return { rows: [], bounds: { total: 0, returned: 0, truncated: false, nextBefore: null } }
  const found = mail.forTaskNewest(taskId, MESSAGE_WINDOW + 1, { before: anchor, previewBytes: full ? null : JOURNAL_PREVIEW_BYTES })
  const rows = found.slice(0, MESSAGE_WINDOW).reverse().map(({ message, bodyBytes, body }): AgentTaskMessage => {
    if (full) return { ...message, body: utf8Exact(blobOf(body, bodyBytes)), bodyBytes, bodyCut: false }
    const preview = bytePreview(bodyBytes, blobOf(body, Math.min(bodyBytes, JOURNAL_PREVIEW_BYTES)), JOURNAL_PREVIEW_BYTES)
    return { ...message, body: preview.text, bodyBytes, bodyCut: preview.cut }
  })
  const total = count(db, 'SELECT COUNT(*) AS n FROM team_messages WHERE task_id = ?', taskId)
  return { rows, bounds: bound(total, rows.length, found.length > MESSAGE_WINDOW, rows[0]?.id) }
}

/** One result of the task whole, as readers map it, with its diff an 8,192-byte preview (D8). */
function wholeResult(store: TaskStore, taskId: string, resultId: string): AgentWholeResult | null {
  const projected = store.results.getWithDiffProjection(taskId, resultId, DIFF_PREVIEW_BYTES)
  if (!projected) return null
  const { result, diffNull, diffBytes } = projected
  const preview = diffNull ? null : bytePreview(diffBytes, blobOf(projected.diff, Math.min(diffBytes, DIFF_PREVIEW_BYTES)), DIFF_PREVIEW_BYTES)
  return {
    ...result,
    checks: store.checks.viewForResult(result.id),
    reviewerMaps: store.results.reviewerMapsOf(result.id, rawCoverage(result.coverage)),
    diff: preview?.text ?? null, diffBytes, diffCut: preview?.cut ?? false, diffResumeOffsetBytes: preview?.resumeOffsetBytes ?? 0,
  }
}

/**
 * D8: the outstanding result whole, then the newest 50 other results older
 * than the anchor as rows, newest first; with `resultId`, that result whole.
 * Every whole result passes through `seal`.
 */
export function resultWindow(db: Database, store: TaskStore, taskId: string, request: Pick<TaskReadRequest, 'resultsBefore' | 'resultId'>, seal: WholeResultSeal):
  { results: Array<AgentWholeResult | AgentResultRow>; resultDetail?: AgentWholeResult; bounds: AnchoredBound<string> } {
  const outstanding = store.results.outstandingId(taskId)
  const resultAnchor = (id: string) => db.prepare('SELECT created_at AS at, rowid FROM team_task_results WHERE id = ? AND task_id = ?')
    .get(id, taskId) as Anchor | null
  const before = request.resultsBefore
  const anchor = before === undefined || before === outstanding ? null : resultAnchor(before)
  if (before !== undefined && !anchor) throw new Error(`Unknown result of this task: ${before}`)
  const selected = request.resultId
  if (selected !== undefined && !resultAnchor(selected)) throw new Error(`Unknown result of this task: ${selected}`)
  const found = db.prepare(`SELECT id, commit_ref, task_revision, submitted_by_kind, submitted_by_session, accepted_at, created_at,
    length(CAST(summary AS BLOB)) AS summary_bytes, substr(CAST(summary AS BLOB), 1, ${JOURNAL_PREVIEW_BYTES}) AS summary_preview,
    (SELECT s.id FROM team_task_results s WHERE s.supersedes_result_id = r.id ORDER BY s.created_at, s.rowid LIMIT 1) AS superseded_by
    FROM team_task_results r WHERE task_id = $task AND id IS NOT $outstanding ${anchor ? OLDER : ''}
    ORDER BY created_at DESC, rowid DESC LIMIT $take`)
    .all({ $task: taskId, $outstanding: outstanding, $take: RESULT_WINDOW + 1, ...anchorParams(anchor) }) as Record<string, unknown>[]
  const rows = found.slice(0, RESULT_WINDOW).map((row): AgentResultRow => {
    const summary = textPreview(row.summary_bytes, row.summary_preview)
    const id = String(row.id)
    return {
      id, commit: row.commit_ref === null ? null : String(row.commit_ref), taskRevision: Number(row.task_revision),
      submittedBy: actorFromRow(row.submitted_by_kind, row.submitted_by_session),
      supersededBy: row.superseded_by === null ? null : String(row.superseded_by),
      acceptedAt: row.accepted_at === null ? null : String(row.accepted_at),
      reviewVerdict: store.results.reviewVerdict(taskId, id), createdAt: String(row.created_at),
      summary: summary.text, summaryBytes: summary.bytes, summaryCut: summary.cut,
    }
  })
  const total = count(db, 'SELECT COUNT(*) AS n FROM team_task_results WHERE task_id = ? AND id IS NOT ?', taskId, outstanding)
  const whole = outstanding === null ? [] : seal([wholeResult(store, taskId, outstanding)!])
  const detail = selected === undefined ? undefined : seal([wholeResult(store, taskId, selected)!])[0]
  return {
    results: [...whole, ...rows],
    ...(detail ? { resultDetail: detail } : {}),
    bounds: bound(total, rows.length, found.length > RESULT_WINDOW, rows.at(-1)?.id),
  }
}

/** D9: the newest 50 assignments older than the anchor, oldest first, without instructions. */
export function assignmentWindow(db: Database, store: TaskStore, taskId: string, before?: string): { rows: AgentAssignmentRow[]; bounds: AnchoredBound<string> } {
  const assignments = store.assignments
  const anchor = before === undefined || !assignments ? null : assignments.taskAnchor(taskId, before)
  if (before !== undefined && !anchor) throw new Error(`Unknown assignment of this task: ${before}`)
  if (!assignments) return { rows: [], bounds: { total: 0, returned: 0, truncated: false, nextBefore: null } }
  const found = assignments.windowByTask(taskId, anchor, HISTORY_WINDOW + 1)
  const rows = found.slice(0, HISTORY_WINDOW).reverse()
  const total = count(db, 'SELECT COUNT(*) AS n FROM team_task_assignments WHERE task_id = ?', taskId)
  return { rows, bounds: bound(total, rows.length, found.length > HISTORY_WINDOW, rows[0]?.id) }
}

/**
 * D9: the newest 50 publications (revisions after the first) below the
 * anchor revision, oldest first, each with its current recipients and a
 * 2,000-byte rationale preview; `revision` reads a rationale whole.
 */
export function publicationWindow(db: Database, store: TaskStore, task: TeamTask, before?: number): { rows: AgentPublication[]; bounds: AnchoredBound<number> } {
  if (before !== undefined && (!Number.isInteger(before) || before < 2 || before > task.revision)) {
    throw new Error(`Unknown publication of this task: ${String(before)}`)
  }
  if (!store.notices) return { rows: [], bounds: { total: 0, returned: 0, truncated: false, nextBefore: null } }
  const found = db.prepare(`SELECT revision, author_kind, author_session, created_at, notify,
    length(CAST(rationale AS BLOB)) AS rationale_bytes, substr(CAST(rationale AS BLOB), 1, ${JOURNAL_PREVIEW_BYTES}) AS rationale_preview
    FROM team_task_revisions WHERE task_id = $task AND revision >= 2 ${before === undefined ? '' : 'AND revision < $before'}
    ORDER BY revision DESC LIMIT $take`)
    .all({ $task: task.id, $take: HISTORY_WINDOW + 1, ...(before === undefined ? {} : { $before: before }) }) as Record<string, unknown>[]
  const kept = found.slice(0, HISTORY_WINDOW).reverse()
  // The publications' recipients are derived as before; the rationale text never reaches them.
  const revisions: TaskRevision[] = kept.map(row => ({
    revision: Number(row.revision), direction: '', acceptance: null, author: partyFromRow(row.author_kind, row.author_session),
    createdAt: String(row.created_at), rationale: null,
    notify: row.notify === null || row.notify === undefined ? null : Number(row.notify) === 1,
  }))
  const rows = store.notices.publications(task, revisions).map((publication, i): AgentPublication => {
    const rationale = textPreview(kept[i]!.rationale_bytes, kept[i]!.rationale_preview)
    return { ...publication, rationale: rationale.text, rationaleBytes: rationale.bytes, rationaleCut: rationale.cut }
  })
  const total = count(db, 'SELECT COUNT(*) AS n FROM team_task_revisions WHERE task_id = ? AND revision >= 2', task.id)
  return { rows, bounds: bound(total, rows.length, found.length > HISTORY_WINDOW, rows[0]?.revision) }
}

/** D9: the newest 50 acknowledgements older than the anchor key, oldest first. */
export function acknowledgementWindow(db: Database, taskId: string, before?: AcknowledgementKey):
  { rows: TaskAcknowledgement[]; bounds: AnchoredBound<AcknowledgementKey> } {
  const anchor = before === undefined ? null : db.prepare(`SELECT created_at AS at, rowid FROM team_task_acknowledgements
    WHERE task_id = ? AND session_id = ? AND revision = ?`).get(taskId, String(before.sessionId), Number(before.revision)) as Anchor | null
  if (before !== undefined && (!anchor || !Number.isInteger(before.revision))) {
    throw new Error(`Unknown acknowledgement of this task: ${String(before.sessionId)} revision ${String(before.revision)}`)
  }
  const found = db.prepare(`SELECT session_id, revision, assignment_id, created_at FROM team_task_acknowledgements
    WHERE task_id = $task ${anchor ? OLDER : ''} ORDER BY created_at DESC, rowid DESC LIMIT $take`)
    .all({ $task: taskId, $take: HISTORY_WINDOW + 1, ...anchorParams(anchor) }) as Record<string, unknown>[]
  const rows = found.slice(0, HISTORY_WINDOW).reverse().map(row => ({
    sessionId: String(row.session_id), revision: Number(row.revision),
    assignmentId: row.assignment_id === null ? null : String(row.assignment_id), createdAt: String(row.created_at),
  }))
  const total = count(db, 'SELECT COUNT(*) AS n FROM team_task_acknowledgements WHERE task_id = ?', taskId)
  const oldest = rows[0] ? { sessionId: rows[0].sessionId, revision: rows[0].revision } : undefined
  return { rows, bounds: bound(total, rows.length, found.length > HISTORY_WINDOW, oldest) }
}
