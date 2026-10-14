// Durable turn ends for the workspace's morning summary (team-workspace
// D8): one row per completed turn of a task-bound session, written from the
// server-side event path whether or not any view is open. The summary reads
// its 24-hour window straight from SQL, so the bucket survives a restart
// with no transcript replay at all. `ok` marks the turn's outcome — only a
// successful turn is summary material; an errored one records 0 and never
// counts as finished work. Rows age out after seven days — well past the
// window — pruned once at startup and at most hourly on write.
import type { Database } from 'bun:sqlite'

export const CREATE_TURN_ENDS_SQL = `
CREATE TABLE IF NOT EXISTS chat_turn_ends (
  session_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  ended_at TEXT NOT NULL,
  ok INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS chat_turn_ends_ended_at ON chat_turn_ends (ended_at);
`

/** How long a row outlives the summary's 24-hour window. */
export const TURN_END_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
const PRUNE_INTERVAL_MS = 60 * 60 * 1000

export interface TurnEndRow {
  sessionId: string
  taskId: string
  endedAt: string
  ok: boolean
}

const mapRow = (row: Record<string, unknown>): TurnEndRow => ({
  sessionId: String(row.session_id),
  taskId: String(row.task_id),
  endedAt: String(row.ended_at),
  ok: Number(row.ok) === 1,
})

export class ChatTurnEndStore {
  private lastPruneAt: number

  constructor(
    private readonly db: Database,
    private readonly now: () => number = Date.now,
  ) {
    this.db.exec(CREATE_TURN_ENDS_SQL)
    this.lastPruneAt = this.now()
    this.prune()
  }

  /** One completed turn of a task-bound session; `ok` is the outcome the driver reported. */
  record(sessionId: string, taskId: string, endedAt: string, ok: boolean): void {
    this.db.prepare('INSERT INTO chat_turn_ends (session_id, task_id, ended_at, ok) VALUES (?, ?, ?, ?)')
      .run(sessionId, taskId, endedAt, ok ? 1 : 0)
    if (this.now() - this.lastPruneAt >= PRUNE_INTERVAL_MS) {
      this.lastPruneAt = this.now()
      this.prune()
    }
  }

  /** Rows at or after the window's start, oldest first, every outcome included. */
  since(endedAt: string): TurnEndRow[] {
    return (this.db.prepare('SELECT session_id, task_id, ended_at, ok FROM chat_turn_ends WHERE ended_at >= ? ORDER BY ended_at')
      .all(endedAt) as Record<string, unknown>[]).map(mapRow)
  }

  /**
   * Successful turn ends of one team's tasks, at or after the window's start.
   * The join keeps a killed agent's finished turns in its team's window —
   * the session need not be live — and stops other teams' rows being read.
   */
  finishedForTeam(teamId: string, endedAt: string): TurnEndRow[] {
    return (this.db.prepare(`
      SELECT e.session_id, e.task_id, e.ended_at, e.ok
      FROM chat_turn_ends e
      JOIN team_tasks t ON t.id = e.task_id
      WHERE t.team_id = ? AND e.ended_at >= ? AND e.ok = 1
      ORDER BY e.ended_at`)
      .all(teamId, endedAt) as Record<string, unknown>[]).map(mapRow)
  }

  private prune(): void {
    const cutoff = new Date(this.now() - TURN_END_RETENTION_MS).toISOString()
    this.db.prepare('DELETE FROM chat_turn_ends WHERE ended_at < ?').run(cutoff)
  }
}
