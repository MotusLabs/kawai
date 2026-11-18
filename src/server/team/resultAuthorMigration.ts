// Migration `result-author-profile` (starter-team-setup D5): the submitting
// session's profile id on each task result
// (`team_task_results.submitted_by_profile`), snapshotted at submission so a
// review can name its authors' model families after the implementer is
// released or its session record removed. Nullable; older rows resolve
// through the session record. Additive, no backfill.
//
// The version is the next free one in the master this branch has merged (the
// registry must stay dense) and is renumbered at a later master merge.
import type { Database } from 'bun:sqlite'
import type { Migration } from '../dbSafety/migrations'

export const RESULT_AUTHOR_MIGRATION_VERSION = 28

export function applyResultAuthorColumn(db: Database): void {
  const columns = db.prepare('PRAGMA table_info(team_task_results)').all() as Array<{ name: string }>
  if (!columns.some(column => column.name === 'submitted_by_profile')) {
    db.exec('ALTER TABLE team_task_results ADD COLUMN submitted_by_profile TEXT')
  }
}

export const resultAuthorMigration: Migration = {
  version: RESULT_AUTHOR_MIGRATION_VERSION,
  name: 'result-author-profile',
  up: applyResultAuthorColumn,
}
