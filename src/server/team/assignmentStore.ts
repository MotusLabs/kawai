// Durable task assignments (task-assignment design D1/D5): one row per
// dispatch, append-only like the rest of the task schema, kept separate from
// the derived participant list. The row records what the human asked for —
// target (a group, its role, or a session), the instruction verbatim, the
// request identity, and supersession — while the *state* is never stored:
// `assignmentState` derives it at read time from the instruction mail, so the
// assignment can never disagree with the mailbox. Claims are copied onto the
// row from the mail (the claim is a durable fact of accountability even after
// the mail settles) and cleared again when the mail's claim is cleared by
// release or requeue. The store is policy-free; AssignmentService decides who
// may dispatch. The store writes no `team_messages` schema of its own — the
// sender columns it reads are `team-message-threads`', used as shipped.
import type { Database } from 'bun:sqlite'
import type { MessageState, TeamMessage } from '../../shared/team'
import type { TaskCreator, TaskHandoffKind, TeamTaskAssignment } from '../../shared/teamTasks'
import { partyFromRow } from './actorRow'
import { TASK_HANDOFF_KINDS } from '../../shared/teamTasks'
import type { MailboxStore } from './mailboxStore'
import { migrateHandoffColumns } from './taskResultSchema'

/** Derived at read time from the instruction mail (design D5). */
export type AssignmentState = 'queued' | 'claimed' | 'delivered' | 'failed' | 'superseded' | 'parked' | 'forwarded' | 'uncertain'

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS team_task_assignments (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  request_key TEXT NOT NULL,
  target_kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  role TEXT,
  instruction TEXT NOT NULL,
  created_by_kind TEXT NOT NULL,
  created_by_session TEXT,
  message_id TEXT,
  claimed_by TEXT,
  claimed_at TEXT,
  superseded_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS team_task_assignments_key ON team_task_assignments (team_id, request_key);
CREATE INDEX IF NOT EXISTS team_task_assignments_task ON team_task_assignments (task_id, created_at);
`

export interface DispatchInsert {
  teamId: string
  taskId: string
  requestKey: string
  targetKind: 'group' | 'session'
  targetId: string
  /** The requested role: the group id when one is known; null for a groupless session. */
  role: string | null
  instruction: string
  creator: TaskCreator
  /** The enqueued instruction mail, once the dispatch transaction adds it. */
  messageId?: string | null
  /** A handoff's kind, referenced result, and expected response (task-results-handoffs D1). */
  handoff?: DispatchHandoff
  /** The canonical worker selector of a group dispatch (dispatch-worker-choice D1). */
  workerChoice?: string | null
}

/** A handoff's fields on its assignment (task-results-handoffs D3). */
export interface DispatchHandoff {
  kind: TaskHandoffKind
  resultId: string
  expectedResponse: string | null
}

/**
 * Which handoff field differs between a stored assignment and a replayed
 * intent (task-results-handoffs D3, extending D4's payload identity): a
 * replay carrying another result, kind, or expected response is refused. The
 * one comparison both D4 sites — this store's insert-then-read and
 * AssignmentService's pre-check — use.
 */
export function handoffDiff(existing: Pick<TeamTaskAssignment, 'handoffKind' | 'resultId' | 'expectedResponse'>, handoff: DispatchHandoff | null): string | null {
  if ((existing.handoffKind ?? null) !== (handoff?.kind ?? null)) return 'handoff kind'
  if ((existing.resultId ?? null) !== (handoff?.resultId ?? null)) return 'result'
  if ((existing.expectedResponse ?? null) !== (handoff?.expectedResponse ?? null)) return 'expected response'
  return null
}

export type InsertOutcome =
  | { replay: false; assignment: TeamTaskAssignment }
  | { replay: true; assignment: TeamTaskAssignment }

/** Mail states that leave an assignment's standing (design D5). */
const FAILED_STATES: ReadonlySet<MessageState> = new Set(['dead', 'cancelled', 'discarded'])
const QUEUED_STATES: ReadonlySet<MessageState> = new Set(['queued', 'spawning', 'awaiting-request'])

const nowIso = () => new Date().toISOString()

/**
 * Map an assignment row and its instruction mail to the derived state. Pure:
 * the row's supersession wins over everything; otherwise the mail's state
 * decides, with the post-delivery limit states keeping their own names so
 * nothing falls through. A missing mail row cannot happen for a committed
 * dispatch (both rows are one transaction, D3); it reads as failed so it can
 * never silently look busy.
 */
export function assignmentState(row: Pick<TeamTaskAssignment, 'supersededBy'>, message: TeamMessage | null): { state: AssignmentState; reason: string | null } {
  if (row.supersededBy !== null) return { state: 'superseded', reason: null }
  if (!message) return { state: 'failed', reason: 'instruction-missing' }
  const { state } = message
  if (QUEUED_STATES.has(state)) return { state: 'queued', reason: null }
  if (state === 'claimed' || state === 'delivered' || state === 'parked' || state === 'forwarded' || state === 'uncertain') {
    return { state, reason: message.reason }
  }
  if (FAILED_STATES.has(state)) return { state: 'failed', reason: message.reason ?? state }
  return { state: 'failed', reason: message.reason ?? state }
}

/** The newest row for the task that is neither superseded nor failed. */
export function outstandingOf(rows: TeamTaskAssignment[]): TeamTaskAssignment | null {
  return rows.filter(row => row.supersededBy === null && row.state !== 'failed').at(-1) ?? null
}

/** Create the table; part of the frozen baseline step (execution-safety-recovery D13): the baseline step calls this, never the store. */
export function ensureAssignmentSchema(db: Database): void {
  db.exec(CREATE_TABLE_SQL)
  // Handoff columns (task-results-handoffs D1): this store owns the table's reads.
  migrateHandoffColumns(db)
}

export class AssignmentStore {
  constructor(private readonly db: Database, private readonly mail?: MailboxStore) {
    // Claim copies follow the mail wherever its claim moves (design D5):
    // set when the dispatcher claims, cleared again by release or requeue.
    this.mailSubscription = mail?.subscribe((_teamId, message) => { if (message) this.syncFromMail(message) })
  }

  private readonly mailSubscription?: () => void

  close(): void {
    this.mailSubscription?.()
  }

  /**
   * Insert one dispatch under its request key (design D4): insert-then-read.
   * A same-payload replay returns the prior row as the outcome; a different
   * payload under the same key is refused naming the differing field. Payload
   * identity covers the request fields — target and instruction — and, for a
   * handoff, its kind, referenced result, and expected response.
   */
  insert(input: DispatchInsert, now = nowIso()): InsertOutcome {
    const id = `assignment-${crypto.randomUUID()}`
    const inserted = this.db.prepare(`INSERT OR IGNORE INTO team_task_assignments
      (id, team_id, task_id, request_key, target_kind, target_id, role, instruction, created_by_kind, created_by_session, message_id,
       handoff_kind, result_id, expected_response, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, input.teamId, input.taskId, input.requestKey, input.targetKind, input.targetId, input.role,
      input.instruction, input.creator.kind, input.creator.sessionId, input.messageId ?? null,
      input.handoff?.kind ?? null, input.handoff?.resultId ?? null, input.handoff?.expectedResponse ?? null, now, now,
    ).changes
    if (inserted === 1) {
      // Written beside the insert, inside the caller's dispatch transaction.
      if (input.workerChoice) this.db.prepare('UPDATE team_task_assignments SET worker_choice = ? WHERE id = ?').run(input.workerChoice, id)
      return { replay: false, assignment: this.row(id)! }
    }
    const existing = this.byKey(input.teamId, input.requestKey)
    if (!existing) throw new Error('request key reuse could not be resolved; retry')
    const diff = this.payloadDiff(existing, input)
    if (diff) throw new Error(`Request key already used with a different ${diff}`)
    return { replay: true, assignment: existing }
  }

  /** Link the instruction mail to a just-inserted row (same transaction). */
  setMessage(id: string, messageId: string): void {
    this.db.prepare('UPDATE team_task_assignments SET message_id = ?, updated_at = ? WHERE id = ?').run(messageId, nowIso(), id)
  }

  /** Record the replacing assignment; supersession is terminal for the row. */
  supersede(id: string, supersededBy: string, now = nowIso()): boolean {
    return this.db.prepare('UPDATE team_task_assignments SET superseded_by = ?, updated_at = ? WHERE id = ? AND superseded_by IS NULL')
      .run(supersededBy, now, id).changes === 1
  }

  /** The assignment whose instruction mail is this message, if any. */
  byMessage(messageId: string): TeamTaskAssignment | null {
    const row = this.db.prepare('SELECT id FROM team_task_assignments WHERE message_id = ?').get(messageId)
    return row ? this.row(String((row as Record<string, unknown>).id)) : null
  }

  /** A team's assignment under a request key (idempotency reads). */
  byKey(teamId: string, requestKey: string): TeamTaskAssignment | null {
    const row = this.db.prepare('SELECT id FROM team_task_assignments WHERE team_id = ? AND request_key = ?').get(teamId, requestKey)
    return row ? this.row(String((row as Record<string, unknown>).id)) : null
  }

  /** Every assignment of a task, oldest first, with derived state. */
  listByTask(taskId: string): TeamTaskAssignment[] {
    const rows = this.db.prepare('SELECT id FROM team_task_assignments WHERE task_id = ? ORDER BY created_at, rowid')
      .all(taskId) as Array<{ id: string }>
    return rows.map(row => this.row(String(row.id))!)
  }

  private row(id: string): TeamTaskAssignment | null {
    const raw = this.db.prepare('SELECT * FROM team_task_assignments WHERE id = ?').get(id) as Record<string, unknown> | null
    if (!raw) return null
    const message = raw.message_id === null ? null : this.mail?.get(String(raw.message_id)) ?? null
    const actor = partyFromRow(raw.created_by_kind, raw.created_by_session)
    const { state, reason } = assignmentState({ supersededBy: raw.superseded_by === null ? null : String(raw.superseded_by) }, message)
    return {
      id: String(raw.id),
      taskId: String(raw.task_id),
      requestKey: String(raw.request_key),
      targetKind: raw.target_kind === 'group' ? 'group' : 'session',
      targetId: String(raw.target_id),
      role: raw.role === null ? null : String(raw.role),
      instruction: String(raw.instruction),
      createdBy: actor,
      messageId: raw.message_id === null ? null : String(raw.message_id),
      claimedBy: raw.claimed_by === null ? null : String(raw.claimed_by),
      claimedAt: raw.claimed_at === null ? null : String(raw.claimed_at),
      supersededBy: raw.superseded_by === null ? null : String(raw.superseded_by),
      state,
      reason,
      createdAt: String(raw.created_at),
      updatedAt: String(raw.updated_at),
      handoffKind: TASK_HANDOFF_KINDS.includes(raw.handoff_kind as TaskHandoffKind) ? raw.handoff_kind as TaskHandoffKind : null,
      resultId: raw.result_id === null || raw.result_id === undefined ? null : String(raw.result_id),
      expectedResponse: raw.expected_response === null || raw.expected_response === undefined ? null : String(raw.expected_response),
      // Absent, not null, without a choice: the row reads as before (D1).
      ...(typeof raw.worker_choice === 'string' && raw.worker_choice !== '' ? { workerChoice: raw.worker_choice } : {}),
    }
  }

  /** Which normalized request field differs between a row and a new intent. */
  private payloadDiff(existing: TeamTaskAssignment, input: DispatchInsert): string | null {
    if (existing.targetKind !== input.targetKind) return 'target'
    if (existing.targetId !== input.targetId) return 'target'
    if (existing.instruction !== input.instruction) return 'instruction'
    return handoffDiff(existing, input.handoff ?? null)
  }

  /**
   * Copy the mail's claim onto its assignment row — or clear the copy when
   * the mail's claim was cleared (release, requeue). Past claimants remain in
   * the mail's append-only event history (`team-message-threads` D2). The
   * guard keeps `updated_at` still while the claim has not moved.
   */
  private syncFromMail(message: TeamMessage): void {
    const row = this.db.prepare('SELECT id FROM team_task_assignments WHERE message_id = ?').get(message.id)
    if (!row) return
    const id = String((row as Record<string, unknown>).id)
    this.db.prepare(`UPDATE team_task_assignments SET claimed_by = ?, claimed_at = ?, updated_at = ?
      WHERE id = ? AND (claimed_by IS NOT ? OR claimed_at IS NOT ?)`)
      .run(message.claimedBy, message.claimedAt, nowIso(), id, message.claimedBy, message.claimedAt)
  }
}
