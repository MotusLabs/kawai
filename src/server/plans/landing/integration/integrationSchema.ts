// Integration-branch schema (integration-candidates design D3), the numbered
// migration `integration-candidates` in `dbSafety/migrations.ts`, frozen like
// every applied migration. It adds four tables beside plan-execution's:
// - the integration branches;
// - their exact candidates;
// - promotions;
// - promotion effects, shaped like `plan_execution_effects` and keyed by
//   promotion, since a promotion belongs to no execution.
// The database arbitrates three races:
// - one sequence number per branch, `UNIQUE (team_id, branch, seq)`;
// - one running promotion per plan, a partial unique index;
// - a Promote replay, `UNIQUE (plan_id, command_id)`.
// Additive, no backfill. Pure DDL: no policy, no writes.
import type { Database } from 'bun:sqlite'
import type { Migration } from '../../../dbSafety/migrations'

export const CREATE_INTEGRATION_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS plan_integration_branches (
  team_id TEXT NOT NULL,
  branch TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  target_branch TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_sha TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (team_id, branch)
);

CREATE TABLE IF NOT EXISTS plan_integration_candidates (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  branch TEXT NOT NULL,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  execution_id TEXT,
  change TEXT,
  result_id TEXT,
  round_id TEXT,
  promotion_id TEXT,
  baseline_sha TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  tree_sha TEXT NOT NULL,
  outside_json TEXT,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  decided_at TEXT,
  UNIQUE (team_id, branch, seq)
);

CREATE TABLE IF NOT EXISTS plan_promotions (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  branch TEXT NOT NULL,
  number INTEGER NOT NULL,
  command_id TEXT NOT NULL,
  from_sha TEXT NOT NULL,
  through_seq INTEGER NOT NULL,
  target_branch TEXT NOT NULL,
  promotion_branch TEXT NOT NULL,
  floor_json TEXT NOT NULL,
  pr_number INTEGER,
  pr_url TEXT,
  head_sha TEXT,
  step TEXT,
  moves INTEGER NOT NULL DEFAULT 0,
  ci_json TEXT,
  rerun_at TEXT,
  ci_window_from TEXT,
  state TEXT NOT NULL,
  outcome TEXT,
  outcome_detail_json TEXT,
  merge_sha TEXT,
  tree_verified INTEGER,
  fast_forwarded INTEGER,
  fast_forward_note TEXT,
  cancel_reason TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  UNIQUE (plan_id, number),
  UNIQUE (plan_id, command_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS plan_promotions_one_running ON plan_promotions(plan_id) WHERE state = 'running';

CREATE TABLE IF NOT EXISTS plan_promotion_effects (
  id TEXT PRIMARY KEY,
  promotion_id TEXT NOT NULL,
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
`

/** The migration's `up`: idempotent DDL, so `schemaDb` can re-apply it on an existing file. */
export function applyIntegrationSchema(db: Database): void {
  db.exec(CREATE_INTEGRATION_TABLES_SQL)
}

/** Migration 13, after providers-and-workers' 12; numbers stay dense from the baseline (E5). */
export const integrationMigration: Migration = {
  version: 13,
  name: 'integration-candidates',
  up: applyIntegrationSchema,
}
