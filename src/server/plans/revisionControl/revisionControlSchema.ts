// Revision-control schema (revision-control design D2) and the numbered
// migration `revision-control` in `dbSafety/migrations.ts`, frozen like every
// applied migration. Seven tables: holds and their change rows, pauses and
// their targets, checkpoints, and an execution's revision history with its
// publication rows. The backfill inserts seq 1 of `plan_execution_revisions`
// from every existing execution's row, so a run started before this change
// has its revision history. The database arbitrates the races:
// - `UNIQUE (plan_id, command_id)` on holds and pauses replays commands;
// - the `(execution_id, seq)` primary key makes two concurrent Applies on
//   one base collide, the loser mapping to `execution-revision-unchanged`;
// - the guarded Paused and decision updates write once.
import type { Database } from 'bun:sqlite'
import type { Migration } from '../../dbSafety/migrations'

/** The seven tables this change owns, in schema order (inventory tests read this). */
export const REVISION_CONTROL_TABLES: string[] = [
  'plan_holds', 'plan_hold_changes', 'plan_pauses', 'plan_pause_targets',
  'plan_checkpoints', 'plan_execution_revisions', 'plan_execution_publication_changes',
]

export const CREATE_REVISION_CONTROL_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS plan_holds (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  rationale TEXT NOT NULL,
  deadline TEXT NOT NULL,
  cites_kind TEXT,
  cites_id TEXT,
  created_at TEXT NOT NULL,
  command_id TEXT NOT NULL,
  released_at TEXT,
  release_reason TEXT,
  release_command_id TEXT,
  UNIQUE (plan_id, command_id)
);
CREATE INDEX IF NOT EXISTS plan_holds_active ON plan_holds(plan_id) WHERE released_at IS NULL;

CREATE TABLE IF NOT EXISTS plan_hold_changes (
  hold_id TEXT NOT NULL,
  change TEXT NOT NULL,
  released_at TEXT,
  release_command_id TEXT,
  PRIMARY KEY (hold_id, change)
);

CREATE TABLE IF NOT EXISTS plan_pauses (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  hold_id TEXT NOT NULL,
  deadline TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL,
  command_id TEXT NOT NULL,
  closed_at TEXT,
  UNIQUE (plan_id, command_id)
);

CREATE TABLE IF NOT EXISTS plan_pause_targets (
  pause_id TEXT NOT NULL,
  change TEXT NOT NULL,
  stage TEXT NOT NULL,
  attempt_id TEXT,
  assignment_id TEXT NOT NULL,
  holder_session TEXT,
  message_id TEXT,
  withdrawn INTEGER NOT NULL DEFAULT 0,
  paused_at TEXT,
  checkpoint_id TEXT,
  decision TEXT,
  decision_detail_json TEXT,
  decided_at TEXT,
  decision_command_id TEXT,
  PRIMARY KEY (pause_id, change)
);

CREATE TABLE IF NOT EXISTS plan_checkpoints (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL,
  change TEXT NOT NULL,
  pause_id TEXT NOT NULL,
  attempt_id TEXT,
  session_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  commit_sha TEXT,
  baseline_commit TEXT,
  manifest_hash TEXT,
  result_id TEXT,
  summary TEXT NOT NULL,
  unfinished TEXT,
  errors_tests TEXT,
  next_steps TEXT NOT NULL,
  effect_id TEXT,
  superseded_by TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS plan_execution_revisions (
  execution_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  report_id TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  rationale TEXT,
  command_id TEXT,
  payload_json TEXT,
  applied_at TEXT NOT NULL,
  PRIMARY KEY (execution_id, seq)
);

CREATE TABLE IF NOT EXISTS plan_execution_publication_changes (
  execution_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  change TEXT NOT NULL,
  class TEXT NOT NULL,
  choice TEXT,
  fields_json TEXT,
  task_id TEXT,
  task_revision INTEGER,
  PRIMARY KEY (execution_id, seq, change)
);
`

/**
 * The seq-1 backfill (D2): every execution's row becomes its history's first
 * entry, `applied_at` its start. Guarded, so rerunning the migration's up —
 * or a database that already carried some seq-1 rows — inserts nothing twice.
 */
function backfillExecutionRevisions(db: Database): void {
  db.prepare(`INSERT INTO plan_execution_revisions (execution_id, seq, revision, content_hash, report_id, input_hash, applied_at)
    SELECT e.id, 1, e.revision, e.content_hash, e.report_id, e.input_hash, e.started_at
    FROM plan_executions e
    WHERE NOT EXISTS (SELECT 1 FROM plan_execution_revisions r WHERE r.execution_id = e.id AND r.seq = 1)`).run()
}

export function applyRevisionControlSchema(db: Database): void {
  db.exec(CREATE_REVISION_CONTROL_TABLES_SQL)
  backfillExecutionRevisions(db)
}

export const revisionControlMigration: Migration = {
  version: 17,
  name: 'revision-control',
  up: applyRevisionControlSchema,
}
