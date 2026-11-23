// Schema migration `task-publication-handoffs` (owner-publication-handoff
// D1, task 2.1): it is the numbered migration after `result-author-profile`
// (never the baseline); a fresh database and one at the previous version both
// reach it with the handoff tables and the draft and revision columns, keeping
// existing rows unchanged and backfilling nothing; running `up` again changes
// nothing; a failing `up` rolls back to the previous version with its
// pre-migration backup; and the indexes refuse a second pending handoff (U2),
// a reused request key, and a second fulfilling revision.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDatabase } from '../db'
import { DatabaseStartupError, MIGRATIONS, type Migration } from '../dbSafety/migrations'
import { applyBaselineSchema } from '../dbSafety/baseline'
import { applyTaskHandoffSchema, TASK_HANDOFF_MIGRATION_VERSION } from '../team/taskHandoffSchema'

const AT = MIGRATIONS.findIndex(migration => migration.name === 'task-publication-handoffs')
let dir: string
let dbPath: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-task-handoff-migration-'))
  dbPath = path.join(dir, 'agentboard.db')
})
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

const columnsOf = (db: Database, table: string) =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(column => column.name)
const tablesOf = (db: Database) =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(row => row.name)

const insertHandoff = (db: Database, id: string, taskId: string, key: string, state: string) =>
  db.prepare(`INSERT INTO team_task_handoffs (id, team_id, task_id, base_revision, rationale, notify, payload_hash,
    requester_session, request_key, state, created_at, updated_at) VALUES (?, 't', ?, 1, 'why', 1, 'h', 's', ?, ?, 'now', 'now')`)
    .run(id, taskId, key, state)

test('the migration follows result-author-profile and is never part of the baseline', () => {
  expect(AT).toBeGreaterThan(0)
  expect(MIGRATIONS[AT]!.version).toBe(TASK_HANDOFF_MIGRATION_VERSION)
  expect(MIGRATIONS[AT - 1]!.name).toBe('result-author-profile')
  expect(MIGRATIONS[AT]!.version).toBe(MIGRATIONS[AT - 1]!.version + 1)
  const baseline = new Database(':memory:')
  try {
    applyBaselineSchema(baseline)
    expect(tablesOf(baseline)).not.toContain('team_task_handoffs')
    expect(columnsOf(baseline, 'team_task_revisions')).not.toContain('handoff_id')
  } finally { baseline.close() }
})

test('a fresh database reaches the version with the handoff tables and columns', () => {
  const session = initDatabase({ path: dbPath })
  try {
    expect(session.db.prepare('PRAGMA user_version').get()).toEqual({ user_version: MIGRATIONS.at(-1)!.version })
    expect(tablesOf(session.db)).toEqual(expect.arrayContaining(['team_task_handoffs', 'team_task_handoff_events', 'team_task_handoff_wakeups']))
    expect(columnsOf(session.db, 'team_task_drafts')).toEqual(expect.arrayContaining(['handoff_id', 'lineage_id']))
    expect(columnsOf(session.db, 'team_task_revisions')).toContain('handoff_id')
  } finally { session.close() }
})

test('a database at the previous version upgrades keeping its rows, with no handoff backfilled', () => {
  const before = initDatabase({ path: dbPath, migrations: MIGRATIONS.slice(0, AT) })
  before.db.exec(`INSERT INTO team_tasks (id, team_id, title, creator_kind, status, created_at, updated_at, revision)
    VALUES ('task-1', 't', 'Export', 'human', 'open', 'now', 'now', 1)`)
  before.db.exec(`INSERT INTO team_task_revisions (task_id, revision, direction, author_kind, created_at, request_key)
    VALUES ('task-1', 1, 'CSV', 'human', 'now', 'k1')`)
  before.db.exec(`INSERT INTO team_task_drafts (task_id, base_revision, direction, updated_at) VALUES ('task-1', 1, 'draft', 'now')`)
  expect(before.db.prepare('PRAGMA user_version').get()).toEqual({ user_version: TASK_HANDOFF_MIGRATION_VERSION - 1 })
  before.close()

  const after = initDatabase({ path: dbPath, migrations: MIGRATIONS.slice(0, AT + 1) })
  try {
    expect(after.db.prepare('PRAGMA user_version').get()).toEqual({ user_version: TASK_HANDOFF_MIGRATION_VERSION })
    const backup = after.db.prepare('SELECT backup_path FROM schema_migrations WHERE version = ?').get(TASK_HANDOFF_MIGRATION_VERSION) as { backup_path: string }
    expect(path.basename(backup.backup_path)).toMatch(new RegExp(`pre-migration-${TASK_HANDOFF_MIGRATION_VERSION}\\.db$`))
    expect(after.db.prepare('SELECT request_key, handoff_id FROM team_task_revisions').all()).toEqual([{ request_key: 'k1', handoff_id: null }])
    expect(after.db.prepare('SELECT direction, handoff_id, lineage_id FROM team_task_drafts').all()).toEqual([{ direction: 'draft', handoff_id: null, lineage_id: null }])
    expect(after.db.prepare('SELECT COUNT(*) AS n FROM team_task_handoffs').get()).toEqual({ n: 0 })
    const schema = () => after.db.prepare('SELECT name, sql FROM sqlite_master ORDER BY name').all()
    const first = schema()
    applyTaskHandoffSchema(after.db)
    expect(schema()).toEqual(first)
  } finally { after.close() }
})

test('a failing up rolls back to the previous version and names its pre-migration backup', () => {
  initDatabase({ path: dbPath, migrations: MIGRATIONS.slice(0, AT) }).close()
  const failing: Migration = {
    ...MIGRATIONS[AT]!,
    up: db => { applyTaskHandoffSchema(db); throw new Error('boom') },
  }
  let error: unknown
  try { initDatabase({ path: dbPath, migrations: [...MIGRATIONS.slice(0, AT), failing] }) } catch (caught) { error = caught }
  expect(error).toBeInstanceOf(DatabaseStartupError)
  expect((error as Error).message).toMatch(new RegExp(`pre-migration-${TASK_HANDOFF_MIGRATION_VERSION}\\.db`))
  const db = new Database(dbPath, { readonly: true })
  try {
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: TASK_HANDOFF_MIGRATION_VERSION - 1 })
    expect(tablesOf(db)).not.toContain('team_task_handoffs')
    expect(columnsOf(db, 'team_task_revisions')).not.toContain('handoff_id')
  } finally { db.close() }
  const backups = fs.readdirSync(path.join(dir, 'backups')).filter(name => name.endsWith(`pre-migration-${TASK_HANDOFF_MIGRATION_VERSION}.db`))
  expect(backups).toHaveLength(1)
})

test('one pending handoff per task, unique request keys, and one fulfilling revision per handoff (U2)', () => {
  const session = initDatabase({ path: dbPath })
  try {
    insertHandoff(session.db, 'h1', 'task-1', 'k1', 'open')
    expect(() => insertHandoff(session.db, 'h2', 'task-1', 'k2', 'stale')).toThrow(/UNIQUE/)
    insertHandoff(session.db, 'h3', 'task-1', 'k3', 'declined')
    expect(() => insertHandoff(session.db, 'h4', 'task-1', 'k1', 'withdrawn')).toThrow(/UNIQUE/)
    insertHandoff(session.db, 'h5', 'task-2', 'k1', 'open')
    const revision = session.db.prepare(`INSERT INTO team_task_revisions (task_id, revision, direction, author_kind, created_at, handoff_id)
      VALUES (?, ?, 'x', 'human', 'now', ?)`)
    revision.run('task-1', 2, 'h1')
    expect(() => revision.run('task-1', 3, 'h1')).toThrow(/UNIQUE/)
    revision.run('task-1', 4, null)
    revision.run('task-1', 5, null)
  } finally { session.close() }
})
