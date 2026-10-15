// A raw bun:sqlite database with the baseline schema applied, for tests that
// build stores directly. Stores no longer create their own tables
// (execution-safety-recovery D13): `initDatabase` runs the baseline once, so a
// store-level test applies it the same way.
import { Database } from 'bun:sqlite'
import { applyBaselineSchema } from '../dbSafety/baseline'

export function schemaDb(filename = ':memory:'): Database {
  const db = new Database(filename)
  applyBaselineSchema(db)
  return db
}
