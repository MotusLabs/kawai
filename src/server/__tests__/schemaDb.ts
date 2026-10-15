// A raw bun:sqlite database with this build's schema applied, for tests that
// build stores directly. Stores no longer create their own tables
// (execution-safety-recovery D13): `initDatabase` runs the baseline once and
// then every numbered migration, so a store-level test applies the same steps
// (without the version rows and backups the runner adds).
import { Database } from 'bun:sqlite'
import { applyBaselineSchema } from '../dbSafety/baseline'
import { MIGRATIONS } from '../dbSafety/migrations'

export function schemaDb(filename = ':memory:'): Database {
  const db = new Database(filename)
  applyBaselineSchema(db)
  for (const migration of MIGRATIONS) migration.up(db)
  return db
}
