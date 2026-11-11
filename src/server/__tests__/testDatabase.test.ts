// testDatabase.test.ts - The template test database (check-time-optimization
// D5, tasks 5.1, 5.2): TD2, a freshTestDatabase copy opens at the
// registry's latest schema version with exactly the registry's migrations
// recorded and no pre-migration backup; the bare-`bun test` fallback
// migrates a new file; the template build leaves one self-contained file
// and fails naming a failing migration.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { BASELINE_NAME, BASELINE_VERSION, MIGRATIONS, newestVersion, readSchemaVersion } from '../dbSafety/migrations'
import { buildTemplateDatabase, TEMPLATE_NAME } from '../../../scripts/lib/testDbTemplate'
import { freshTestDatabase, TEMPLATE_ENV } from './helpers/testDatabase'

let dir: string

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-test-db-')))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

const preMigrationBackups = (dbDir: string): string[] => {
  try {
    return fs.readdirSync(path.join(dbDir, 'backups')).filter((name) => name.includes('pre-migration-'))
  } catch {
    return []
  }
}

function recorded(dbPath: string, open: (dbPath: string) => ReturnType<typeof freshTestDatabase>) {
  const database = open(dbPath)
  try {
    const rows = database.db.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all() as Array<{ version: number; name: string }>
    return { version: readSchemaVersion(database.db), rows }
  } finally {
    database.close()
  }
}

const REGISTRY = [
  { version: BASELINE_VERSION, name: BASELINE_NAME },
  ...MIGRATIONS.map(({ version, name }) => ({ version, name })),
]

// @covers: dev-checks › Test databases start from a migrated template › A fresh test database
test('TD2: a copy of the template opens at the latest version, records exactly the registry, and takes no pre-migration backup', () => {
  const runRoot = path.join(dir, 'run')
  fs.mkdirSync(runRoot)
  const template = buildTemplateDatabase(runRoot)
  const fileRoot = path.join(dir, 'file')
  const result = recorded(path.join(fileRoot, 'agentboard.db'), (dbPath) => freshTestDatabase(dbPath, { [TEMPLATE_ENV]: template }))
  expect(result.version).toBe(newestVersion())
  expect(result.rows).toEqual(REGISTRY)
  expect(preMigrationBackups(fileRoot)).toEqual([])
})

// @covers: dev-checks › Test databases start from a migrated template › No runner
test('without a template (a bare bun test) the helper migrates a new file, taking its pre-migration backups', () => {
  const fileRoot = path.join(dir, 'bare')
  const result = recorded(path.join(fileRoot, 'agentboard.db'), (dbPath) => freshTestDatabase(dbPath, {}))
  expect(result.version).toBe(newestVersion())
  expect(result.rows).toEqual(REGISTRY)
  // Rotation keeps the newest few; any at all shows the migrations ran.
  expect(preMigrationBackups(fileRoot).length).toBeGreaterThan(0)
})

test('the helper refuses to overwrite an existing database with the template', () => {
  const template = buildTemplateDatabase(dir)
  const target = path.join(dir, 'existing.db')
  fs.writeFileSync(target, 'not a database')
  expect(() => freshTestDatabase(target, { [TEMPLATE_ENV]: template })).toThrow('already exists')
})

test('the closed template is one file: no -wal, -shm, or -journal beside it', () => {
  const template = buildTemplateDatabase(dir)
  expect(path.basename(template)).toBe(TEMPLATE_NAME)
  const beside = fs.readdirSync(dir).filter((name) => name.startsWith(TEMPLATE_NAME))
  expect(beside).toEqual([TEMPLATE_NAME])
})

test('a failing migration fails the template build, naming the migration', () => {
  const failing = [
    ...MIGRATIONS,
    { version: newestVersion() + 1, name: 'fixture-boom', up: () => { throw new Error('boom') } },
  ]
  expect(() => buildTemplateDatabase(dir, failing)).toThrow(`Migration ${newestVersion() + 1} (fixture-boom) failed`)
})
