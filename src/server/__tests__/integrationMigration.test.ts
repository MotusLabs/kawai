// Schema migration `integration-candidates` (integration-candidates D3 on
// execution-safety-recovery D13–D14), task 2.1. Two databases each open
// twice: a fresh one, and one at version 12 that already has plan-execution's
// and process-observations' tables and rows. Each gains the four tables and the one-running-promotion
// index exactly once and keeps every earlier row.
//
// The registry under test is the build's own MIGRATIONS; the version-12
// database is opened with every entry up to 12 (providers-and-workers').
import { afterEach, beforeEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Database } from 'bun:sqlite'
import { initDatabase } from '../db'
import { MIGRATIONS, type Migration } from '../dbSafety/migrations'
import { integrationMigration } from '../plans/landing/integration/integrationSchema'

const INTEGRATION_TABLES = ['plan_integration_branches', 'plan_integration_candidates', 'plan_promotion_effects', 'plan_promotions']
const UP_TO_12: readonly Migration[] = MIGRATIONS.filter(migration => migration.version <= 12)
const REGISTRY: readonly Migration[] = MIGRATIONS

let dir: string
let dbPath: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-integration-migration-'))
  dbPath = path.join(dir, 'agentboard.db')
})
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

function tables(file: string): Record<string, unknown[]> {
  const db = new Database(file, { readonly: true })
  try {
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != 'schema_migrations' ORDER BY name").all() as Array<{ name: string }>)
      .map(row => row.name)
    return Object.fromEntries(names.map(name => [name, db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()]))
  } finally { db.close() }
}

function versions(file: string): Array<{ version: number; name: string }> {
  const db = new Database(file, { readonly: true })
  try {
    return db.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all() as Array<{ version: number; name: string }>
  } finally { db.close() }
}

function indexes(file: string): string[] {
  const db = new Database(file, { readonly: true })
  try {
    return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string }>).map(row => row.name)
  } finally { db.close() }
}

test('integration-candidates is migration 13, registered right after provider-limit-window', () => {
  expect(integrationMigration.version).toBe(13)
  expect(MIGRATIONS.find(migration => migration.version === 13)).toBe(integrationMigration)
  expect(MIGRATIONS.find(migration => migration.version === 12)!.name).toBe('provider-limit-window')
})

test('a fresh database, opened twice, gains the tables and the index once', () => {
  for (let run = 0; run < 2; run++) initDatabase({ path: dbPath, migrations: REGISTRY }).close()
  const after = tables(dbPath)
  expect(INTEGRATION_TABLES.filter(table => table in after)).toEqual(INTEGRATION_TABLES)
  expect(indexes(dbPath)).toContain('plan_promotions_one_running')
  const recorded = versions(dbPath)
  expect(recorded.filter(row => row.version === 13)).toEqual([{ version: 13, name: 'integration-candidates' }])
  expect(recorded.map(row => row.version)).toEqual(recorded.map((_, index) => index + 1))
})

test('a database at version 12 with plan-execution rows upgrades, twice, keeping every row', () => {
  const at12 = initDatabase({ path: dbPath, migrations: UP_TO_12 })
  at12.db.prepare(`INSERT INTO plan_landing_slots (team_id, holder_kind, holder_id, since) VALUES ('t', 'change', 'e:alpha', 'now')`).run()
  at12.db.prepare(`INSERT INTO plan_change_landings (plan_id, change, execution_id, team_id, mechanism, head_sha, base_sha, merge_sha, landed_at, tree_verified)
    VALUES ('p', 'alpha', 'e', 't', 'direct', 'h', 'b', 'm', 'now', 1)`).run()
  at12.close()
  const before = tables(dbPath)
  expect(INTEGRATION_TABLES.filter(table => table in before)).toEqual([])
  // The earlier tables are really there: plan-execution's and process-observations' (master's 11).
  expect(['plan_landing_slots', 'plan_change_landings', 'process_observations'].filter(table => table in before)).toHaveLength(3)
  expect(versions(dbPath).at(-1)!.version).toBe(12)

  for (let run = 0; run < 2; run++) initDatabase({ path: dbPath, migrations: REGISTRY }).close()
  const after = tables(dbPath)
  for (const [table, rows] of Object.entries(before)) expect(after[table]).toEqual(rows)
  expect(Object.keys(after).filter(table => !(table in before)).sort()).toEqual(INTEGRATION_TABLES)
  expect(versions(dbPath).filter(row => row.version === 13)).toHaveLength(1)
})

test("rerunning the migration's up is a no-op", () => {
  initDatabase({ path: dbPath, migrations: REGISTRY }).close()
  const db = new Database(dbPath)
  db.prepare(`INSERT INTO plan_integration_branches (team_id, branch, plan_id, target_branch, created_by, created_sha, created_at)
    VALUES ('t', 'wave/int', 'p', 'master', 'e', 'sha', 'now')`).run()
  const before = tables(dbPath)
  integrationMigration.up(db)
  integrationMigration.up(db)
  db.close()
  expect(tables(dbPath)).toEqual(before)
})
