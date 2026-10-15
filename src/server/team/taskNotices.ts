// Revision notices (task-revision-publication design D3–D5). A notice is
// ordinary direct task mail — normal priority, tagged `task-revision`, with
// `revision_notice` naming the revision it announces — sent to the claimed
// agent of the task's outstanding assignment and recorded against that
// assignment under the command key that sent it. Never group mail: an
// unclaimed group assignment needs none, because its queued instruction is
// built with the newest revision when it is delivered. Notify and retry are
// one keyed command (D4) that never writes a revision. Notice state, the
// delivered revision, and the acknowledged revision are derived at read time
// from the mail and acknowledgement rows (D5) — never stored as state.
import type { Database } from 'bun:sqlite'
import type { MessageState, TeamMessage } from '../../shared/team'
import type { RevisionNoticeState, RevisionRecipient, TaskActor, TaskPublication, TaskRevision, TeamTask } from '../../shared/teamTasks'
import { outstandingOf, type AssignmentStore } from './assignmentStore'
import type { MailboxStore } from './mailboxStore'
import type { TaskAcknowledgements } from './taskAcknowledgements'

/** The tag every revision notice carries. */
export const REVISION_NOTICE_TAG = 'task-revision'

/** Who sends a notice: the publisher, stamped as the mail's sender. */
export interface NoticeSender {
  actor: TaskActor
  fromGroup: string | null
  originPath: string
}

/** One holder of the outstanding assignment: its current claimant. */
export interface NoticeHolder {
  assignmentId: string
  sessionId: string
}

export interface NoticeOptions {
  sender: NoticeSender
  requestKey: string
  /** Whether a session still exists; a notice to a killed claimant is dead-lettered at enqueue. */
  sessionExists: (sessionId: string) => boolean
}

/** A notice written by this command (or, on a replay, the one it wrote before). */
export interface SentNotice {
  sessionId: string
  messageId: string
}

const PENDING: ReadonlySet<MessageState> = new Set(['queued', 'claimed', 'spawning', 'awaiting-request', 'parked'])
const FAILED: ReadonlySet<MessageState> = new Set(['dead', 'cancelled', 'discarded', 'forwarded'])
const nowIso = () => new Date().toISOString()

function noticeState(message: TeamMessage | null): RevisionNoticeState {
  if (!message) return 'not-notified'
  if (PENDING.has(message.state)) return 'queued'
  if (message.state === 'delivered') return 'delivered'
  if (message.state === 'uncertain') return 'uncertain'
  return FAILED.has(message.state) ? 'failed' : 'queued'
}

const publisherLabel = (actor: TaskActor) => (actor.kind === 'human' ? 'the human' : actor.sessionId)

/** The fixed notice body (D3); the task header above it carries the revision to acknowledge. */
export function noticeBody(task: TeamTask, revision: TaskRevision, publisher: TaskActor): string {
  const reason = revision.rationale ? `: ${revision.rationale}` : ''
  return `Task ${task.title} revision ${revision.revision} published by ${publisherLabel(publisher)}${reason}. ` +
    'Read the direction above and call task_acknowledge(task_id, <revision in the header>) when you are working from it.'
}

export class TaskNotices {
  constructor(
    private readonly db: Database,
    private readonly mail: MailboxStore,
    private readonly assignments: AssignmentStore,
    private readonly acknowledgements: TaskAcknowledgements,
  ) {}

  /**
   * The executor to notify (D3, D6): the outstanding assignment's current
   * claimant, following work forwarded after a provider limit to its
   * successor's claimant. None while nobody holds it.
   */
  holders(taskId: string): NoticeHolder[] {
    const outstanding = outstandingOf(this.assignments.listByTask(taskId))
    if (!outstanding?.messageId) return []
    let message = this.mail.get(outstanding.messageId)
    for (let hop = 0; message?.state === 'forwarded' && hop < 20; hop++) message = this.successor(message.id)
    return message?.claimedBy ? [{ assignmentId: outstanding.id, sessionId: message.claimedBy }] : []
  }

  /**
   * Write a notice to each holder, inside the caller's transaction (the
   * publication's, D3, or notify's, D4). A killed holder's notice is
   * dead-lettered at once; the revision it announces stands either way.
   */
  write(task: TeamTask, revision: TaskRevision, options: NoticeOptions, holders = this.holders(task.id)): SentNotice[] {
    return holders.map(holder => {
      const { sender } = options
      const message = this.mail.enqueue({
        teamId: task.teamId, toKind: 'session', toId: holder.sessionId,
        fromKind: sender.actor.kind, fromSession: sender.actor.sessionId, fromGroup: sender.fromGroup,
        originPath: sender.originPath, priority: 'normal', tags: [REVISION_NOTICE_TAG],
        body: noticeBody(task, revision, sender.actor), taskId: task.id,
        revisionNotice: {
          revision: revision.revision, previousRevision: revision.revision - 1,
          assignmentId: holder.assignmentId, rationale: revision.rationale ?? null,
        },
        ...(sender.actor.kind === 'human' ? { actor: 'human' as const } : {}),
      })
      if (!options.sessionExists(holder.sessionId)) this.mail.deadLetter(message.id, 'killed-recipient')
      this.db.prepare(`INSERT INTO team_task_notifications
        (id, task_id, revision, assignment_id, recipient_session, message_id, request_key, created_by_kind, created_by_session, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        `notice-${crypto.randomUUID()}`, task.id, revision.revision, holder.assignmentId, holder.sessionId, message.id,
        options.requestKey, sender.actor.kind, sender.actor.sessionId, nowIso(),
      )
      return { sessionId: holder.sessionId, messageId: message.id }
    })
  }

  /**
   * Notify, or retry (D4): one keyed command that sends a notice to each
   * holder that has neither been delivered this revision (or a newer one)
   * nor holds a pending notice for it. A replay of the key returns what it
   * sent before. Never writes a revision.
   */
  notify(task: TeamTask, revision: TaskRevision, options: NoticeOptions): { replay: boolean; notices: SentNotice[] } {
    return this.db.transaction(() => {
      const prior = this.db.prepare('SELECT recipient_session, message_id FROM team_task_notifications WHERE task_id = ? AND request_key = ? ORDER BY rowid')
        .all(task.id, options.requestKey) as Array<{ recipient_session: string; message_id: string }>
      if (prior.length > 0) {
        return { replay: true, notices: prior.map(row => ({ sessionId: row.recipient_session, messageId: row.message_id })) }
      }
      const holders = this.holders(task.id).filter(holder => !this.reached(task.id, holder.sessionId, revision.revision))
      return { replay: false, notices: this.write(task, revision, options, holders) }
    })()
  }

  /** Per published revision after the first, its recipients (D5). */
  publications(task: TeamTask, revisions: TaskRevision[]): TaskPublication[] {
    const holders = this.holders(task.id)
    return revisions.filter(revision => revision.revision > 1).map(revision => ({
      revision: revision.revision, previousRevision: revision.revision - 1, author: revision.author,
      rationale: revision.rationale ?? null, notify: revision.notify ?? null, publishedAt: revision.createdAt,
      recipients: holders.map(holder => this.recipient(task.id, revision.revision, holder)),
    }))
  }

  /** One holder's notice state, delivered revision, and acknowledged revision — kept apart (D5). */
  private recipient(taskId: string, revision: number, holder: NoticeHolder): RevisionRecipient {
    const row = this.db.prepare(`SELECT message_id FROM team_task_notifications
      WHERE task_id = ? AND revision = ? AND recipient_session = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`)
      .get(taskId, revision, holder.sessionId) as { message_id: string } | null
    const message = row ? this.mail.get(row.message_id) : null
    const state = noticeState(message)
    return {
      assignmentId: holder.assignmentId, sessionId: holder.sessionId, noticeState: state,
      noticeMessageId: message?.id ?? null,
      reason: state === 'failed' || state === 'uncertain' ? message?.reason ?? message?.state ?? null : null,
      deliveredRevision: this.deliveredRevision(taskId, holder.sessionId),
      acknowledgedRevision: this.acknowledgements.highest(taskId, holder.sessionId),
    }
  }

  /** The highest task revision carried by task mail confirmed delivered to a session (D5). */
  deliveredRevision(taskId: string, sessionId: string): number | null {
    const row = this.db.prepare(`SELECT MAX(task_revision) AS revision FROM team_messages
      WHERE task_id = ? AND state = 'delivered' AND ((to_kind = 'session' AND to_id = ?) OR claimed_by = ?)`)
      .get(taskId, sessionId, sessionId) as { revision: number | null }
    return row.revision
  }

  /**
   * Whether a holder already has this revision: delivered it (or a newer
   * one), or holds a notice for it (or newer) that is still pending — or
   * uncertain, which the mailbox's own Retry/Discard resolves (D4).
   */
  private reached(taskId: string, sessionId: string, revision: number): boolean {
    if ((this.deliveredRevision(taskId, sessionId) ?? 0) >= revision) return true
    const rows = this.db.prepare('SELECT message_id FROM team_task_notifications WHERE task_id = ? AND recipient_session = ? AND revision >= ?')
      .all(taskId, sessionId, revision) as Array<{ message_id: string }>
    return rows.some(row => {
      const state = noticeState(this.mail.get(row.message_id))
      return state === 'queued' || state === 'uncertain'
    })
  }

  /** The message that carried forwarded work on (profile routing): a handoff reply to it. */
  private successor(messageId: string): TeamMessage | null {
    const row = this.db.prepare('SELECT id FROM team_messages WHERE in_reply_to = ? AND handoff IS NOT NULL ORDER BY created_at DESC, rowid DESC LIMIT 1')
      .get(messageId) as { id: string } | null
    return row ? this.mail.get(row.id) : null
  }
}
