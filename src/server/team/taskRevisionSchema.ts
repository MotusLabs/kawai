// Schema for task-revision publication (task-revision-publication design
// D1–D3, D6, Migration Plan), additive only: three new tables, and nullable
// columns on `team_task_revisions` for the publication's rationale, command
// key, and notify flag. Older revisions read with no rationale and `notify`
// null ("published before notifications"). The partial unique index on
// `(task_id, request_key)` is the publication arbiter (D2): a second write
// under a used key fails, and the publisher resolves it as a replay.
import type { Database } from 'bun:sqlite'

const CREATE_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS team_task_drafts (
  task_id TEXT PRIMARY KEY,
  base_revision INTEGER NOT NULL,
  direction TEXT NOT NULL,
  acceptance TEXT,
  rationale TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS team_task_notifications (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  assignment_id TEXT NOT NULL,
  recipient_session TEXT NOT NULL,
  message_id TEXT NOT NULL,
  request_key TEXT NOT NULL,
  created_by_kind TEXT NOT NULL,
  created_by_session TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS team_task_notifications_key ON team_task_notifications (task_id, request_key, assignment_id);
CREATE INDEX IF NOT EXISTS team_task_notifications_revision ON team_task_notifications (task_id, revision);
CREATE TABLE IF NOT EXISTS team_task_acknowledgements (
  task_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  assignment_id TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (task_id, session_id, revision)
);
`

/** Columns `team_task_revisions` gained for publication (D2). */
const REVISION_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ['rationale', 'TEXT'],
  ['request_key', 'TEXT'],
  ['notify', 'INTEGER'],
]

/** Create the publication tables and add the revision columns; idempotent. */
export function migrateRevisionSchema(db: Database): void {
  db.exec(CREATE_TABLES_SQL)
  const columns = new Set((db.prepare('PRAGMA table_info(team_task_revisions)').all() as Array<{ name: string }>)
    .map(row => row.name))
  for (const [name, type] of REVISION_COLUMNS) {
    if (!columns.has(name)) db.exec(`ALTER TABLE team_task_revisions ADD COLUMN ${name} ${type}`)
  }
  // After the ALTER: a legacy table has no `request_key` until it runs.
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS team_task_revisions_request_key
    ON team_task_revisions (task_id, request_key) WHERE request_key IS NOT NULL`)
}
