// Task status transitions (team-process-metrics design D3): one append-only
// row per status change, written by `TaskStore.setStatus` inside the status
// transaction, so lead time (first `done`) and reopen rate are computable.
// The backfill gives every task already closed when the table appears one
// `system` row (`from_status` null, `at` = the task's `updated_at`); metrics
// read a null `from_status` as approximate. The DDL and backfill are schema
// migration 4 `task-status-events` (`dbSafety/migrations.ts`) and frozen like
// every applied migration: a later change is a new numbered migration.
import type { Database } from 'bun:sqlite'

export const CREATE_TASK_STATUS_EVENTS_SQL = `
CREATE TABLE IF NOT EXISTS team_task_status_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  actor_session TEXT,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS team_task_status_events_team ON team_task_status_events (team_id, at);
CREATE INDEX IF NOT EXISTS team_task_status_events_task ON team_task_status_events (task_id, id);
`

const BACKFILL_CLOSED_TASKS_SQL = `
INSERT INTO team_task_status_events (task_id, team_id, from_status, to_status, actor_kind, actor_session, at)
SELECT id, team_id, NULL, status, 'system', NULL, updated_at
FROM team_tasks WHERE status IN ('done', 'cancelled') ORDER BY updated_at, id
`

/** Migration 3: the table, then the one-time backfill (the version row makes it run once). */
export function migrateTaskStatusEvents(db: Database): void {
  db.exec(CREATE_TASK_STATUS_EVENTS_SQL)
  db.exec(BACKFILL_CLOSED_TASKS_SQL)
}
