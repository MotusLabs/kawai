// Store tests use the production versioned runner without backups. Reopening a fixture
// applies only pending migrations; numbered migrations need not be individually repeatable.
import { Database } from 'bun:sqlite'
import { migrateSchema } from '../dbSafety/migrations'

export function schemaDb(filename = ':memory:'): Database {
  const db = new Database(filename)
  migrateSchema(db, filename, { backups: null })
  return db
}

let template: Uint8Array | null = null

/** A fresh in-memory database with the full schema, deserialized from one migrated
 * template per process (~1 ms against ~123 ms for a file-backed initDatabase).
 * For store tests that never reopen a file; a test whose subject is the migration
 * itself, or persistence across a real close/reopen, uses schemaDb()/initDatabase. */
export function schemaCopy(): Database {
  if (template === null) {
    const db = new Database(':memory:')
    migrateSchema(db, ':memory:', { backups: null })
    template = db.serialize()
    db.close()
  }
  return Database.deserialize(template)
}
