// Schema versions (execution-safety-recovery D13–D14): a database written
// before versions existed opens with every row and column intact and records
// version 1; a fresh database records every version; the baseline runs only
// on an unversioned database; a migration applies whole after its checked
// backup; and a database newer than the build is refused before any write.
// Every database lives in a temporary directory.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Database } from 'bun:sqlite'
import { initDatabase } from '../db'
import { applyBaselineSchema } from '../dbSafety/baseline'
import { DatabaseBackups } from '../dbSafety/backups'
import {
  DatabaseStartupError,
  MIGRATIONS,
  migrateSchema,
  newestVersion,
  readSchemaVersion,
  type Migration,
  type MigrationBackups,
} from '../dbSafety/migrations'

let dir: string
let dbPath: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-schema-version-'))
  dbPath = path.join(dir, 'agentboard.db')
})
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

const NOW = '2026-01-01T00:00:00.000Z'

/** A database exactly as master wrote it before this change: every table, rows in many of them, no version. */
function preChangeDatabase(): void {
  const db = new Database(dbPath)
  applyBaselineSchema(db)
  db.exec(`
    INSERT INTO agent_sessions (session_id, log_file_path, project_path, agent_type, display_name, created_at, last_activity_at)
      VALUES ('agent-1', '/logs/a.jsonl', '/repo', 'claude', 'alpha', '${NOW}', '${NOW}');
    INSERT INTO app_settings (key, value) VALUES ('theme', 'dark');
    INSERT INTO chat_sessions (session_id, name, project_path, status, created_at, last_activity_at, group_id)
      VALUES ('chat-1', 'one', '/repo', 'waiting', '${NOW}', '${NOW}', 'devs');
    INSERT INTO team_messages (id, team_id, to_kind, to_id, from_session, origin_path, thread_id, body, state, created_at)
      VALUES ('m1', '/repo/.git', 'group', 'devs', 'chat-1', '/repo', 'm1', 'hello', 'delivered', '${NOW}');
    INSERT INTO team_tasks (id, team_id, title, status, creator_kind, revision, created_at, updated_at)
      VALUES ('task-1', '/repo/.git', 'Task', 'open', 'human', 1, '${NOW}', '${NOW}');
    INSERT INTO team_task_revisions (task_id, revision, direction, author_kind, created_at)
      VALUES ('task-1', 1, 'Do it', 'human', '${NOW}');
    INSERT INTO team_session_directory (team_id, session_id, name, updated_at) VALUES ('/repo/.git', 'chat-1', 'one', '${NOW}');
    INSERT INTO chat_turn_ends (session_id, task_id, ended_at, ok) VALUES ('chat-1', 'task-1', '${NOW}', 1);
  `)
  db.close()
}

/** Every table's columns and rows, for a before/after comparison. */
function dump(file: string): Record<string, { columns: unknown[]; rows: unknown[] }> {
  const db = new Database(file, { readonly: true })
  try {
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != 'schema_migrations' ORDER BY name").all() as Array<{ name: string }>)
      .map(row => row.name)
    return Object.fromEntries(tables.map(name => [name, {
      columns: db.prepare(`PRAGMA table_info(${name})`).all(),
      rows: db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all(),
    }]))
  } finally {
    db.close()
  }
}

function versions(file: string): Array<{ version: number; name: string; backup_path: string | null; app_version: string }> {
  const db = new Database(file, { readonly: true })
  try {
    return db.prepare('SELECT version, name, backup_path, app_version FROM schema_migrations ORDER BY version').all() as never
  } finally {
    db.close()
  }
}

function userVersion(file: string): number {
  const db = new Database(file, { readonly: true })
  try { return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version } finally { db.close() }
}

const addColumn = (version: number, table: string, column: string): Migration => ({
  version, name: `add-${column}`, up: db => db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`),
})

describe('baseline', () => {
  test('the first start on a pre-change database keeps every table, column, and row, and records version 1', () => {
    preChangeDatabase()
    const before = dump(dbPath)
    expect(Object.keys(before).length).toBeGreaterThan(20)
    const db = initDatabase({ path: dbPath, appVersion: '9.9.9-test' })
    expect(db.getChatSession('chat-1')).toMatchObject({ name: 'one', groupId: 'devs' })
    db.close()
    expect(dump(dbPath)).toEqual(before)
    expect(versions(dbPath)).toEqual([{ version: 1, name: 'baseline', backup_path: null, app_version: '9.9.9-test' }])
    expect(userVersion(dbPath)).toBe(1)
  })

  test('a fresh database gets the full schema and records every known version', () => {
    const db = initDatabase({ path: dbPath, migrations: [addColumn(2, 'chat_sessions', 'extra_a'), addColumn(3, 'chat_sessions', 'extra_b')] })
    db.close()
    expect(versions(dbPath).map(row => [row.version, row.name])).toEqual([[1, 'baseline'], [2, 'add-extra_a'], [3, 'add-extra_b']])
    expect(userVersion(dbPath)).toBe(3)
    expect(Object.keys(dump(dbPath))).toEqual(expect.arrayContaining(['agent_sessions', 'team_messages', 'plans', 'product_strategies', 'chat_turn_ends']))
  })

  test('this build ships only the baseline today, and a version-1 database opens applying nothing', () => {
    expect(MIGRATIONS).toEqual([])
    expect(newestVersion()).toBe(1)
    initDatabase({ path: dbPath }).close()
    const before = dump(dbPath)
    const db = initDatabase({ path: dbPath })
    db.close()
    expect(dump(dbPath)).toEqual(before)
    expect(versions(dbPath).map(row => row.version)).toEqual([1])
  })

  test('a database with extra tables records version 1 and keeps them untouched', () => {
    preChangeDatabase()
    const raw = new Database(dbPath)
    raw.exec("CREATE TABLE branch_experiment (id INTEGER PRIMARY KEY, note TEXT); INSERT INTO branch_experiment (note) VALUES ('keep')")
    raw.close()
    initDatabase({ path: dbPath }).close()
    expect(dump(dbPath).branch_experiment?.rows).toEqual([{ id: 1, note: 'keep' }])
    expect(versions(dbPath).map(row => row.version)).toEqual([1])
  })

  test('the baseline runs only on an unversioned database: a dropped baseline column stays dropped across a restart', () => {
    const drop: Migration = { version: 2, name: 'drop-model', up: db => db.exec('ALTER TABLE chat_sessions DROP COLUMN model') }
    initDatabase({ path: dbPath, migrations: [drop] }).close()
    initDatabase({ path: dbPath, migrations: [drop] }).close()
    const columns = (dump(dbPath).chat_sessions!.columns as Array<{ name: string }>).map(column => column.name)
    expect(columns).not.toContain('model')
    expect(versions(dbPath).map(row => row.version)).toEqual([1, 2])
  })
})

describe('pending migrations', () => {
  test('apply in order, each after its own pre-migration backup, from version 1', () => {
    initDatabase({ path: dbPath }).close()
    const db = initDatabase({ path: dbPath, migrations: [addColumn(2, 'chat_sessions', 'extra_a'), addColumn(3, 'chat_sessions', 'extra_b')] })
    db.close()
    const rows = versions(dbPath)
    expect(rows.map(row => row.version)).toEqual([1, 2, 3])
    for (const row of rows.slice(1)) {
      expect(path.basename(row.backup_path!)).toMatch(new RegExp(`^agentboard-\\d{8}T\\d{9}Z-pre-migration-${row.version}\\.db$`))
      expect(fs.existsSync(row.backup_path!)).toBe(true)
    }
    // Each backup is the database before its migration: 2's lacks extra_a, 3's has extra_a but not extra_b.
    const columnsOf = (file: string) => (dump(file).chat_sessions!.columns as Array<{ name: string }>).map(column => column.name)
    expect(columnsOf(rows[1]!.backup_path!)).not.toContain('extra_a')
    expect(columnsOf(rows[2]!.backup_path!)).toContain('extra_a')
    expect(columnsOf(rows[2]!.backup_path!)).not.toContain('extra_b')
    expect(userVersion(dbPath)).toBe(3)
  })

  test('a migration that throws midway rolls back, records nothing, and refuses start naming it and its backup', () => {
    initDatabase({ path: dbPath }).close()
    const failing: Migration = {
      version: 2, name: 'half-done',
      up: db => { db.exec('ALTER TABLE chat_sessions ADD COLUMN partial TEXT'); throw new Error('boom') },
    }
    let error: unknown
    try { initDatabase({ path: dbPath, migrations: [failing] }) } catch (caught) { error = caught }
    expect(error).toBeInstanceOf(DatabaseStartupError)
    const message = (error as Error).message
    expect(message).toContain('Migration 2 (half-done)')
    expect(message).toContain('boom')
    expect(message).toMatch(/pre-migration-2\.db/)
    expect(message).toContain('stays at version 1')
    expect((dump(dbPath).chat_sessions!.columns as Array<{ name: string }>).map(column => column.name)).not.toContain('partial')
    expect(versions(dbPath).map(row => row.version)).toEqual([1])
    expect(userVersion(dbPath)).toBe(1)
  })

  test('a failed pre-migration backup refuses start before up() runs, naming the backup', () => {
    initDatabase({ path: dbPath }).close()
    const db = new Database(dbPath)
    let ran = false
    const migration: Migration = { version: 2, name: 'gated', up: () => { ran = true } }
    const backups: MigrationBackups = {
      dir: path.join(dir, 'backups'),
      snapshotSync: reason => reason === 'startup'
        ? { ok: true, reason, path: 'startup.db', bytes: 0, changes: 0 }
        : { ok: false, reason, path: path.join(dir, 'backups', 'x-pre-migration-2.db.corrupt'), error: 'integrity check failed: torn' },
      rotate: () => {},
      files: () => [],
    }
    let error: unknown
    try { migrateSchema(db, dbPath, { backups, migrations: [migration] }) } catch (caught) { error = caught }
    db.close()
    expect(ran).toBe(false)
    expect(error).toBeInstanceOf(DatabaseStartupError)
    expect((error as Error).message).toContain('Migration 2 (gated) did not start')
    expect((error as Error).message).toContain('x-pre-migration-2.db.corrupt')
    expect(versions(dbPath).map(row => row.version)).toEqual([1])
  })

  test('a corrupt pre-migration copy is marked corrupt and refuses start before up() runs', () => {
    initDatabase({ path: dbPath }).close()
    const db = new Database(dbPath)
    const real = new DatabaseBackups({ db, dbPath })
    let calls = 0
    // The startup copy is good; the pre-migration copy is torn mid-file.
    const torn = new DatabaseBackups({
      db, dbPath, serialize: () => { calls++; const bytes = db.serialize(); return calls === 1 ? bytes : bytes.slice(0, 1500) },
    })
    let ran = false
    let error: unknown
    try {
      migrateSchema(db, dbPath, { backups: torn, migrations: [{ version: 2, name: 'gated', up: () => { ran = true } }] })
    } catch (caught) { error = caught }
    db.close()
    expect(ran).toBe(false)
    expect((error as Error).message).toMatch(/pre-migration-2\.db\.corrupt/)
    expect(real.files().filter(file => file.kind === 'corrupt').map(file => file.reason)).toEqual(['pre-migration-2'])
    expect(versions(dbPath).map(row => row.version)).toEqual([1])
  })

  test('the registry must be dense from version 2', () => {
    expect(() => initDatabase({ path: ':memory:', migrations: [addColumn(3, 'chat_sessions', 'x')] })).toThrow(/expected 2/)
  })
})

describe('a database newer than the build', () => {
  test('is refused before any write, naming both versions and the pre-migration backup; the file is unchanged', () => {
    initDatabase({ path: dbPath, migrations: [addColumn(2, 'chat_sessions', 'a'), addColumn(3, 'chat_sessions', 'b')] }).close()
    const bytes = fs.readFileSync(dbPath)
    const mtime = fs.statSync(dbPath).mtimeMs
    const backupsBefore = fs.readdirSync(path.join(dir, 'backups')).sort()
    const premigration3 = backupsBefore.find(name => name.endsWith('-pre-migration-3.db'))!
    let error: unknown
    try { initDatabase({ path: dbPath, migrations: [addColumn(2, 'chat_sessions', 'a')] }) } catch (caught) { error = caught }
    expect(error).toBeInstanceOf(DatabaseStartupError)
    const message = (error as Error).message
    expect(message).toContain('schema version 3')
    expect(message).toContain('only up to version 2')
    expect(message).toContain(premigration3)
    expect(message).toContain('docs/operations/database-backups.md')
    expect(fs.readFileSync(dbPath).equals(bytes)).toBe(true)
    expect(fs.statSync(dbPath).mtimeMs).toBe(mtime)
    // No startup snapshot either: the refusal comes first.
    expect(fs.readdirSync(path.join(dir, 'backups')).sort()).toEqual(backupsBefore)
  })

  test('a newer database with no matching backup says none was found', () => {
    initDatabase({ path: dbPath, migrations: [addColumn(2, 'chat_sessions', 'a')] }).close()
    fs.rmSync(path.join(dir, 'backups'), { recursive: true })
    let error: unknown
    try { initDatabase({ path: dbPath }) } catch (caught) { error = caught }
    expect((error as Error).message).toContain('No pre-migration-2 backup was found')
  })

  test('reading the version never writes', () => {
    const db = new Database(dbPath)
    expect(readSchemaVersion(db)).toBe(0)
    db.close()
    expect(fs.statSync(dbPath).size).toBe(0)
  })
})
