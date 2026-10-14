// Acknowledgements (task-revision-publication design D6): an agent's durable
// statement that it works from a published revision, keyed by session. Any
// team session may record one; an assignment shows only its current
// claimant's (taskNotices.ts), so a replacement claimant starts with none
// while earlier claimants' rows stay in the history. Insert-or-ignore: a
// repeat is a no-op.
import type { Database } from 'bun:sqlite'
import type { TaskAcknowledgement } from '../../shared/teamTasks'

const nowIso = () => new Date().toISOString()

export class TaskAcknowledgements {
  constructor(private readonly db: Database) {}

  /** Record one; false when this session already acknowledged this revision. */
  record(taskId: string, sessionId: string, revision: number, assignmentId: string | null, now = nowIso()): boolean {
    return this.db.prepare(`INSERT OR IGNORE INTO team_task_acknowledgements (task_id, session_id, revision, assignment_id, created_at)
      VALUES (?, ?, ?, ?, ?)`).run(taskId, sessionId, revision, assignmentId, now).changes === 1
  }

  /** Every acknowledgement of a task, oldest first. */
  list(taskId: string): TaskAcknowledgement[] {
    return (this.db.prepare('SELECT * FROM team_task_acknowledgements WHERE task_id = ? ORDER BY created_at, rowid')
      .all(taskId) as Record<string, unknown>[]).map(row => ({
      sessionId: String(row.session_id),
      revision: Number(row.revision),
      assignmentId: row.assignment_id === null ? null : String(row.assignment_id),
      createdAt: String(row.created_at),
    }))
  }

  /** A session's highest acknowledged revision of a task; null when none. */
  highest(taskId: string, sessionId: string): number | null {
    const row = this.db.prepare('SELECT MAX(revision) AS revision FROM team_task_acknowledgements WHERE task_id = ? AND session_id = ?')
      .get(taskId, sessionId) as { revision: number | null }
    return row.revision
  }
}
