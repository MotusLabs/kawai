// Durable turn ends for the workspace's morning summary (team-workspace
// D8): one row per completed turn of a task-bound session, written from the
// server-side event path whether or not any view is open. The summary reads
// its 24-hour window straight from SQL, so the bucket survives a restart
// with no transcript replay at all. Rows age out after seven days — well
// past the window — pruned once at startup and at most hourly on write.
import type { Database } from 'bun:sqlite'

export const CREATE_TURN_ENDS_SQL = `
CREATE TABLE IF NOT EXISTS chat_turn_ends (
  session_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  ended_at TEXT NOT NULL
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
}

const mapRow = (row: Record<string, unknown>): TurnEndRow => ({
  sessionId: String(row.session_id),
  taskId: String(row.task_id),
  endedAt: String(row.ended_at),
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

  /** One completed turn of a task-bound session, at the event's timestamp. */
  record(sessionId: string, taskId: string, endedAt: string): void {
    this.db.prepare('INSERT INTO chat_turn_ends (session_id, task_id, ended_at) VALUES (?, ?, ?)')
      .run(sessionId, taskId, endedAt)
    if (this.now() - this.lastPruneAt >= PRUNE_INTERVAL_MS) {
      this.lastPruneAt = this.now()
      this.prune()
    }
  }

  /** Rows at or after the window's start, oldest first. */
  since(endedAt: string): TurnEndRow[] {
    return (this.db.prepare('SELECT session_id, task_id, ended_at FROM chat_turn_ends WHERE ended_at >= ? ORDER BY ended_at')
      .all(endedAt) as Record<string, unknown>[]).map(mapRow)
  }

  private prune(): void {
    const cutoff = new Date(this.now() - TURN_END_RETENTION_MS).toISOString()
    this.db.prepare('DELETE FROM chat_turn_ends WHERE ended_at < ?').run(cutoff)
  }
}
