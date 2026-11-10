// The manual-task stall notices (manual-task-stall-alerts D3): one additive
// migration with no backfill. One row per notice; `(task_id, anchor_at)` is
// the replay key, so a re-handed episode inserts nothing. The newest row's
// `created_at` anchors the task's next episode. `message_id` is null for a
// human creator or when no mailbox is attached.
import type { Database } from 'bun:sqlite'
import type { Migration } from '../dbSafety/migrations'

export const TASK_STALL_MIGRATION_VERSION = 26

export const CREATE_TASK_STALL_NOTICES_SQL = `
CREATE TABLE IF NOT EXISTS team_task_stall_notices (
  task_id TEXT NOT NULL,
  anchor_at TEXT NOT NULL,
  anchor_kind TEXT NOT NULL,
  message_count INTEGER NOT NULL,
  message_id TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (task_id, anchor_at)
);
`

export const taskStallMigration: Migration = {
  version: TASK_STALL_MIGRATION_VERSION,
  name: 'task-stall-notices',
  up: (db: Database) => db.exec(CREATE_TASK_STALL_NOTICES_SQL),
}
