// Durable team tasks (team-tasks design D1): the record, its numbered
// immutable revisions of direction/acceptance, and an append-only journal,
// all in the server's SQLite database beside `team_messages` and
// `chat_sessions`. Tasks outlive every session that touched them — nothing
// here deletes a row. Participants are derived, never stored: the creator,
// sessions associated with the task, senders/claimants of task mail, and
// journal authors. The store is policy-free; who may do what is decided by
// TaskService before it calls in.
import type { Database } from 'bun:sqlite'
import type {
  JournalAuthor,
  TaskActor,
  TaskJournalEntry,
  TaskRevision,
  TaskStatus,
  HumanTaskDetail,
  TeamTask,
  TeamTaskDetail,
  TeamTaskSummary,
} from '../../shared/teamTasks'
import { TASK_STATUSES } from '../../shared/teamTasks'
import { outstandingOf, type AssignmentStore } from './assignmentStore'
import type { MailboxStore } from './mailboxStore'
import { migrateRevisionSchema } from './taskRevisionSchema'
import { TaskDraftStore } from './taskDrafts'

const CREATE_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS team_tasks (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  creator_kind TEXT NOT NULL,
  creator_session TEXT,
  parent_id TEXT,
  worktree TEXT,
  openspec_change TEXT,
  request_key TEXT,
  revision INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS team_tasks_team ON team_tasks (team_id, created_at);
CREATE INDEX IF NOT EXISTS team_tasks_parent ON team_tasks (parent_id);
CREATE TABLE IF NOT EXISTS team_task_revisions (
  task_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  direction TEXT NOT NULL,
  acceptance TEXT,
  author_kind TEXT NOT NULL,
  author_session TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (task_id, revision)
);
CREATE TABLE IF NOT EXISTS team_task_journal (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  author_kind TEXT NOT NULL,
  author_session TEXT,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS team_task_journal_task ON team_task_journal (task_id, created_at);
`

/** Columns added after the table first shipped (task-assignment D4). */
function migrateTable(db: Database) {
  const columns = db.prepare('PRAGMA table_info(team_tasks)').all() as Array<{ name: string }>
  if (!columns.some(column => column.name === 'request_key')) {
    db.exec('ALTER TABLE team_tasks ADD COLUMN request_key TEXT')
  }
  // Created here, not in CREATE_TABLES_SQL: a legacy table gains the column
  // only in the ALTER above, after the DDL block has already run.
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS team_tasks_request_key ON team_tasks (team_id, request_key)')
}

export interface CreateTaskInput {
  teamId: string
  title: string
  direction: string
  acceptance?: string | null
  creator: TaskActor
  parentId?: string | null
  worktree?: string | null
  openspecChange?: string | null
  /**
   * The client's request identity for this create (task-assignment D4): a
   * replay under the same key and payload returns the prior task instead of
   * a duplicate; the same key with a different payload is refused.
   */
  requestKey?: string | null
}

const nowIso = () => new Date().toISOString()

export class TaskStore {
  private readonly listeners = new Set<(task: TeamTask) => void>()
  /** The human's drafts (task-revision-publication D1): never read by agent paths. */
  readonly drafts: TaskDraftStore

  constructor(private readonly db: Database, private readonly mail?: MailboxStore, private readonly assignments?: AssignmentStore) {
    db.exec(CREATE_TABLES_SQL)
    migrateTable(db)
    migrateRevisionSchema(db)
    this.drafts = new TaskDraftStore(db)
  }

  /** Every committed change, with the task as it is now. */
  subscribe(listener: (task: TeamTask) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private changed(id: string): TeamTask {
    const task = this.get(id)!
    for (const listener of this.listeners) listener(task)
    return task
  }

  create(input: CreateTaskInput, now = nowIso()): TeamTask {
    // Request identity (task-assignment D4): insert-then-read by the unique
    // key. A same-payload replay returns the prior task; a different payload
    // under the key is refused naming the differing field. Post-create
    // mutations (status, later revisions) are never payload differences.
    if (input.requestKey) {
      const existing = this.byRequestKey(input.teamId, input.requestKey)
      if (existing) {
        const diff = createPayloadDiff(existing, this.revisions(existing.id)[0], input)
        if (diff) throw new Error(`Request key already used with a different ${diff}`)
        return existing
      }
    }
    const id = `task-${crypto.randomUUID()}`
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO team_tasks
        (id, team_id, title, status, creator_kind, creator_session, parent_id, worktree, openspec_change, request_key, revision, created_at, updated_at)
        VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, 1, ?, ?)`).run(
        id, input.teamId, input.title, input.creator.kind, input.creator.sessionId,
        input.parentId ?? null, input.worktree ?? null, input.openspecChange ?? null, input.requestKey ?? null, now, now,
      )
      this.insertRevision(id, 1, input.direction, input.acceptance ?? null, input.creator, now)
    })()
    return this.changed(id)
  }

  /** The task a team stored under a request key (idempotency reads). */
  byRequestKey(teamId: string, requestKey: string): TeamTask | null {
    const row = this.db.prepare('SELECT id FROM team_tasks WHERE team_id = ? AND request_key = ?').get(teamId, requestKey)
    return row ? this.get(String((row as Record<string, unknown>).id)) : null
  }

  get(id: string): TeamTask | null {
    const row = this.db.prepare(`SELECT t.*, r.direction, r.acceptance FROM team_tasks t
      JOIN team_task_revisions r ON r.task_id = t.id AND r.revision = t.revision WHERE t.id = ?`).get(id)
    return row ? mapTask(row as Record<string, unknown>) : null
  }

  /** A team's tasks, oldest first, each with its participants. */
  list(teamId: string): TeamTaskSummary[] {
    return this.selectTasks('t.team_id = ?', teamId).map(task => this.summary(task))
  }

  detail(id: string): TeamTaskDetail | null {
    const task = this.get(id)
    if (!task) return null
    return {
      task: this.summary(task),
      revisions: this.revisions(id),
      journal: this.journal(id),
      subtasks: this.selectTasks('t.parent_id = ?', id).map(child => this.summary(child)),
      assignments: this.assignments?.listByTask(id) ?? [],
      messages: this.messages(id),
    }
  }

  /** The human's view (D1): the detail plus the task's draft. Never for agent paths. */
  humanDetail(id: string): HumanTaskDetail | null {
    const detail = this.detail(id)
    return detail ? { ...detail, draft: this.drafts.get(id) } : null
  }

  revisions(id: string): TaskRevision[] {
    return (this.db.prepare('SELECT * FROM team_task_revisions WHERE task_id = ? ORDER BY revision').all(id) as Record<string, unknown>[])
      .map(row => ({
        revision: Number(row.revision),
        direction: String(row.direction),
        acceptance: text(row.acceptance),
        author: actor(row.author_kind, row.author_session),
        createdAt: String(row.created_at),
        rationale: text(row.rationale),
        notify: row.notify === null || row.notify === undefined ? null : Number(row.notify) === 1,
      }))
  }

  /** Oldest first; `limit` keeps only the most recent entries. */
  journal(id: string, limit?: number): TaskJournalEntry[] {
    const rows = (limit === undefined
      ? this.db.prepare('SELECT * FROM team_task_journal WHERE task_id = ? ORDER BY created_at, rowid').all(id)
      : this.db.prepare('SELECT * FROM (SELECT *, rowid AS r FROM team_task_journal WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?) ORDER BY created_at, r').all(id, limit)
    ) as Record<string, unknown>[]
    return rows.map(row => ({
      id: String(row.id),
      author: journalAuthor(row.author_kind, row.author_session),
      text: String(row.text),
      createdAt: String(row.created_at),
    }))
  }

  /**
   * A new revision of direction/acceptance. Omitted fields carry over from
   * the current revision. The bump and the insert are one transaction, so
   * competing amendments each get their own number and none is lost.
   */
  amend(id: string, change: { direction?: string; acceptance?: string | null }, author: TaskActor, now = nowIso()): TeamTask | null {
    const committed = this.db.transaction(() => {
      const current = this.get(id)
      if (!current) return false
      const revision = current.revision + 1
      this.db.prepare('UPDATE team_tasks SET revision = ?, updated_at = ? WHERE id = ?').run(revision, now, id)
      this.insertRevision(id, revision, change.direction ?? current.direction,
        change.acceptance === undefined ? current.acceptance : change.acceptance, author, now)
      return true
    })()
    return committed ? this.changed(id) : null
  }

  appendJournal(id: string, author: JournalAuthor, entry: string, now = nowIso()): TaskJournalEntry | null {
    if (!this.get(id)) return null
    const journalId = `note-${crypto.randomUUID()}`
    this.db.prepare(`INSERT INTO team_task_journal (id, task_id, author_kind, author_session, text, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(journalId, id, author.kind, author.sessionId, entry, now)
    this.db.prepare('UPDATE team_tasks SET updated_at = ? WHERE id = ?').run(now, id)
    this.changed(id)
    return { id: journalId, author, text: entry, createdAt: now }
  }

  /**
   * Set a task's status. `within` runs inside the same transaction as the
   * update (member-release D1/D8): a transition into `done`/`cancelled`
   * records pending releases and dead-letters waiting mail atomically with
   * the new status, and a transition out cancels them.
   */
  setStatus(id: string, status: TaskStatus, within?: () => void, now = nowIso()): TeamTask | null {
    const changes = this.db.transaction(() => {
      if (within) within()
      return this.db.prepare('UPDATE team_tasks SET status = ?, updated_at = ? WHERE id = ?').run(status, now, id).changes
    })()
    return changes === 1 ? this.changed(id) : null
  }

  /** Re-announce a task whose derived data (participants, messages) changed. */
  touch(id: string): void {
    if (this.get(id)) this.changed(id)
  }

  private insertRevision(id: string, revision: number, direction: string, acceptance: string | null, author: TaskActor, now: string) {
    this.db.prepare(`INSERT INTO team_task_revisions (task_id, revision, direction, acceptance, author_kind, author_session, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, revision, direction, acceptance, author.kind, author.sessionId, now)
  }

  private selectTasks(where: string, param: string): TeamTask[] {
    return (this.db.prepare(`SELECT t.*, r.direction, r.acceptance FROM team_tasks t
      JOIN team_task_revisions r ON r.task_id = t.id AND r.revision = t.revision
      WHERE ${where} ORDER BY t.created_at, t.rowid`).all(param) as Record<string, unknown>[]).map(mapTask)
  }

  private messages(id: string) {
    return this.mail?.forTask(id) ?? []
  }

  private summary(task: TeamTask): TeamTaskSummary {
    const ids = new Set<string>()
    if (task.creator.sessionId) ids.add(task.creator.sessionId)
    const rows = this.db.prepare(`
      SELECT session_id AS id FROM chat_sessions WHERE task_id = $id
      UNION SELECT from_session FROM team_messages WHERE task_id = $id AND from_session IS NOT NULL
      UNION SELECT claimed_by FROM team_messages WHERE task_id = $id AND claimed_by IS NOT NULL
      UNION SELECT author_session FROM team_task_journal WHERE task_id = $id AND author_session IS NOT NULL`)
      .all({ $id: task.id }) as Array<{ id: string }>
    for (const row of rows) ids.add(row.id)
    return { ...task, participants: [...ids], assignment: this.assignments ? outstandingOf(this.assignments.listByTask(task.id)) : null }
  }
}

/**
 * Which normalized create field differs between a stored task and a replayed
 * intent (D4). Direction and acceptance compare against revision 1 — what
 * this create wrote — so later amendments are never payload differences.
 */
function createPayloadDiff(existing: TeamTask, firstRevision: TaskRevision | undefined, input: CreateTaskInput): string | null {
  if (existing.title !== input.title) return 'title'
  if ((firstRevision?.direction ?? existing.direction) !== input.direction) return 'direction'
  const acceptance = input.acceptance?.trim() ? input.acceptance.trim() : null
  if ((firstRevision?.acceptance ?? existing.acceptance ?? null) !== acceptance) return 'acceptance'
  if ((existing.parentId ?? null) !== (input.parentId || null)) return 'parent'
  if ((existing.worktree ?? null) !== (input.worktree ?? null)) return 'worktree'
  if ((existing.openspecChange ?? null) !== (input.openspecChange ?? null)) return 'OpenSpec change'
  return null
}

function text(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value)
}

function actor(kind: unknown, session: unknown): TaskActor {
  return kind === 'agent' && typeof session === 'string' ? { kind: 'agent', sessionId: session } : { kind: 'human', sessionId: null }
}

/** A journal row's author: like `actor`, but `system` stays itself (D4). */
function journalAuthor(kind: unknown, session: unknown): JournalAuthor {
  return kind === 'system' ? { kind: 'system', sessionId: null } : actor(kind, session)
}

function mapTask(row: Record<string, unknown>): TeamTask {
  const status = String(row.status) as TaskStatus
  return {
    id: String(row.id),
    teamId: String(row.team_id),
    title: String(row.title),
    status: TASK_STATUSES.includes(status) ? status : 'open',
    creator: actor(row.creator_kind, row.creator_session),
    parentId: text(row.parent_id),
    worktree: text(row.worktree),
    openspecChange: text(row.openspec_change),
    revision: Number(row.revision),
    direction: String(row.direction),
    acceptance: text(row.acceptance),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }
}
