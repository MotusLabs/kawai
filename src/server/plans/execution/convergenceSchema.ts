// The review-convergence schema (design decisions 3, 4, 6, 7, 10), one
// additive migration with no backfill:
// - executions record the backstop at Start (`max_failed_fix_rounds`, 5 for
//   existing rows);
// - changes carry a Reassign outcome's `group_override`;
// - cards carry their `kind` ('question' for every existing row);
// - one diagnosis per failed round (`UNIQUE(round_id)`, the replay key);
// - one convergence notice per counted review of a manual task.
import type { Database } from 'bun:sqlite'
import type { Migration } from '../../dbSafety/migrations'

export const REVIEW_CONVERGENCE_MIGRATION_VERSION = 25

export const CREATE_CONVERGENCE_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS plan_execution_diagnoses (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL,
  change TEXT NOT NULL,
  round_id TEXT NOT NULL UNIQUE,
  review_submission_id TEXT,
  signals_json TEXT NOT NULL,
  card_id TEXT NOT NULL,
  message_id TEXT,
  opened_at TEXT NOT NULL,
  outcome TEXT,
  decision_id TEXT,
  closed_at TEXT,
  close_reason TEXT
);
CREATE INDEX IF NOT EXISTS plan_execution_diagnoses_change ON plan_execution_diagnoses(execution_id, change);

CREATE TABLE IF NOT EXISTS team_task_convergence_notices (
  submission_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  signals_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS team_task_convergence_notices_task ON team_task_convergence_notices(task_id);
`

const columnsOf = (db: Database, table: string): Set<string> =>
  new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(row => row.name))

const tableExists = (db: Database, table: string): boolean =>
  db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== null

const addColumn = (db: Database, table: string, column: string, type: string): void => {
  if (tableExists(db, table) && !columnsOf(db, table).has(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`)
}

/** Apply the schema idempotently: every statement checks or uses IF NOT EXISTS. */
export function applyReviewConvergenceSchema(db: Database): void {
  addColumn(db, 'plan_executions', 'max_failed_fix_rounds', 'INTEGER NOT NULL DEFAULT 5')
  addColumn(db, 'plan_execution_changes', 'group_override', 'TEXT')
  addColumn(db, 'plan_decision_cards', 'kind', "TEXT NOT NULL DEFAULT 'question'")
  db.exec(CREATE_CONVERGENCE_TABLES_SQL)
}

export const reviewConvergenceMigration: Migration = {
  version: REVIEW_CONVERGENCE_MIGRATION_VERSION,
  name: 'review-convergence',
  up: applyReviewConvergenceSchema,
}
