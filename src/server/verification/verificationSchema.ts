// Result check schema (independent-verification design D4, task 2.1) and the
// numbered migration `result-checks` in `dbSafety/migrations.ts`, frozen like
// every applied migration. Additive, no backfill:
// - `team_task_result_checks`: one row per check of one result. `seq`
//   numbers a result's checks (rechecks append); `UNIQUE (result_id, seq)`
//   keeps them distinct. The partial unique index on
//   `result_id WHERE status = 'pending'` makes D4's one-pending rule a
//   database fact: a second pending row for one result is refused, and the
//   requester reads the standing one instead. A row settles once, from
//   `pending` to `done` or `unavailable`; the update matches
//   `status = 'pending'`, so a settled row never changes again. `facts` is
//   the versioned check JSON (at most 64 KB, enforced by the writer);
//   `reason` names why a check is `unavailable`.
// - `team_task_coverage_maps`: reviewer coverage maps (used from PR C).
//   Append-only — this schema has no UPDATE or DELETE for the table, and the
//   newest map per (result, author session) counts at read time.
// - `team_task_results.coverage`: the submitter's nullable coverage map.
import type { Database } from 'bun:sqlite'
import type { Migration } from '../dbSafety/migrations'

/** The tables this change owns, in schema order (inventory tests read this). */
export const VERIFICATION_TABLES: string[] = ['team_task_result_checks', 'team_task_coverage_maps']

export const CREATE_VERIFICATION_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS team_task_result_checks (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  result_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  trigger TEXT NOT NULL CHECK (trigger IN ('submit','recheck')),
  requested_by_kind TEXT NOT NULL,
  requested_by_session TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending','done','unavailable')),
  facts TEXT,
  reason TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS team_task_result_checks_seq ON team_task_result_checks (result_id, seq);
CREATE UNIQUE INDEX IF NOT EXISTS team_task_result_checks_one_pending
  ON team_task_result_checks (result_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS team_task_result_checks_team_pending
  ON team_task_result_checks (team_id, status, created_at);
CREATE TABLE IF NOT EXISTS team_task_coverage_maps (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  result_id TEXT NOT NULL,
  author_session TEXT NOT NULL,
  coverage TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`

/** `team_task_results` gains the submitter's nullable coverage map (D4). */
const RESULT_COVERAGE_COLUMN: readonly [string, string] = ['coverage', 'TEXT']

export function applyVerificationSchema(db: Database): void {
  db.exec(CREATE_VERIFICATION_TABLES_SQL)
  const columns = new Set((db.prepare('PRAGMA table_info(team_task_results)').all() as Array<{ name: string }>)
    .map(row => row.name))
  if (!columns.has(RESULT_COVERAGE_COLUMN[0])) {
    db.exec(`ALTER TABLE team_task_results ADD COLUMN ${RESULT_COVERAGE_COLUMN[0]} ${RESULT_COVERAGE_COLUMN[1]}`)
  }
}

/** The migration registry entry; `version` lives only here (D4). */
export const RESULT_CHECKS_MIGRATION_VERSION = 20
export const resultChecksMigration: Migration = {
  version: RESULT_CHECKS_MIGRATION_VERSION,
  name: 'result-checks',
  up: applyVerificationSchema,
}
