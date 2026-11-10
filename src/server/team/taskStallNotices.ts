// Manual-task stall notices (manual-task-stall-alerts D2, D4). The enqueue
// listener only records candidate message ids per task. One coalesced
// `setImmediate` flush runs after the synchronous caller has committed or
// rolled back, and evaluates each candidate task in its own immediate
// transaction:
//   1. trigger check: a candidate row exists durably, from an agent or the
//      human, created after the task's anchor (a rolled-back enqueue leaves
//      no row; an old message's transition is never a candidate);
//   2. derive: `stallOf` over the task's progress and mail;
//   3. emit when due: `emitStallNotice` inserts the `(task_id, anchor_at)`
//      row and, only when the insert changed a row, journals and messages a
//      session creator.
// Nothing waits on a notice and nothing else changes (I1). A dropped flush
// is recovered by the next counted message, which derives the same anchor.
import { SYSTEM_ACTOR, type TeamMessage } from '../../shared/team'
import type { TeamTask } from '../../shared/teamTasks'
import { countsTowardStall, stallAnchor, stallOf, type StallAnchorKind, type StallMail } from '../../shared/taskStall'
import type { MailboxStore } from './mailboxStore'
import type { TaskStore } from './taskStore'

export const TASK_STALL_TAG = 'task-stall'

export interface StallEpisode {
  taskId: string
  anchorAt: string
  anchorKind: StallAnchorKind
  count: number
  senders: string[]
  elapsedMs: number
}

export interface StallNotice {
  episode: StallEpisode
  messageId: string | null
}

const ADVISORY_SECTION = '"Keep advisory checkpoints separate from final review" (docs/agent-collaboration.md)'

function duration(ms: number): string {
  const minutes = Math.floor(ms / 60_000)
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

function facts(episode: StallEpisode): string {
  return `${episode.count} messages from ${episode.senders.join(', ')} in ${duration(episode.elapsedMs)} since ${episode.anchorKind} at ${episode.anchorAt}, with no new revision, result, or counted review`
}

/**
 * Write one derived, due episode (design D2 step 3): the replay row, then,
 * only when it was new, the journal entry and the creator's message. Null
 * when the episode was already written (EF3).
 */
export function emitStallNotice(store: TaskStore, input: { task: TeamTask; originPath: string; episode: StallEpisode; now: string }): StallNotice | null {
  const { task, episode } = input
  return store.immediate(() => {
    const inserted = store.db.prepare(`INSERT OR IGNORE INTO team_task_stall_notices
      (task_id, anchor_at, anchor_kind, message_count, message_id, created_at) VALUES (?, ?, ?, ?, NULL, ?)`)
      .run(task.id, episode.anchorAt, episode.anchorKind, episode.count, input.now)
    if (inserted.changes === 0) return null
    store.appendJournal(task.id, SYSTEM_ACTOR, `Stall notice: ${facts(episode)}. Judge it by ${ADVISORY_SECTION}; nothing waits.`, input.now)
    const creator = task.creator.kind === 'agent' ? task.creator.sessionId : null
    const message = creator === null || !store.mail ? null : store.mail.enqueue({
      teamId: task.teamId, toKind: 'session', toId: creator, fromKind: 'system', fromSession: null, fromGroup: null,
      originPath: input.originPath, tags: [TASK_STALL_TAG], taskId: task.id, actor: 'system',
      body: [
        `Task "${task.title}" (${task.id}) has ${facts(episode)}.`,
        'No execution owns it, so nothing waits. Choose one: submit a complete result for formal review, journal the specific risk another advisory round targets, narrow the task, or escalate.',
        `The advisory budget is in ${ADVISORY_SECTION}.`,
      ].join('\n'),
    }, input.now)
    if (message) store.db.prepare('UPDATE team_task_stall_notices SET message_id = ? WHERE task_id = ? AND anchor_at = ?').run(message.id, task.id, episode.anchorAt)
    return { episode, messageId: message?.id ?? null }
  })
}

const newest = (store: TaskStore, sql: string, taskId: string): string | null =>
  (store.db.prepare(sql).get(taskId) as { at: string | null } | null)?.at ?? null

/** The task's stall inputs read now (D1); the mail after `anchorAt` only. */
function readStall(store: TaskStore, task: TeamTask, owned: boolean, now: string) {
  const reviews = store.findings.countedSubmissions(task.id).map(entry => entry.createdAt).sort()
  const progress = {
    createdAt: task.createdAt,
    revisionAt: newest(store, 'SELECT MAX(created_at) AS at FROM team_task_revisions WHERE task_id = ?', task.id),
    resultAt: newest(store, 'SELECT MAX(created_at) AS at FROM team_task_results WHERE task_id = ?', task.id),
    reviewAt: reviews.at(-1) ?? null,
    noticeAt: newest(store, 'SELECT MAX(created_at) AS at FROM team_task_stall_notices WHERE task_id = ?', task.id),
  }
  const { anchorAt } = stallAnchor(progress)
  const mail = (store.db.prepare(`SELECT created_at, from_kind, from_session, from_group FROM team_messages
    WHERE task_id = ? AND created_at > ? ORDER BY created_at, rowid`).all(task.id, anchorAt) as Array<Record<string, string | null>>)
    .map((row): StallMail => ({
      createdAt: String(row.created_at), fromKind: row.from_kind as StallMail['fromKind'],
      fromSession: row.from_session ?? null, fromGroup: row.from_group ?? null,
    }))
  return stallOf({ status: task.status, owned, ...progress, mail, now })
}

export interface TaskStallNoticesOptions {
  ownedByExecution: (taskId: string) => boolean
  now?: () => number
  onError?: (error: unknown) => void
}

/** The enqueue listener and its deferred flush (D2). `close` drops pending work. */
export class TaskStallNotices {
  private readonly pending = new Map<string, Set<string>>()
  private scheduled: ReturnType<typeof setImmediate> | null = null
  private readonly unsubscribe: () => void

  constructor(private readonly store: TaskStore, mail: MailboxStore, private readonly options: TaskStallNoticesOptions) {
    this.unsubscribe = mail.subscribeEnqueued(message => this.candidate(message))
  }

  private candidate(message: TeamMessage): void {
    if (message.taskId === null || !countsTowardStall(message)) return
    const ids = this.pending.get(message.taskId) ?? new Set<string>()
    ids.add(message.id)
    this.pending.set(message.taskId, ids)
    this.scheduled ??= setImmediate(() => this.flush())
  }

  /** Evaluate every candidate task now; each in its own transaction, errors caught per task. */
  flush(): StallNotice[] {
    if (this.scheduled !== null) clearImmediate(this.scheduled)
    this.scheduled = null
    const work = [...this.pending]
    this.pending.clear()
    const notices: StallNotice[] = []
    for (const [taskId, ids] of work) {
      try {
        const notice = this.evaluate(taskId, [...ids])
        if (notice) notices.push(notice)
      } catch (error) {
        this.options.onError?.(error)
      }
    }
    return notices
  }

  private evaluate(taskId: string, candidates: string[]): StallNotice | null {
    const store = this.store
    return store.immediate(() => {
      const task = store.get(taskId)
      if (!task) return null
      const nowIso = new Date(this.options.now?.() ?? Date.now()).toISOString()
      const state = readStall(store, task, this.options.ownedByExecution(taskId), nowIso)
      // Trigger check (D2 step 1): a durable counted candidate after the anchor.
      const marks = candidates.map(() => '?').join(', ')
      const trigger = store.db.prepare(`SELECT origin_path FROM team_messages WHERE id IN (${marks}) AND task_id = ?
        AND from_kind IN ('agent', 'human') AND created_at > ? ORDER BY created_at DESC, rowid DESC LIMIT 1`)
        .get(...candidates, taskId, state.anchorAt) as { origin_path: string } | null
      if (trigger === null || !state.due) return null
      const { anchorAt, anchorKind, count, senders, elapsedMs } = state
      return emitStallNotice(store, { task, originPath: trigger.origin_path, now: nowIso, episode: { taskId, anchorAt, anchorKind, count, senders, elapsedMs } })
    })
  }

  close(): void {
    this.unsubscribe()
    if (this.scheduled !== null) clearImmediate(this.scheduled)
    this.scheduled = null
    this.pending.clear()
  }
}
