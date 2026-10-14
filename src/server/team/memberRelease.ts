// Team member release (team-member-release design): pending releases are
// durable rows written in the transaction that closes a task (D1), a member
// is released — archived, never killed — once it is ready (D3, the one
// readiness definition every release path uses), inside the dispatch cycle
// before routing (D2), and a closed task's undelivered worktree mail is
// dead-lettered `task-closed` (D8) at the close and for late arrivals.
// `releaseByAgent` is the `release_member` service entry (D6): refused with
// a reason, never deferred. Reopening the task or restoring the member
// cancels a pending release; a human-created session is never released.
import type { Database } from 'bun:sqlite'
import type { ChatSessionRecord } from '../db'
import type { JournalAuthor, TaskActor, TaskStatus, TeamTask } from '../../shared/teamTasks'
import type { GroupDefinition } from './groupFile'
import type { MailboxStore } from './mailboxStore'
import type { TaskStore } from './taskStore'
import type { TeamIdentity } from './teamIdentity'

/** A pending release row (D1): one per session, written at the close. */
export interface PendingReleaseRow {
  sessionId: string
  taskId: string
  teamId: string
  reason: string
  requestedBy: JournalAuthor
  requestedAt: string
}

/** The one release-readiness answer (D3); `reason` names the first blocker. */
export type ReleaseReadiness = { ready: true } | { ready: false; reason: string }

/** The archive outcome: the manager's `ChatActionResult` shape. */
export type ArchiveResult = { ok: true } | { ok: false; error: string }

export interface MemberReleaseOptions {
  store: MailboxStore
  tasks: TaskStore
  records: () => Iterable<ChatSessionRecord>
  getRecord: (id: string) => ChatSessionRecord | undefined
  teamOf: (sessionId: string) => TeamIdentity | undefined
  /**
   * The group's definition from the current file, resolved asynchronously
   * (a live member's stamp-validated catalog, else the mail's origin).
   */
  definition: (teamId: string, groupId: string, originPath?: string) => Promise<GroupDefinition | undefined>
  /** Same, from the per-cycle map only (evaluate runs after it is seeded). */
  cachedDefinition: (teamId: string, groupId: string) => GroupDefinition | undefined
  /** The dispatcher's recipient view builder (D3 reads idle and pendingRequest). */
  recipient: (id: string) => { idle: boolean; pendingRequest: boolean } | undefined
  /** Whether the session has a live background worker (D3). */
  hasLiveWorkers: (id: string) => boolean
  /** Whether the session has a running background task (a `run_in_background` shell or Monitor; D3). */
  hasRunningBackgroundTasks: (id: string) => boolean
  /** The manager's archive: the whole release mechanism (D2). */
  archive: (sessionId: string) => ArchiveResult
  /** Re-run the dispatch cycle (freed capacity serves mail in the next pass). */
  notify: () => void
}

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS team_member_releases (
  session_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  requested_by_kind TEXT NOT NULL,
  requested_by_session TEXT,
  requested_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS team_member_releases_task ON team_member_releases (task_id);
CREATE TABLE IF NOT EXISTS team_task_closers (
  task_id TEXT PRIMARY KEY,
  closed_by_kind TEXT NOT NULL,
  closed_by_session TEXT
);
`

const isClosed = (status: TaskStatus) => status === 'done' || status === 'cancelled'

const actorText = (actor: JournalAuthor): string =>
  actor.kind === 'human' ? 'the human' : actor.kind === 'system' ? 'kawai' : actor.sessionId

export class MemberRelease {
  constructor(private readonly db: Database, private readonly options: MemberReleaseOptions) {
    db.exec(CREATE_TABLE_SQL)
  }

  /** Every pending row (the dispatcher's cycle seeds definitions for them). */
  pending(): PendingReleaseRow[] {
    return (this.db.prepare('SELECT * FROM team_member_releases ORDER BY requested_at, rowid').all() as Record<string, unknown>[])
      .map(row => ({
        sessionId: String(row.session_id),
        taskId: String(row.task_id),
        teamId: String(row.team_id),
        reason: String(row.reason),
        requestedBy: row.requested_by_kind === 'agent' && typeof row.requested_by_session === 'string'
          ? { kind: 'agent', sessionId: row.requested_by_session }
          : row.requested_by_kind === 'system' ? { kind: 'system', sessionId: null } : { kind: 'human', sessionId: null },
        requestedAt: String(row.requested_at),
      }))
  }

  pendingFor(sessionId: string): boolean {
    return this.db.prepare('SELECT 1 FROM team_member_releases WHERE session_id = ?').get(sessionId) !== null
  }

  /** The session was archived, killed, or restored by any path: its row is moot (D1). */
  cancel(sessionId: string): void {
    this.db.prepare('DELETE FROM team_member_releases WHERE session_id = ?').run(sessionId)
  }

  /**
   * The status-transition hook (D1/D8): resolves group definitions first,
   * then returns the closure `TaskStore.setStatus` runs inside its
   * transaction — marking the task's live spawned members, dead-lettering
   * its undelivered worktree mail on the way into `done`/`cancelled`, and
   * cancelling pending releases on the way out.
   */
  async transitionHook(task: TeamTask, status: TaskStatus, actor: TaskActor): Promise<() => void> {
    if (isClosed(status) && !isClosed(task.status)) {
      // Definitions resolve per group id while we can await; everything that
      // can change during that window (a dispatch pass claiming and pushing
      // mail, a spawn completing) is re-read inside the synchronous closure,
      // so the close only ever settles what is still waiting and marks every
      // member that is live at the commit.
      const origins = new Map<string, string>()
      for (const row of this.options.store.forTask(task.id)) {
        if (row.toKind === 'group' && row.toId !== null
          && (row.state === 'queued' || row.state === 'awaiting-request' || row.state === 'spawning')) {
          origins.set(row.toId, row.originPath)
        }
      }
      const groupIds = new Set<string>([
        ...origins.keys(),
        ...this.spawnedMembersOf(task).flatMap(record => (record.groupId ? [record.groupId] : [])),
      ])
      const definitions = new Map<string, GroupDefinition | undefined>(await Promise.all([...groupIds].map(
        async groupId => [groupId, await this.options.definition(task.teamId, groupId, origins.get(groupId))] as const)))
      const waiting = (row: { toKind: string; state: string }) =>
        row.state === 'queued' || row.state === 'awaiting-request' || row.state === 'spawning'
      return () => {
        this.options.tasks.appendJournal(task.id, actor, `Task ${status}.`)
        // Who closed the task: a spawn completing after the close reads this back.
        this.db.prepare(`INSERT OR REPLACE INTO team_task_closers (task_id, closed_by_kind, closed_by_session)
          VALUES (?, ?, ?)`).run(task.id, actor.kind, actor.sessionId)
        // Only rows still undelivered at the commit: a message claimed, pushed,
        // or delivered while the definitions resolved stays the recipient's.
        // A group whose first row arrived during the await has no resolved
        // definition here; the next cycle's evaluate() settles it (D8).
        for (const message of this.options.store.forTask(task.id)) {
          if (message.toKind !== 'group' || message.toId === null || !waiting(message)) continue
          if (!definitions.has(message.toId)) continue
          if (definitions.get(message.toId)?.worktreeScoped !== false) {
            this.options.store.deadLetter(message.id, 'task-closed')
          }
        }
        const now = new Date().toISOString()
        for (const record of this.spawnedMembersOf(task)) {
          if (definitions.get(record.groupId ?? '')?.releaseOnTaskClose === false) continue
          this.db.prepare(`INSERT OR REPLACE INTO team_member_releases
            (session_id, task_id, team_id, reason, requested_by_kind, requested_by_session, requested_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`)
            .run(record.sessionId, task.id, task.teamId, `task ${status}`, actor.kind, actor.sessionId, now)
        }
      }
    }
    if (isClosed(task.status) && !isClosed(status)) {
      return () => {
        this.db.prepare('DELETE FROM team_member_releases WHERE task_id = ?').run(task.id)
        this.db.prepare('DELETE FROM team_task_closers WHERE task_id = ?').run(task.id)
      }
    }
    return () => {}
  }

  /**
   * A session was created spawned for a task that is already closed (D1):
   * its spawn's mail was dead-lettered at the close, so it starts with no
   * turn — mark it now and it is released once it settles. The closer is
   * the actor the close stored, else kawai.
   */
  async markSpawnedForClosedTask(sessionId: string, taskId: string): Promise<void> {
    const task = this.options.tasks.get(taskId)
    if (!task || !isClosed(task.status)) return
    const record = this.options.getRecord(sessionId)
    if (!record || !record.spawned || record.taskId !== taskId || record.archivedAt != null) return
    if (record.groupId
      && (await this.options.definition(task.teamId, record.groupId, record.projectPath))?.releaseOnTaskClose === false) return
    // Re-read after the await: a reopen during the definition load must not
    // leave a pending row for an open task (the member would be archived).
    const still = this.options.tasks.get(taskId)
    const fresh = this.options.getRecord(sessionId)
    if (!still || !isClosed(still.status)) return
    if (!fresh || !fresh.spawned || fresh.taskId !== taskId || fresh.archivedAt != null) return
    const closer = this.db.prepare('SELECT closed_by_kind, closed_by_session FROM team_task_closers WHERE task_id = ?')
      .get(taskId) as { closed_by_kind: string; closed_by_session: string | null } | null
    this.db.prepare(`INSERT OR REPLACE INTO team_member_releases
      (session_id, task_id, team_id, reason, requested_by_kind, requested_by_session, requested_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(sessionId, still.id, still.teamId, `task ${still.status}`,
        closer?.closed_by_kind ?? 'system', closer?.closed_by_session ?? null, new Date().toISOString())
    this.options.notify()
  }

  /**
   * The dispatch cycle's release pass (D2), after the cycle's definitions
   * are seeded and before routing: dead-letter closed tasks' waiting group
   * mail (D8, late arrivals), then archive each ready pending member,
   * journal the release, and drop its row. The freed capacity serves mail
   * in this same pass.
   */
  async evaluate(): Promise<void> {
    for (const message of this.options.store.waitingRows()) {
      if (message.toKind !== 'group' || message.toId === null || !message.taskId) continue
      const task = this.options.tasks.get(message.taskId)
      if (!task || !isClosed(task.status)) continue
      // A missing definition counts as scoped (D5); only an explicit
      // `worktreeScoped: false` group keeps its task mail after the close.
      if (this.options.cachedDefinition(message.teamId, message.toId)?.worktreeScoped === false) continue
      this.options.store.deadLetter(message.id, 'task-closed')
    }
    for (const row of this.pending()) {
      const record = this.options.getRecord(row.sessionId)
      if (!record || record.archivedAt != null) { this.cancel(row.sessionId); continue }
      // The current file wins (D1): a group that opted out after the close
      // keeps its member.
      if (record.groupId
        && this.options.cachedDefinition(row.teamId, record.groupId)?.releaseOnTaskClose === false) {
        this.cancel(row.sessionId)
        continue
      }
      if (!this.readiness(row.sessionId).ready) continue
      // A refused archive released nothing: drop the row without a journal entry.
      if (!this.options.archive(row.sessionId).ok) { this.cancel(row.sessionId); continue }
      const status = this.options.tasks.get(row.taskId)?.status ?? 'closed'
      this.journalRelease(row.taskId, `Released ${record.name} (${row.sessionId}): task ${status} by ${actorText(row.requestedBy)}.`)
      this.cancel(row.sessionId)
    }
  }

  /**
   * The one readiness definition (D3): idle in the sense mail delivery
   * uses, no pending approval or question, no live background worker, no
   * running background task, no claimed or parked mail, and no due direct
   * mail waiting. Unavailable
   * members (missing directory, start blocker) count as ready — they hold
   * capacity but can do nothing.
   */
  readiness(sessionId: string): ReleaseReadiness {
    const recipient = this.options.recipient(sessionId)
    if (recipient) {
      if (!recipient.idle) return { ready: false, reason: 'it is busy' }
      if (recipient.pendingRequest) return { ready: false, reason: 'it is awaiting an approval or answer' }
    }
    if (this.options.hasLiveWorkers(sessionId)) return { ready: false, reason: 'a background worker it started is still running' }
    if (this.options.hasRunningBackgroundTasks(sessionId)) return { ready: false, reason: 'it has a running background task' }
    if (this.options.store.claimsFor(sessionId).length > 0) return { ready: false, reason: 'it holds claimed mail' }
    if (this.options.store.parkedBy(sessionId).length > 0) return { ready: false, reason: 'it holds parked work (a mailbox manager can cancel it with cancel_message, or the human can cancel or hand it off)' }
    // Direct mail on the waiting surface (queued and due, or held for its
    // pending request) reaches it before it may go.
    if (this.options.store.waitingDirectMail().some(row => row.toId === sessionId)) return { ready: false, reason: 'direct mail is waiting to reach it first' }
    return { ready: true }
  }

  /**
   * The `release_member` service entry (D6): refuses with a specific reason
   * rather than deferring, archives on success, and journals on the
   * target's task. Settled members of open tasks are intended; no pending
   * row is written, and the task and its mail stay as they are.
   */
  async releaseByAgent(callerSessionId: string, sessionId: string, reason?: string): Promise<{ sessionId: string; taskId: string | null }> {
    const caller = this.options.getRecord(callerSessionId)
    const callerTeam = caller ? this.options.teamOf(callerSessionId) : undefined
    if (!caller || !callerTeam) throw new Error(`Unknown calling session: ${callerSessionId}`)
    const callerGroup = caller.groupId
      ? await this.options.definition(callerTeam.teamId, caller.groupId, caller.projectPath)
      : undefined
    if (callerGroup?.canReleaseMembers === false) {
      throw new Error('Your group has opted out of releasing members (its file sets canReleaseMembers: false), so you may not release members.')
    }
    if (sessionId === callerSessionId) throw new Error('You cannot release yourself.')
    const record = this.options.getRecord(sessionId)
    if (!record || record.archivedAt != null) throw new Error(`No live session ${sessionId}: it is archived or unknown.`)
    if (!record.spawned) throw new Error(`Only spawned members can be released; ${sessionId} was created by the human.`)
    const team = this.options.teamOf(sessionId)
    if (!team || team.teamId !== callerTeam.teamId) throw new Error(`${sessionId} is not a member of your team.`)
    const readiness = this.readiness(sessionId)
    if (!readiness.ready) throw new Error(`${record.name} (${sessionId}) is not ready for release: ${readiness.reason}.`)
    const archived = this.options.archive(sessionId)
    if (!archived.ok) throw new Error(`${record.name} (${sessionId}) could not be archived: ${archived.error}`)
    if (record.taskId) {
      this.journalRelease(record.taskId,
        `Released ${record.name} (${sessionId}) at the request of ${caller.name} (${callerSessionId}): ${reason?.trim() || 'no reason given'}.`)
    }
    this.cancel(sessionId)
    this.options.notify()
    return { sessionId, taskId: record.taskId ?? null }
  }

  /** The system journal entry naming the session and why it was released (D4). */
  private journalRelease(taskId: string, text: string): void {
    this.options.tasks.appendJournal(taskId, { kind: 'system', sessionId: null }, text)
  }

  /** Live spawned sessions of a task: `associateTask` never rewrites a spawned member's task. */
  private spawnedMembersOf(task: TeamTask): ChatSessionRecord[] {
    return [...this.options.records()].filter(record =>
      record.taskId === task.id && record.spawned === true && record.archivedAt == null)
  }
}
