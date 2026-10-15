// Frozen baseline step for the session tables (execution-safety-recovery D13):
// agent_sessions, app_settings, chat_sessions, their indexes, and every column
// migration gathered before schema versions. Runs only on an unversioned
// database (dbSafety/baseline.ts); later changes are numbered migrations.
import { Database as SQLiteDatabase } from 'bun:sqlite'
import { isGeneratorSessionName } from '../nameGenerator'
const AGENT_SESSIONS_COLUMNS_SQL = `
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT UNIQUE,
  log_file_path TEXT NOT NULL UNIQUE,
  project_path TEXT,
  agent_type TEXT NOT NULL CHECK (agent_type IN ('claude', 'claude-rp', 'codex', 'pi')),
  display_name TEXT,
  created_at TEXT NOT NULL,
  last_activity_at TEXT NOT NULL,
  last_user_message TEXT,
  current_window TEXT,
  is_pinned INTEGER NOT NULL DEFAULT 0,
  last_resume_error TEXT,
  wake_started_at TEXT,
  -- NULL means "unknown" (e.g., after upgrade). First poll will initialize to actual size.
  -- This triggers a one-time match check for upgraded sessions.
  last_known_log_size INTEGER,
  is_codex_exec INTEGER NOT NULL DEFAULT 0,
  slug TEXT,
  launch_command TEXT
`

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS agent_sessions (
${AGENT_SESSIONS_COLUMNS_SQL}
);
`

const CREATE_APP_SETTINGS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`

const CREATE_CHAT_SESSIONS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS chat_sessions (
  session_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  project_path TEXT NOT NULL,
  sdk_session_id TEXT,
  profile_id TEXT NOT NULL DEFAULT 'default',
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_activity_at TEXT NOT NULL,
  archived_at TEXT,
  approval_policy TEXT NOT NULL DEFAULT 'manual',
  name_source TEXT NOT NULL DEFAULT 'manual',
  context_tokens INTEGER,
  context_threshold INTEGER,
  context_pct REAL,
  context_at TEXT,
  context_approx INTEGER,
  group_id TEXT,
  task_id TEXT,
  spawned INTEGER NOT NULL DEFAULT 0
);
`

const CREATE_INDEXES_SQL = `
CREATE INDEX IF NOT EXISTS idx_session_id
  ON agent_sessions (session_id);
CREATE INDEX IF NOT EXISTS idx_log_file_path
  ON agent_sessions (log_file_path);
CREATE INDEX IF NOT EXISTS idx_current_window
  ON agent_sessions (current_window);
CREATE UNIQUE INDEX IF NOT EXISTS idx_current_window_unique
  ON agent_sessions (current_window)
  WHERE current_window IS NOT NULL;
`

/** The session tables as they stood before schema versions (D13 baseline). */
export function applySessionSchema(db: SQLiteDatabase): void {
  migrateDatabase(db)
  db.exec(CREATE_TABLE_SQL)
  db.exec(CREATE_APP_SETTINGS_TABLE_SQL)
  db.exec(CREATE_CHAT_SESSIONS_TABLE_SQL)
  const chatColumns = db.prepare('PRAGMA table_info(chat_sessions)').all() as { name: string }[]
  if (!chatColumns.some(column => column.name === 'profile_id')) {
    db.exec("ALTER TABLE chat_sessions ADD COLUMN profile_id TEXT NOT NULL DEFAULT 'default'")
  }
  if (!chatColumns.some(column => column.name === 'archived_at')) {
    db.exec('ALTER TABLE chat_sessions ADD COLUMN archived_at TEXT')
  }
  if (!chatColumns.some(column => column.name === 'approval_policy')) {
    db.exec("ALTER TABLE chat_sessions ADD COLUMN approval_policy TEXT NOT NULL DEFAULT 'manual'")
  }
  // Context-usage reading (design D4): all four nullable — NULL means the
  // session has not produced a model request yet (design D7).
  if (!chatColumns.some(column => column.name === 'context_tokens')) {
    db.exec('ALTER TABLE chat_sessions ADD COLUMN context_tokens INTEGER')
  }
  if (!chatColumns.some(column => column.name === 'context_threshold')) {
    db.exec('ALTER TABLE chat_sessions ADD COLUMN context_threshold INTEGER')
  }
  if (!chatColumns.some(column => column.name === 'context_pct')) {
    db.exec('ALTER TABLE chat_sessions ADD COLUMN context_pct REAL')
  }
  if (!chatColumns.some(column => column.name === 'context_at')) {
    db.exec('ALTER TABLE chat_sessions ADD COLUMN context_at TEXT')
  }
  if (!chatColumns.some(column => column.name === 'context_approx')) {
    db.exec('ALTER TABLE chat_sessions ADD COLUMN context_approx INTEGER')
  }
  // Team group (agent-teams): nullable, so existing sessions have none.
  if (!chatColumns.some(column => column.name === 'group_id')) {
    db.exec('ALTER TABLE chat_sessions ADD COLUMN group_id TEXT')
  }
  if (!chatColumns.some(column => column.name === 'task_id')) {
    db.exec('ALTER TABLE chat_sessions ADD COLUMN task_id TEXT')
  }
  if (!chatColumns.some(column => column.name === 'spawned')) {
    db.exec('ALTER TABLE chat_sessions ADD COLUMN spawned INTEGER NOT NULL DEFAULT 0')
  }
  // Latest reported model (chat-session-model design D4): nullable — NULL
  // means the agent has not reported a model for this session yet.
  if (!chatColumns.some(column => column.name === 'model')) {
    db.exec('ALTER TABLE chat_sessions ADD COLUMN model TEXT')
  }
  migrateLastUserMessageColumn(db)
  migrateChatNameSourceColumn(db)
  migrateDeduplicateDisplayNames(db)
  migrateIsPinnedColumn(db)
  migrateIsSleepingToPinnedColumn(db)
  migrateLastResumeErrorColumn(db)
  migrateLastKnownLogSizeColumn(db)
  migrateIsCodexExecColumn(db)
  migrateSlugColumn(db)
  migrateAgentTypeConstraint(db)
  migrateLaunchCommandColumn(db)
  migrateWakeStartedAtColumn(db)
  migrateDeduplicateCurrentWindows(db)
  db.exec(CREATE_INDEXES_SQL)
}
function migrateDatabase(db: SQLiteDatabase) {
  const columns = getColumnNames(db, 'agent_sessions')
  if (columns.length === 0 || !columns.includes('session_source')) {
    return
  }

  db.exec('BEGIN')
  try {
    db.exec('ALTER TABLE agent_sessions RENAME TO agent_sessions_old')
    createAgentSessionsTable(db, 'agent_sessions')
    db.exec(`
      INSERT INTO agent_sessions (
        id,
        session_id,
        log_file_path,
        project_path,
        agent_type,
        display_name,
        created_at,
        last_activity_at,
        last_user_message,
        current_window
      )
      SELECT
        id,
        session_id,
        log_file_path,
        project_path,
        agent_type,
        display_name,
        created_at,
        last_activity_at,
        NULL AS last_user_message,
        current_window
      FROM agent_sessions_old
      WHERE session_source = 'log'
    `)
    db.exec('DROP TABLE agent_sessions_old')
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

function createAgentSessionsTable(db: SQLiteDatabase, tableName: string) {
  db.exec(`
    CREATE TABLE ${tableName} (
${AGENT_SESSIONS_COLUMNS_SQL}
    );
  `)
}

function migrateLastUserMessageColumn(db: SQLiteDatabase) {
  const columns = getColumnNames(db, 'agent_sessions')
  if (columns.length === 0 || columns.includes('last_user_message')) {
    return
  }
  db.exec('ALTER TABLE agent_sessions ADD COLUMN last_user_message TEXT')
}

/**
 * chat-session-naming design D6: rows created before this feature stored the
 * name but not who chose it — a user-typed name and a generated placeholder
 * landed in the same column. Recover the distinction by name shape, never
 * wholesale: `isGeneratorSessionName` is exact for what the generator can
 * emit, and a name it cannot attribute is preserved as `manual`.
 */
function migrateChatNameSourceColumn(db: SQLiteDatabase) {
  const columns = getColumnNames(db, 'chat_sessions')
  if (columns.length === 0 || columns.includes('name_source')) {
    return
  }
  // Default `manual` is the conservative stamp: only names the generator
  // provably produced are downgraded to `placeholder`.
  db.exec(
    "ALTER TABLE chat_sessions ADD COLUMN name_source TEXT NOT NULL DEFAULT 'manual'"
  )
  const rows = db
    .prepare('SELECT session_id, name FROM chat_sessions')
    .all() as { session_id: string; name: string }[]
  const markPlaceholder = db.prepare(
    "UPDATE chat_sessions SET name_source = 'placeholder' WHERE session_id = $sessionId"
  )
  for (const row of rows) {
    if (isGeneratorSessionName(row.name)) {
      markPlaceholder.run({ $sessionId: row.session_id })
    }
  }
}

function migrateIsPinnedColumn(db: SQLiteDatabase) {
  const columns = getColumnNames(db, 'agent_sessions')
  if (columns.length === 0 || columns.includes('is_pinned')) {
    return
  }
  db.exec('ALTER TABLE agent_sessions ADD COLUMN is_pinned INTEGER NOT NULL DEFAULT 0')
}

function migrateIsSleepingToPinnedColumn(db: SQLiteDatabase) {
  const columns = getColumnNames(db, 'agent_sessions')
  if (columns.length === 0 || !columns.includes('is_sleeping')) {
    return
  }

  db.exec('BEGIN')
  try {
    // Preserve every legacy sleeping row in the derived Hibernating bucket.
    db.exec('UPDATE agent_sessions SET is_pinned = 1 WHERE is_sleeping = 1')
    db.exec('ALTER TABLE agent_sessions DROP COLUMN is_sleeping')
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

function migrateLastResumeErrorColumn(db: SQLiteDatabase) {
  const columns = getColumnNames(db, 'agent_sessions')
  if (columns.length === 0 || columns.includes('last_resume_error')) {
    return
  }
  db.exec('ALTER TABLE agent_sessions ADD COLUMN last_resume_error TEXT')
}

function migrateLastKnownLogSizeColumn(db: SQLiteDatabase) {
  const columns = getColumnNames(db, 'agent_sessions')
  if (columns.length === 0 || columns.includes('last_known_log_size')) {
    return
  }
  db.exec('ALTER TABLE agent_sessions ADD COLUMN last_known_log_size INTEGER')
}

function migrateIsCodexExecColumn(db: SQLiteDatabase) {
  const columns = getColumnNames(db, 'agent_sessions')
  if (columns.length === 0 || columns.includes('is_codex_exec')) {
    return
  }
  db.exec('ALTER TABLE agent_sessions ADD COLUMN is_codex_exec INTEGER NOT NULL DEFAULT 0')
}

function migrateSlugColumn(db: SQLiteDatabase) {
  const columns = getColumnNames(db, 'agent_sessions')
  if (columns.length === 0 || columns.includes('slug')) {
    return
  }
  db.exec('ALTER TABLE agent_sessions ADD COLUMN slug TEXT')
}

function migrateLaunchCommandColumn(db: SQLiteDatabase) {
  const columns = getColumnNames(db, 'agent_sessions')
  if (columns.length === 0 || columns.includes('launch_command')) {
    return
  }
  db.exec('ALTER TABLE agent_sessions ADD COLUMN launch_command TEXT')
}

function migrateWakeStartedAtColumn(db: SQLiteDatabase) {
  const columns = getColumnNames(db, 'agent_sessions')
  if (columns.length === 0 || columns.includes('wake_started_at')) {
    return
  }
  db.exec('ALTER TABLE agent_sessions ADD COLUMN wake_started_at TEXT')
}

function migrateDeduplicateDisplayNames(db: SQLiteDatabase) {
  // Find all display names that have duplicates
  const duplicates = db
    .prepare(
      `SELECT display_name, COUNT(*) as count
       FROM agent_sessions
       GROUP BY display_name
       HAVING count > 1`
    )
    .all() as Array<{ display_name: string; count: number }>

  if (duplicates.length === 0) {
    return
  }

  const updateStmt = db.prepare(
    'UPDATE agent_sessions SET display_name = $newName WHERE session_id = $sessionId'
  )

  for (const { display_name } of duplicates) {
    // Get all sessions with this name, ordered by created_at (oldest first)
    const sessions = db
      .prepare(
        `SELECT session_id, display_name
         FROM agent_sessions
         WHERE display_name = $displayName
         ORDER BY created_at ASC`
      )
      .all({ $displayName: display_name }) as Array<{
      session_id: string
      display_name: string
    }>

    // Keep first one as-is, rename the rest
    for (let i = 1; i < sessions.length; i++) {
      const suffix = i + 1
      let newName = `${display_name}-${suffix}`

      // Make sure the new name doesn't already exist
      while (
        db
          .prepare(
            'SELECT 1 FROM agent_sessions WHERE display_name = $name LIMIT 1'
          )
          .get({ $name: newName }) != null
      ) {
        newName = `${display_name}-${suffix}-${Date.now().toString(36).slice(-4)}`
      }

      updateStmt.run({ $newName: newName, $sessionId: sessions[i].session_id })
    }
  }
}

function migrateDeduplicateCurrentWindows(db: SQLiteDatabase) {
  const columns = getColumnNames(db, 'agent_sessions')
  if (
    columns.length === 0 ||
    !columns.includes('current_window') ||
    !columns.includes('session_id') ||
    !columns.includes('last_activity_at') ||
    !columns.includes('id') ||
    !columns.includes('is_pinned')
  ) {
    return
  }

  const duplicates = db
    .prepare(
      `SELECT current_window
       FROM agent_sessions
       WHERE current_window IS NOT NULL
       GROUP BY current_window
       HAVING COUNT(*) > 1`
    )
    .all() as Array<{ current_window: string }>

  if (duplicates.length === 0) {
    return
  }

  const selectSessions = db.prepare(
    `SELECT session_id
     FROM agent_sessions
     WHERE current_window = $currentWindow
     ORDER BY last_activity_at DESC, id DESC`
  )
  const orphanDuplicate = db.prepare(
    `UPDATE agent_sessions
     SET current_window = NULL, is_pinned = 0
     WHERE session_id = $sessionId`
  )

  db.exec('BEGIN')
  try {
    for (const { current_window } of duplicates) {
      const sessions = selectSessions.all({
        $currentWindow: current_window,
      }) as Array<{ session_id: string }>

      for (const duplicate of sessions.slice(1)) {
        orphanDuplicate.run({ $sessionId: duplicate.session_id })
      }
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

/**
 * Migrate agent_type CHECK constraint to include every current AgentType.
 * SQLite doesn't support modifying constraints, so we recreate the table.
 */
function migrateAgentTypeConstraint(db: SQLiteDatabase) {
  const tableInfo = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='agent_sessions'")
    .get() as { sql: string } | undefined

  if (!tableInfo?.sql) {
    return // Table doesn't exist yet, will be created with correct constraint
  }

  if (tableInfo.sql.includes("'claude-rp'") && tableInfo.sql.includes("'pi'")) {
    return
  }

  const existingColumns = getColumnNames(db, 'agent_sessions')
  const launchCommandSelect = existingColumns.includes('launch_command')
    ? 'launch_command'
    : 'NULL AS launch_command'
  const wakeStartedAtSelect = existingColumns.includes('wake_started_at')
    ? 'wake_started_at'
    : 'NULL AS wake_started_at'

  db.exec('BEGIN')
  try {
    db.exec('ALTER TABLE agent_sessions RENAME TO agent_sessions_old_agent_type_migrate')
    createAgentSessionsTable(db, 'agent_sessions')
    db.exec(`
      INSERT INTO agent_sessions (
        id,
        session_id,
        log_file_path,
        project_path,
        slug,
        agent_type,
        display_name,
        created_at,
        last_activity_at,
        last_user_message,
        current_window,
        is_pinned,
        last_resume_error,
        wake_started_at,
        last_known_log_size,
        is_codex_exec,
        launch_command
      )
      SELECT
        id,
        session_id,
        log_file_path,
        project_path,
        slug,
        agent_type,
        display_name,
        created_at,
        last_activity_at,
        last_user_message,
        current_window,
        is_pinned,
        last_resume_error,
        ${wakeStartedAtSelect},
        last_known_log_size,
        is_codex_exec,
        ${launchCommandSelect}
      FROM agent_sessions_old_agent_type_migrate
    `)
    db.exec('DROP TABLE agent_sessions_old_agent_type_migrate')
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

function getColumnNames(db: SQLiteDatabase, tableName: string): string[] {
  const rows = db
    .prepare(`PRAGMA table_info(${tableName})`)
    .all() as Array<{ name?: string }>
  return rows.map((row) => String(row.name ?? '')).filter(Boolean)
}
