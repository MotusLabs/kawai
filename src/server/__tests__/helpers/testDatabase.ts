// testDatabase.ts - A fresh, fully migrated test database without running the
// migrations (check-time-optimization D5). Under the unit runner,
// KAWAI_TEST_DB_TEMPLATE names the run's template (scripts/lib/
// testDbTemplate.ts: migrated once, closed, one self-contained file);
// freshTestDatabase copies it to `dbPath` and opens the copy with the
// production initDatabase, which finds no pending migration and so takes no
// pre-migration backup. Under a bare `bun test` (no template) it opens a new
// file, which migrates as before. initDatabase still takes its `startup`
// snapshot of the copy, as it does on every open.
//
// Tests of migrations, backups, restore, compaction, and startup refusals
// keep calling initDatabase on new files and never use this helper:
// schemaMigrations, schemaBaselinePin, databaseBackups, databaseRestore,
// databaseCompaction, and every *Migration.test.ts
// (codexSession, integration, planExecution, planSupervision,
// planValidation, planWorkspace, providerLimitWindow, reviewConvergence,
// reviewFindings, revisionControl, strategyImpact, taskStall,
// taskStatusEvents, workerChoice).

import fs from 'node:fs'
import path from 'node:path'
import { initDatabase, type SessionDatabase } from '../../db'

export const TEMPLATE_ENV = 'KAWAI_TEST_DB_TEMPLATE'

export function freshTestDatabase(dbPath: string, env: NodeJS.ProcessEnv = process.env): SessionDatabase {
  const template = env[TEMPLATE_ENV]
  if (template) {
    if (fs.existsSync(dbPath)) throw new Error(`freshTestDatabase: ${dbPath} already exists`)
    fs.mkdirSync(path.dirname(dbPath), { recursive: true })
    fs.copyFileSync(template, dbPath)
  }
  return initDatabase({ path: dbPath })
}
