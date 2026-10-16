// Schema migration 4 `task-status-events` (team-process-metrics D3 and the
// Migration Plan): a version-2 database gains the transition table with one
// backfilled `system` row per task already done or cancelled (`from_status`
// null, `at` = the task's `updated_at`), open tasks get none, a second start
// never backfills again, and later transitions append beside the backfill.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDatabase } from '../db'
import { MIGRATIONS } from '../dbSafety/migrations'
import { MailboxStore } from '../team/mailboxStore'
import { TaskStore } from '../team/taskStore'
import { schemaDb } from './schemaDb'

const TEAM = '/repo/.git'
const human = { kind: 'human' as const, sessionId: null }
const THROUGH_2 = MIGRATIONS.filter(migration => migration.version <= 2)

let dir: string
let dbPath: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-status-events-migration-'))
  dbPath = path.join(dir, 'agentboard.db')
})
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

/** A version-2 database as the build before this change leaves it: done, cancelled, and open tasks. */
function versionTwoWithTasks(): Record<'done' | 'cancelled' | 'open', string> {
  const session = initDatabase({ path: dbPath, migrations: THROUGH_2 })
  const insert = session.db.prepare(`INSERT INTO team_tasks
    (id, team_id, title, status, creator_kind, creator_session, revision, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'human', NULL, 1, '2026-10-01T00:00:00.000Z', ?)`)
  insert.run('task-done', TEAM, 'Done', 'done', '2026-10-05T00:00:00.000Z')
  insert.run('task-cancelled', TEAM, 'Cancelled', 'cancelled', '2026-10-06T00:00:00.000Z')
  insert.run('task-open', TEAM, 'Open', 'active', '2026-10-07T00:00:00.000Z')
  expect(session.db.prepare("SELECT name FROM sqlite_master WHERE name = 'team_task_status_events'").get()).toBeNull()
  session.close()
  return { done: 'task-done', cancelled: 'task-cancelled', open: 'task-open' }
}

test('this build registers migration 4 task-status-events after plan-validation', () => {
  expect(MIGRATIONS.map(migration => [migration.version, migration.name]).slice(0, 3))
    .toEqual([[2, 'strategy-impact'], [3, 'plan-validation'], [4, 'task-status-events']])
})

test('a version-2 database backfills one system row per closed task and none for open ones', () => {
  const ids = versionTwoWithTasks()
  const session = initDatabase({ path: dbPath })
  const tasks = new TaskStore(session.db, new MailboxStore(session.db))
  expect(tasks.statusEvents(ids.done)).toEqual([{ fromStatus: null, toStatus: 'done', actor: { kind: 'system', sessionId: null }, at: '2026-10-05T00:00:00.000Z' }])
  expect(tasks.statusEvents(ids.cancelled)).toEqual([{ fromStatus: null, toStatus: 'cancelled', actor: { kind: 'system', sessionId: null }, at: '2026-10-06T00:00:00.000Z' }])
  expect(tasks.statusEvents(ids.open)).toEqual([])
  // Later transitions append beside the backfill.
  tasks.setStatus(ids.done, 'open', undefined, human, '2026-10-08T00:00:00.000Z')
  expect(tasks.statusEvents(ids.done).map(event => [event.fromStatus, event.toStatus])).toEqual([[null, 'done'], ['done', 'open']])
  session.close()
})

test('a second start never backfills again', () => {
  versionTwoWithTasks()
  initDatabase({ path: dbPath }).close()
  const session = initDatabase({ path: dbPath })
  expect(session.db.prepare('SELECT COUNT(*) AS n FROM team_task_status_events').get()).toEqual({ n: 2 })
  session.close()
})

test('a fresh schema has the empty table', () => {
  const db = schemaDb()
  expect(db.prepare('SELECT COUNT(*) AS n FROM team_task_status_events').get()).toEqual({ n: 0 })
  db.close()
})
