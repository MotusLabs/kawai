// The facts a handoff's readers derive from (owner-publication-handoff D5,
// D6, D9): one liveness predicate for every reader, a published handoff's
// follow-up facts (claimant, delivered and acknowledged revisions, and every
// notice at the published revision or later), and a pending handoff's
// supervision fact with its next actor. Attention, the supervision loader
// and `task_get` call `handoffPhase` / `pendingHandoffActor` over these
// (contract I5). Reads only.
import type { Database } from 'bun:sqlite'
import type { MessageState } from '../../shared/team'
import {
  pendingHandoffActor, type HandoffFollowUpFacts, type HandoffNextActor, type HandoffNoticeState, type TaskHandoff,
} from '../../shared/taskHandoffs'
import type { TeamTask } from '../../shared/teamTasks'
import type { ChatSessionRecord } from '../db'
import type { MailboxStore } from './mailboxStore'
import type { TaskAcknowledgements } from './taskAcknowledgements'
import type { TaskNotices } from './taskNotices'

/** Live (D6): the record present, neither archived nor context-exhausted. */
export const liveRecord = (record: Pick<ChatSessionRecord, 'archivedAt' | 'contextExhausted'> | null | undefined): boolean =>
  !!record && !record.archivedAt && !record.contextExhausted

// The notice states exactly as `taskNotices.ts` derives them (its
// `noticeState`); P7b checks the parity against the real `notify`.
const PENDING: ReadonlySet<MessageState> = new Set(['queued', 'claimed', 'spawning', 'awaiting-request', 'parked'])
const FAILED: ReadonlySet<MessageState> = new Set(['dead', 'cancelled', 'discarded', 'forwarded'])
function noticeStateOf(state: MessageState): HandoffNoticeState {
  if (PENDING.has(state)) return 'queued'
  if (state === 'delivered') return 'delivered'
  if (state === 'uncertain') return 'uncertain'
  return FAILED.has(state) ? 'failed' : 'queued'
}

export interface FollowUpReads {
  db: Database
  mail: Pick<MailboxStore, 'get'>
  notices: Pick<TaskNotices, 'holders' | 'deliveredRevision'>
  acknowledgements: Pick<TaskAcknowledgements, 'highest'>
  live: (sessionId: string) => boolean
}

/** A published handoff's follow-up facts (D5); `handoffPhase` reads them. */
export function followUpFacts(reads: FollowUpReads, handoff: TaskHandoff, task: Pick<TeamTask, 'id' | 'status'>): HandoffFollowUpFacts {
  const revision = handoff.publishedRevision ?? 0
  const holder = reads.notices.holders(task.id)[0] ?? null
  const rows = holder === null ? [] : reads.db.prepare(`SELECT message_id FROM team_task_notifications
    WHERE task_id = ? AND recipient_session = ? AND revision >= ? ORDER BY created_at, rowid`).all(task.id, holder.sessionId, revision) as Array<{ message_id: string }>
  return {
    publishedRevision: revision,
    taskClosed: task.status === 'done' || task.status === 'cancelled',
    claimant: holder === null ? null : { sessionId: holder.sessionId, live: reads.live(holder.sessionId) },
    deliveredRevision: holder === null ? null : reads.notices.deliveredRevision(task.id, holder.sessionId),
    acknowledgedRevision: holder === null ? null : reads.acknowledgements.highest(task.id, holder.sessionId),
    notices: rows.flatMap(row => {
      const message = reads.mail.get(row.message_id)
      return message ? [{ state: noticeStateOf(message.state), messageId: message.id }] : []
    }),
  }
}

/** The supervision input's handoff fact (D9): the task's pending handoff and its next actor. */
export interface PendingHandoffFact {
  id: string
  state: 'open' | 'stale'
  baseRevision: number
  nextActor: HandoffNextActor
}

/** The task's one pending (open or stale) handoff with W1–W4's next actor, or null: a published handoff is no wait (S7), so no published phase is projected here (read inside the caller's transaction). */
export function pendingHandoffFact(db: Database, taskId: string, live: (sessionId: string) => boolean): PendingHandoffFact | null {
  const row = db.prepare(`SELECT h.id, h.state, h.base_revision, h.requester_session, h.requester_group, t.owner_session
    FROM team_task_handoffs h JOIN team_tasks t ON t.id = h.task_id WHERE h.task_id = ? AND h.state IN ('open', 'stale')`).get(taskId) as {
    id: string; state: 'open' | 'stale'; base_revision: number; requester_session: string; requester_group: string | null; owner_session: string | null
  } | null
  if (row === null) return null
  const owner = row.owner_session !== null && live(row.owner_session) ? row.owner_session : null
  return {
    id: row.id, state: row.state, baseRevision: Number(row.base_revision),
    nextActor: pendingHandoffActor({ state: row.state, requesterSession: row.requester_session, requesterGroup: row.requester_group }, owner, live(row.requester_session)),
  }
}
