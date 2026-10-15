// `team_messages` schema (team-message-threads D4): the table, the columns
// added after it first shipped, and the one guarded rebuild that relaxes the
// two NOT NULL constraints SQLite cannot drop with `ALTER TABLE`. A fresh
// database creates the final shape and never rebuilds; a legacy one gains the
// additive columns, then — only while `from_session`/`to_id` are still
// constrained — is rebuilt once inside a transaction. The rebuild creates all
// five indexes on the copy itself: `CREATE_TABLE_SQL`'s `CREATE INDEX IF NOT
// EXISTS` statements have already run against the old table and will not run
// again for the rebuilt one.
import type { Database } from 'bun:sqlite'

const TABLE_BODY = `
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  to_kind TEXT NOT NULL,
  to_id TEXT,
  from_session TEXT,
  from_kind TEXT NOT NULL DEFAULT 'agent',
  from_group TEXT,
  origin_path TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'normal',
  tags TEXT NOT NULL DEFAULT '[]',
  thread_id TEXT NOT NULL,
  in_reply_to TEXT,
  hop INTEGER NOT NULL DEFAULT 1,
  body TEXT NOT NULL,
  state TEXT NOT NULL,
  claimed_by TEXT,
  claimed_at TEXT,
  deliver_at TEXT,
  created_at TEXT NOT NULL,
  pushed_at TEXT,
  delivered_at TEXT,
  reason TEXT,
  possible_duplicate INTEGER NOT NULL DEFAULT 0,
  attach_thread INTEGER NOT NULL DEFAULT 0,
  task_id TEXT,
  task_revision INTEGER,
  claim_commit TEXT,
  parked_until TEXT,
  park_count INTEGER NOT NULL DEFAULT 0,
  resume_message_id TEXT,
  handoff TEXT,
  excluded_profile TEXT,
  revision_notice TEXT
`

/**
 * The table and the four indexes that shipped with it. `team_messages_task` is
 * *not* here: a database that predates `task_id` would fail this block before
 * `migrateTable` could add the column. `createMessageTable` creates it last.
 */
export const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS team_messages (${TABLE_BODY});
CREATE INDEX IF NOT EXISTS team_messages_queue ON team_messages (team_id, state);
CREATE INDEX IF NOT EXISTS team_messages_thread ON team_messages (thread_id);
CREATE INDEX IF NOT EXISTS team_messages_recipient ON team_messages (to_id, state);
CREATE INDEX IF NOT EXISTS team_messages_claimant ON team_messages (claimed_by, state);
`

/** Columns added after the table first shipped, for databases that predate them. */
const ADDED_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ['task_id', 'TEXT'],
  // Profile routing: claim commit, parking, and handoff.
  ['claim_commit', 'TEXT'],
  ['parked_until', 'TEXT'],
  ['park_count', 'INTEGER NOT NULL DEFAULT 0'],
  ['resume_message_id', 'TEXT'],
  ['handoff', 'TEXT'],
  ['excluded_profile', 'TEXT'],
  // Human senders and the revision a delivery carried (team-message-threads).
  ['from_kind', "TEXT NOT NULL DEFAULT 'agent'"],
  ['task_revision', 'INTEGER'],
  // The revision a notice announces (task-revision-publication D3).
  ['revision_notice', 'TEXT'],
]

/** Every column of the final shape, in table order. */
const COLUMNS = TABLE_BODY.split(',')
  .map(line => line.trim().split(/\s+/)[0]!)
  .filter(name => name.length > 0)

export interface MessageSchemaResult {
  /** True when the guarded rebuild replaced a constrained `team_messages`. */
  rebuilt: boolean
}

/**
 * Create `team_messages` if it is missing, add any columns later releases
 * introduced, and rebuild once if the sender/recipient columns are still NOT
 * NULL. Returns whether a rebuild ran; a fresh database never rebuilds.
 */
export function createMessageTable(db: Database): MessageSchemaResult {
  db.exec(CREATE_TABLE_SQL)
  migrateTable(db)
  const result = rebuildIfConstrained(db)
  // Created last for every path: the DDL block cannot (a legacy table has no
  // `task_id` yet), `migrateTable` runs before the rebuild, and the rebuild's
  // DROP discards whatever index existed.
  db.exec('CREATE INDEX IF NOT EXISTS team_messages_task ON team_messages (task_id)')
  return result
}

function migrateTable(db: Database) {
  const columns = new Set((db.prepare('PRAGMA table_info(team_messages)').all() as Array<{ name: string }>)
    .map(row => row.name))
  for (const [name, type] of ADDED_COLUMNS) {
    if (!columns.has(name)) db.exec(`ALTER TABLE team_messages ADD COLUMN ${name} ${type}`)
  }
}

/**
 * SQLite cannot relax NOT NULL with `ALTER TABLE`, so a database that
 * predates human senders is rebuilt: copy into the final shape, drop, rename,
 * and re-create the five indexes the drop discarded. Skipped when the columns
 * are already nullable — including every fresh database. `migrateTable` has
 * already added every column, so the copy reads them straight across
 * (`from_kind` keeps its 'agent' default; `task_revision` stays null).
 */
function rebuildIfConstrained(db: Database): MessageSchemaResult {
  const info = db.prepare('PRAGMA table_info(team_messages)').all() as Array<{ name: string; notnull: number }>
  const constrained = info.some(row =>
    (row.name === 'from_session' || row.name === 'to_id') && row.notnull === 1)
  if (!constrained) return { rebuilt: false }

  const listed = COLUMNS.join(', ')
  db.transaction(() => {
    db.exec(`CREATE TABLE team_messages_new (${TABLE_BODY});`)
    db.exec(`INSERT INTO team_messages_new (${listed}) SELECT ${listed} FROM team_messages`)
    db.exec('DROP TABLE team_messages')
    db.exec('ALTER TABLE team_messages_new RENAME TO team_messages')
    // The drop discarded the old indexes; the DDL block will not run again.
    db.exec(`CREATE INDEX team_messages_queue ON team_messages (team_id, state)`)
    db.exec(`CREATE INDEX team_messages_thread ON team_messages (thread_id)`)
    db.exec(`CREATE INDEX team_messages_recipient ON team_messages (to_id, state)`)
    db.exec(`CREATE INDEX team_messages_claimant ON team_messages (claimed_by, state)`)
    db.exec(`CREATE INDEX team_messages_task ON team_messages (task_id)`)
  })()
  return { rebuilt: true }
}
