// Last known identity of each team's chat sessions (team-message-threads D3).
// `chat_sessions` is authoritative while a session lives; this table answers
// after it is killed, so history can still name the participant. Upserted on
// create and rename only — kill and archive never write here.
import type { Database } from 'bun:sqlite'
import type { SessionDirectoryEntry } from '../../shared/team'

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS team_session_directory (
  team_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  name TEXT NOT NULL,
  group_id TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (team_id, session_id)
);
`

const nowIso = () => new Date().toISOString()

/** Create the table if needed; readers that join it (message search) call this too. */
export function ensureSessionDirectory(db: Database): void {
  db.exec(CREATE_TABLE_SQL)
}

export class SessionDirectory {
  constructor(private readonly db: Database) {
    ensureSessionDirectory(db)
  }

  /** Record (or re-record) a session's name and group for its team. */
  upsert(teamId: string, entry: SessionDirectoryEntry, now = nowIso()): void {
    this.db.prepare(`INSERT INTO team_session_directory (team_id, session_id, name, group_id, updated_at)
      VALUES ($teamId, $sessionId, $name, $group, $updatedAt)
      ON CONFLICT (team_id, session_id) DO UPDATE SET
        name = excluded.name, group_id = excluded.group_id, updated_at = excluded.updated_at`)
      .run({
        $teamId: teamId,
        $sessionId: entry.sessionId,
        $name: entry.name,
        $group: entry.group,
        $updatedAt: now,
      })
  }

  /** One recorded participant of a team, or null. */
  get(teamId: string, sessionId: string): SessionDirectoryEntry | null {
    const row = this.db.prepare(
      'SELECT session_id, name, group_id FROM team_session_directory WHERE team_id = ? AND session_id = ?'
    ).get(teamId, sessionId) as Record<string, unknown> | null
    return row ? mapRow(row) : null
  }

  /** Every recorded participant of a team, oldest first. */
  list(teamId: string): SessionDirectoryEntry[] {
    return (this.db.prepare(
      'SELECT session_id, name, group_id FROM team_session_directory WHERE team_id = ? ORDER BY updated_at, rowid'
    ).all(teamId) as Record<string, unknown>[]).map(mapRow)
  }
}

function mapRow(row: Record<string, unknown>): SessionDirectoryEntry {
  return {
    sessionId: String(row.session_id),
    name: String(row.name),
    group: row.group_id === null || row.group_id === undefined ? null : String(row.group_id),
  }
}
