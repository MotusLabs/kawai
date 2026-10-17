// Plan execution schema (plan-execution design D3), the numbered migration
// `plan-execution` in `dbSafety/migrations.ts`, frozen like every applied
// migration. Seven tables beside the plan tables — executions, their changes,
// the team's landing slot, attempts, rounds, effects, and landing facts — plus
// `team_messages.allowed_profiles` (D15). The database arbitrates three races:
// one running execution per plan and one owner per team and change (partial
// unique indexes), and one landing slot per team (the slot table's primary
// key). Additive, no backfill. Pure DDL: no policy, no writes.
import type { Database } from 'bun:sqlite'

export const CREATE_EXECUTION_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS plan_executions (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  report_id TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  landing_mode TEXT NOT NULL,
  base_branch TEXT NOT NULL,
  base_commit TEXT NOT NULL,
  floor_json TEXT NOT NULL,
  max_parallel INTEGER NOT NULL,
  merge_method TEXT NOT NULL,
  state TEXT NOT NULL,
  outcome TEXT,
  stop_reason TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS plan_executions_one_running ON plan_executions(plan_id) WHERE state = 'running';
CREATE INDEX IF NOT EXISTS plan_executions_team ON plan_executions(team_id, state);

CREATE TABLE IF NOT EXISTS plan_execution_changes (
  execution_id TEXT NOT NULL,
  change TEXT NOT NULL,
  team_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  state TEXT NOT NULL,
  step TEXT,
  stop_reason TEXT,
  stop_detail_json TEXT,
  task_id TEXT,
  worktree TEXT,
  branch TEXT,
  baseline_commit TEXT,
  pr_number INTEGER,
  pr_url TEXT,
  pr_opened_by_kawai INTEGER,
  fix_rounds INTEGER NOT NULL DEFAULT 0,
  owns INTEGER NOT NULL DEFAULT 1,
  passed_at TEXT,
  generation INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (execution_id, change)
);
CREATE UNIQUE INDEX IF NOT EXISTS plan_execution_changes_owner ON plan_execution_changes(team_id, change) WHERE owns = 1;
CREATE INDEX IF NOT EXISTS plan_execution_changes_task ON plan_execution_changes(task_id);

CREATE TABLE IF NOT EXISTS plan_landing_slots (
  team_id TEXT PRIMARY KEY,
  holder_kind TEXT NOT NULL,
  holder_id TEXT NOT NULL,
  since TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS plan_execution_attempts (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL,
  change TEXT NOT NULL,
  number INTEGER NOT NULL,
  kind TEXT NOT NULL,
  assignment_id TEXT,
  manifest_json TEXT NOT NULL,
  manifest_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (execution_id, change, number)
);

CREATE TABLE IF NOT EXISTS plan_execution_rounds (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL,
  change TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  number INTEGER NOT NULL,
  result_id TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  fix_round INTEGER NOT NULL,
  carried_from TEXT,
  pushed_at TEXT,
  ci_window_from TEXT,
  ci_json TEXT,
  rerun_at TEXT,
  review_assignment_id TEXT,
  verdict_findings_id TEXT,
  extra_json TEXT,
  outcome TEXT,
  outcome_detail_json TEXT,
  decided_at TEXT,
  UNIQUE (execution_id, change, number)
);

CREATE TABLE IF NOT EXISTS plan_execution_effects (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL,
  change TEXT,
  round_id TEXT,
  kind TEXT NOT NULL,
  effect_key TEXT NOT NULL UNIQUE,
  command_json TEXT NOT NULL,
  state TEXT NOT NULL,
  tries INTEGER NOT NULL DEFAULT 0,
  next_at TEXT,
  outcome_json TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS plan_execution_effects_execution ON plan_execution_effects(execution_id, state);

CREATE TABLE IF NOT EXISTS plan_change_landings (
  plan_id TEXT NOT NULL,
  change TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  mechanism TEXT NOT NULL,
  pr_number INTEGER,
  pr_url TEXT,
  head_sha TEXT NOT NULL,
  base_sha TEXT NOT NULL,
  merge_sha TEXT NOT NULL,
  landed_at TEXT NOT NULL,
  tree_verified INTEGER NOT NULL,
  post_ci_json TEXT,
  PRIMARY KEY (plan_id, change)
);
`

/** The migration's `up`: the tables, then the routing column (D15) unless a rerun already added it. */
export function applyExecutionSchema(db: Database): void {
  db.exec(CREATE_EXECUTION_TABLES_SQL)
  const columns = db.prepare('PRAGMA table_info(team_messages)').all() as Array<{ name: string }>
  if (!columns.some(column => column.name === 'allowed_profiles')) {
    // A JSON array of profile ids in the role's order; null for unrestricted mail.
    db.exec('ALTER TABLE team_messages ADD COLUMN allowed_profiles TEXT')
  }
}
