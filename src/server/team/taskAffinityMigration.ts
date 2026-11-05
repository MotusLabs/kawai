// Migration `task-affinity` (group-mail-task-affinity D1, D7): the task a
// group message is about (`team_messages.affinity_task`, recorded at send for
// groups with `affinity: task-owner`; the owner is read from the task at route
// time) and a task's current owner (`team_tasks.owner_session`). Both
// nullable. Existing messages keep no affinity task; existing agent-created
// tasks are backfilled with their creator as owner, so nothing changes for a
// task until it is transferred. Human and Kawai tasks have no owner.
//
// The version is the next free one in the master this branch has merged (the
// registry must stay dense) and is renumbered at a later master merge.
import type { Database } from 'bun:sqlite'
import type { Migration } from '../dbSafety/migrations'

export const TASK_AFFINITY_MIGRATION_VERSION = 23

const hasColumn = (db: Database, table: string, column: string) =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some(row => row.name === column)

export function applyTaskAffinityColumns(db: Database): void {
  if (!hasColumn(db, 'team_messages', 'affinity_task')) db.exec('ALTER TABLE team_messages ADD COLUMN affinity_task TEXT')
  if (!hasColumn(db, 'team_tasks', 'owner_session')) {
    db.exec('ALTER TABLE team_tasks ADD COLUMN owner_session TEXT')
    db.exec("UPDATE team_tasks SET owner_session = creator_session WHERE creator_kind = 'agent' AND creator_session IS NOT NULL")
  }
}

export const taskAffinityMigration: Migration = {
  version: TASK_AFFINITY_MIGRATION_VERSION,
  name: 'task-affinity',
  up: applyTaskAffinityColumns,
}
