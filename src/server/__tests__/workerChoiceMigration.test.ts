// Schema migration `worker-choice` (dispatch-worker-choice D1), task 1.1: a
// database at version 16 with mail keeps every row and reads it as carrying
// no choice; both tables gain the nullable column once; a repeat is a no-op.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDatabase } from '../db'
import { MIGRATIONS } from '../dbSafety/migrations'
import { MailboxStore } from '../team/mailboxStore'
import { workerChoiceMigration } from '../team/workerChoiceMigration'

const THROUGH_16 = MIGRATIONS.filter(migration => migration.version <= 16)

let dir: string
let dbPath: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-worker-choice-migration-'))
  dbPath = path.join(dir, 'agentboard.db')
})
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

const hasColumn = (db: { prepare: (sql: string) => { all: () => unknown[] } }, table: string) =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some(column => column.name === 'worker_choice')

test('worker-choice is migration 17, registered right after plan-supervision', () => {
  expect(workerChoiceMigration.version).toBe(17)
  expect(MIGRATIONS.find(migration => migration.version === 17)).toBe(workerChoiceMigration)
  expect(MIGRATIONS.find(migration => migration.version === 16)?.name).toBe('plan-supervision')
})

test('a version-16 database with mail migrates; old rows read as no choice', () => {
  const old = initDatabase({ path: dbPath, migrations: THROUGH_16 })
  expect(hasColumn(old.db, 'team_messages')).toBe(false)
  expect(hasColumn(old.db, 'team_task_assignments')).toBe(false)
  const sent = new MailboxStore(old.db).enqueue({
    teamId: '/repo/.git', toKind: 'group', toId: 'devs', fromSession: 'chat-lead', fromGroup: 'lead', originPath: '/repo', body: 'Build it',
  })
  old.close()

  const session = initDatabase({ path: dbPath })
  expect(hasColumn(session.db, 'team_messages')).toBe(true)
  expect(hasColumn(session.db, 'team_task_assignments')).toBe(true)
  const row = session.db.prepare('SELECT body, worker_choice FROM team_messages WHERE id = ?').get(sent.id)
  expect(row).toEqual({ body: 'Build it', worker_choice: null })
  const recorded = session.db.prepare('SELECT version, name FROM schema_migrations WHERE version = 17').all()
  expect(recorded).toEqual([{ version: 17, name: 'worker-choice' }])
  // The migration is idempotent on a database that already has the columns.
  workerChoiceMigration.up(session.db)
  session.close()
})
