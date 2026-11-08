// The findings ledger's storage (review-findings-ledger design D3), migration
// 24: additive, with no backfill (I4). `team_task_findings` rows stay one per
// submission; a structured row gains its contract identity, its place in the
// task's ledger order (`ledger_seq`), whether it counts for the ledger (D5),
// and the counted submission on the same result that replaced it. Items hold
// a submission's findings and dispositions; events hold disputes, decisions,
// re-maps, and supersessions, each Kawai-written one under a UNIQUE
// `source_key` so a replay writes nothing twice (I5). Cards link a dispute to
// its decision card. Rounds gain `regate_of`, unique, so a refuted round is
// re-gated at most once (D8).
import type { Database } from 'bun:sqlite'
import type { Migration } from '../dbSafety/migrations'

export const REVIEW_FINDINGS_MIGRATION_VERSION = 24

const FINDINGS_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ['structured', 'INTEGER NOT NULL DEFAULT 0'],
  ['counted', 'INTEGER NOT NULL DEFAULT 0'],
  ['contract_identity', 'TEXT'],
  ['ledger_seq', 'INTEGER'],
  ['replaced_by', 'TEXT'],
]

export const CREATE_FINDING_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS team_task_finding_items (
  id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  finding_id TEXT NOT NULL,
  item_kind TEXT NOT NULL,
  level TEXT NOT NULL,
  clause TEXT,
  clause_id TEXT,
  evidence TEXT,
  impact TEXT,
  reproduction TEXT,
  locus TEXT NOT NULL DEFAULT '',
  class TEXT,
  reason TEXT,
  disposition TEXT,
  regressed INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (submission_id, finding_id)
);
CREATE INDEX IF NOT EXISTS team_task_finding_items_task ON team_task_finding_items (task_id, finding_id);
CREATE TABLE IF NOT EXISTS team_task_finding_events (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  finding_id TEXT NOT NULL,
  ledger_seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  result_id TEXT,
  card_id TEXT,
  decision_id TEXT,
  revision INTEGER,
  contract_identity TEXT,
  clause TEXT,
  actor_kind TEXT NOT NULL,
  actor_session TEXT,
  text TEXT,
  source_key TEXT UNIQUE,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS team_task_finding_events_task ON team_task_finding_events (task_id, ledger_seq);
CREATE TABLE IF NOT EXISTS team_task_finding_cards (
  card_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  finding_id TEXT NOT NULL,
  dispute_event_id TEXT NOT NULL UNIQUE
);
`

const columnsOf = (db: Database, table: string): Set<string> =>
  new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(row => row.name))

const tableExists = (db: Database, table: string): boolean =>
  db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== null

/** Apply D3 idempotently: every statement checks or uses IF NOT EXISTS. */
export function applyReviewFindingsSchema(db: Database): void {
  if (tableExists(db, 'team_task_findings')) {
    const columns = columnsOf(db, 'team_task_findings')
    for (const [column, type] of FINDINGS_COLUMNS) {
      if (!columns.has(column)) db.exec(`ALTER TABLE team_task_findings ADD COLUMN ${column} ${type}`)
    }
  }
  db.exec(CREATE_FINDING_TABLES_SQL)
  if (tableExists(db, 'plan_execution_rounds')) {
    if (!columnsOf(db, 'plan_execution_rounds').has('regate_of')) db.exec('ALTER TABLE plan_execution_rounds ADD COLUMN regate_of TEXT')
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS plan_execution_rounds_regate ON plan_execution_rounds (regate_of) WHERE regate_of IS NOT NULL')
  }
}

export const reviewFindingsMigration: Migration = {
  version: REVIEW_FINDINGS_MIGRATION_VERSION,
  name: 'review-findings',
  up: applyReviewFindingsSchema,
}
