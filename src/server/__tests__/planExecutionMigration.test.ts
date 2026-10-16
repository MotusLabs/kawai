// Schema migration `plan-execution` (plan-execution D3 on
// execution-safety-recovery D13–D14): a database written by the build before
// it — with plan, validation, and mail rows — upgrades keeping every row after
// its pre-migration backup and gains the seven tables and the nullable
// `team_messages.allowed_profiles`; a fresh database ends at the newest
// version with them; and running the migration's `up` again changes nothing.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Database } from 'bun:sqlite'
import { initDatabase } from '../db'
import { MIGRATIONS } from '../dbSafety/migrations'
import { PlanStore } from '../plans/planStore'
import { normalizePlanContent } from '../../shared/plans'
import { hashPlanDraft } from '../plans/planHash'

const EXECUTION_TABLES = [
  'plan_change_landings', 'plan_execution_attempts', 'plan_execution_changes', 'plan_execution_effects',
  'plan_execution_rounds', 'plan_executions', 'plan_landing_slots',
]
const AT = MIGRATIONS.findIndex(migration => migration.name === 'plan-execution')
const human = { kind: 'human' as const, sessionId: null }

let dir: string
let dbPath: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-plan-execution-migration-'))
  dbPath = path.join(dir, 'agentboard.db')
})
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

function rows(file: string): Record<string, unknown[]> {
  const db = new Database(file, { readonly: true })
  try {
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != 'schema_migrations' ORDER BY name").all() as Array<{ name: string }>)
      .map(row => row.name)
    return Object.fromEntries(tables.map(name => [name, db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()]))
  } finally { db.close() }
}

function columns(db: Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(column => column.name)
}

/** A database as the build before this change leaves it: a plan revision and one mail row. */
function atPreviousVersion(): void {
  const session = initDatabase({ path: dbPath, migrations: MIGRATIONS.slice(0, AT) })
  const store = new PlanStore(session.db)
  const planId = store.insertPlan({ teamId: '/repo/.git', title: 'Plan', creator: human })
  const content = normalizePlanContent({ goal: 'g', changes: [{ change: 'alpha' }] })
  store.insertRevision(planId, { content, contentHash: hashPlanDraft(content), pin: null, author: human })
  session.db.prepare(`INSERT INTO team_messages (id, team_id, to_kind, to_id, from_kind, from_session, from_group, origin_path,
    priority, tags, thread_id, hop, body, state, created_at) VALUES ('m1', '/repo/.git', 'group', 'devs', 'human', NULL, NULL, '/repo',
    'normal', '[]', 'm1', 1, 'hello', 'queued', '2026-10-16T00:00:00.000Z')`).run()
  session.close()
}

test('plan-execution is the next dense numbered migration', () => {
  expect(AT).toBeGreaterThan(0)
  expect(MIGRATIONS[AT]!.version).toBe(MIGRATIONS[AT - 1]!.version + 1)
})

test('a database at the previous version upgrades keeping every row', () => {
  atPreviousVersion()
  const before = rows(dbPath)
  expect(before.plans).toHaveLength(1)
  expect(before.team_messages).toHaveLength(1)
  expect(EXECUTION_TABLES.filter(table => table in before)).toEqual([])

  const session = initDatabase({ path: dbPath, migrations: MIGRATIONS.slice(0, AT + 1) })
  expect(columns(session.db, 'team_messages')).toContain('allowed_profiles')
  session.close()

  const after = rows(dbPath)
  for (const [table, tableRows] of Object.entries(before)) {
    if (table === 'team_messages') continue
    expect(after[table]).toEqual(tableRows)
  }
  expect(after.team_messages).toEqual(before.team_messages!.map(row => ({ ...(row as object), allowed_profiles: null })))
  expect(Object.keys(after).filter(table => !(table in before)).sort()).toEqual(EXECUTION_TABLES)
  const db = new Database(dbPath, { readonly: true })
  const last = db.prepare('SELECT version, name, backup_path FROM schema_migrations ORDER BY version DESC LIMIT 1').get() as { version: number; name: string; backup_path: string }
  db.close()
  expect(last).toMatchObject({ version: MIGRATIONS[AT]!.version, name: 'plan-execution' })
  expect(path.basename(last.backup_path)).toMatch(new RegExp(`-pre-migration-${MIGRATIONS[AT]!.version}\\.db$`))
  expect(EXECUTION_TABLES.filter(table => table in rows(last.backup_path))).toEqual([])
})

test('a fresh database ends at the newest version with the execution tables and indexes', () => {
  initDatabase({ path: dbPath }).close()
  expect(Object.keys(rows(dbPath))).toEqual(expect.arrayContaining(EXECUTION_TABLES))
  const db = new Database(dbPath, { readonly: true })
  const indexes = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string }>).map(row => row.name)
  expect(indexes).toEqual(expect.arrayContaining(['plan_executions_one_running', 'plan_execution_changes_owner']))
  expect(columns(db, 'team_messages')).toContain('allowed_profiles')
  expect(columns(db, 'plan_execution_effects')).toContain('change')
  db.close()
})

test("rerunning the migration's up is a no-op", () => {
  initDatabase({ path: dbPath }).close()
  const db = new Database(dbPath)
  db.prepare(`INSERT INTO plan_landing_slots (team_id, holder_kind, holder_id, since) VALUES ('t', 'change', 'e:alpha', 'now')`).run()
  const before = rows(dbPath)
  MIGRATIONS[AT]!.up(db)
  db.close()
  expect(rows(dbPath)).toEqual(before)
})
