// Decision schema (plan-supervision design D3) and the numbered migration
// `plan-supervision` in `dbSafety/migrations.ts`, frozen like every applied
// migration. It adds three tables here — decision cards, their decisions,
// and the fix and correction tasks — plus the stall alerts of
// `supervision/supervisionSchema.ts`. The database arbitrates the races:
// - `UNIQUE (card_id, seq)`: one first decision per card, one override per
//   step (the Lead against the owner, two overrides against each other);
// - `UNIQUE (plan_id, command_id)`: a human command replays; SQLite treats
//   null command ids as distinct, so agent decisions never collide;
// - `UNIQUE (source_kind, source_id)`: one fix task per override and one
//   correction task per promotion.
// A card's state is derived from its decisions, never stored. Additive, no
// backfill; usage reads team-process-metrics' `chat_turn_usage` (D14).
import type { Database } from 'bun:sqlite'
import type { Migration } from '../../dbSafety/migrations'
import { CREATE_SUPERVISION_TABLES_SQL } from '../supervision/supervisionSchema'

export const CREATE_DECISION_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS plan_decision_cards (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  revision INTEGER,
  change TEXT,
  task_id TEXT,
  question TEXT NOT NULL,
  options_json TEXT NOT NULL,
  context TEXT,
  asked_by_session TEXT NOT NULL,
  asked_by_group TEXT,
  asked_by_profile TEXT,
  addressed_to TEXT NOT NULL,
  addressed_group TEXT,
  message_id TEXT UNIQUE,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS plan_decision_cards_plan ON plan_decision_cards(plan_id, created_at);
CREATE INDEX IF NOT EXISTS plan_decision_cards_task ON plan_decision_cards(task_id);

CREATE TABLE IF NOT EXISTS plan_decisions (
  id TEXT PRIMARY KEY,
  card_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  choice TEXT NOT NULL,
  option_index INTEGER,
  rationale TEXT,
  decided_by_kind TEXT NOT NULL,
  decided_by_session TEXT,
  decided_by_group TEXT,
  decided_by_profile TEXT,
  affected_json TEXT NOT NULL,
  command_id TEXT,
  payload_json TEXT,
  reply_message_id TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (card_id, seq),
  UNIQUE (plan_id, command_id)
);
CREATE INDEX IF NOT EXISTS plan_decisions_team ON plan_decisions(team_id, created_at);

CREATE TABLE IF NOT EXISTS plan_fix_tasks (
  task_id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  source_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (source_kind, source_id)
);
CREATE INDEX IF NOT EXISTS plan_fix_tasks_plan ON plan_fix_tasks(plan_id);
`

export function applyPlanSupervisionSchema(db: Database): void {
  db.exec(CREATE_DECISION_TABLES_SQL)
  db.exec(CREATE_SUPERVISION_TABLES_SQL)
}

export const planSupervisionMigration: Migration = {
  version: 16,
  name: 'plan-supervision',
  up: applyPlanSupervisionSchema,
}
