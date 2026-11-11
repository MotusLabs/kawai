// migrationUser.test.ts - testDbTemplate's TD1 probe for a migration test:
// it opens a new database at its runner-provided path with initDatabase, as
// migration tests do, and reports the backups beside it to KAWAI_PROBE_OUT.
import { test } from 'bun:test'
import { initDatabase } from '../../../../src/server/db'
import { reportBackups } from './reportBackups'

test('migrates a new database', () => {
  const dbPath = process.env.AGENTBOARD_DB_PATH!
  initDatabase({ path: dbPath }).close()
  reportBackups('migration', dbPath)
})
