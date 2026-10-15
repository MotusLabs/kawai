// Schema for task results and handoffs (task-results-handoffs design D1,
// Migration Plan), additive only: `team_task_results` and
// `team_task_findings`, and nullable handoff columns on `task-assignment`'s
// `team_task_assignments` (PRAGMA-checked, never a rebuild). Pre-existing
// tasks have no results; pre-existing assignments read with null handoff
// fields as plain dispatches.
import type { Database } from 'bun:sqlite'

const CREATE_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS team_task_results (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  commit_ref TEXT,
  diff_ref TEXT,
  worktree TEXT,
  tests TEXT NOT NULL,
  limitations TEXT,
  task_revision INTEGER NOT NULL,
  submitted_by_kind TEXT NOT NULL,
  submitted_by_session TEXT NOT NULL,
  supersedes_result_id TEXT,
  accepted_by_kind TEXT,
  accepted_by_session TEXT,
  accepted_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS team_task_results_task ON team_task_results (task_id, created_at);
CREATE TABLE IF NOT EXISTS team_task_findings (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  result_id TEXT NOT NULL,
  handoff_id TEXT,
  kind TEXT NOT NULL,
  verdict TEXT NOT NULL,
  findings TEXT NOT NULL,
  author_kind TEXT NOT NULL,
  author_session TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS team_task_findings_result ON team_task_findings (result_id, created_at);
`

/** Columns `team_task_assignments` gains for handoffs (D1). */
const HANDOFF_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ['handoff_kind', 'TEXT'],
  ['result_id', 'TEXT'],
  ['expected_response', 'TEXT'],
]

/** Create the result and findings tables; idempotent. */
export function migrateResultTables(db: Database): void {
  db.exec(CREATE_TABLES_SQL)
}

/** Add the handoff columns to an existing `team_task_assignments`; idempotent. */
export function migrateHandoffColumns(db: Database): void {
  const columns = new Set((db.prepare('PRAGMA table_info(team_task_assignments)').all() as Array<{ name: string }>)
    .map(row => row.name))
  for (const [name, type] of HANDOFF_COLUMNS) {
    if (!columns.has(name)) db.exec(`ALTER TABLE team_task_assignments ADD COLUMN ${name} ${type}`)
  }
}
