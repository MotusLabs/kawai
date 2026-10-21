// Migration `worker-choice` (dispatch-worker-choice D1): the canonical worker
// selector a sender chose for group mail (`team_messages.worker_choice`) and
// for a dispatch (`team_task_assignments.worker_choice`) — a provider id or
// `provider/model`, resolved to the group's model keys at route time. Both
// nullable; old rows read as no choice. Additive, no backfill.
//
// The version is the next free one in the master this branch has merged (the
// registry must stay dense) and is renumbered at a later master merge.
import type { Database } from 'bun:sqlite'
import type { Migration } from '../dbSafety/migrations'

export const WORKER_CHOICE_MIGRATION_VERSION = 17

export function applyWorkerChoiceColumns(db: Database): void {
  for (const table of ['team_messages', 'team_task_assignments']) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
    if (!columns.some(column => column.name === 'worker_choice')) db.exec(`ALTER TABLE ${table} ADD COLUMN worker_choice TEXT`)
  }
}

export const workerChoiceMigration: Migration = {
  version: WORKER_CHOICE_MIGRATION_VERSION,
  name: 'worker-choice',
  up: applyWorkerChoiceColumns,
}
