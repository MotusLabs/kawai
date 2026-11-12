// helperUser.test.ts - testDbTemplate's TD1 probe for an ordinary test: it
// opens its database through freshTestDatabase and reports the backups
// beside it and whether the runner exported a template.
import { test } from 'bun:test'
import { freshTestDatabase } from '../../../../src/server/__tests__/helpers/testDatabase'
import { reportBackups } from './reportBackups'

test('opens a fresh database from the template', () => {
  const dbPath = process.env.AGENTBOARD_DB_PATH!
  freshTestDatabase(dbPath).close()
  reportBackups('helper', dbPath)
})
