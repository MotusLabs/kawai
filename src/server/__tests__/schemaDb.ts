// Store tests use the production versioned runner without backups. Reopening a fixture
// applies only pending migrations; numbered migrations need not be individually repeatable.
import { Database } from 'bun:sqlite'
import { migrateSchema } from '../dbSafety/migrations'

export function schemaDb(filename = ':memory:'): Database {
  const db = new Database(filename)
  migrateSchema(db, filename, { backups: null })
  return db
}
