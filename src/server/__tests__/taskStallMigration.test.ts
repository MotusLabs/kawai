// Schema migration `task-stall-notices` (manual-task-stall-alerts D3): a
// database at the previous version upgrades keeping its rows and gains the
// empty notices table; the `(task_id, anchor_at)` key refuses a duplicate;
// running `up` again changes nothing.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDatabase } from '../db'
import { MIGRATIONS } from '../dbSafety/migrations'
import { TASK_STALL_MIGRATION_VERSION, taskStallMigration } from '../team/taskStallSchema'

const AT = MIGRATIONS.findIndex(migration => migration.name === 'task-stall-notices')
let dir: string
let dbPath: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-task-stall-migration-'))
  dbPath = path.join(dir, 'agentboard.db')
})
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

test('a database before task-stall-notices upgrades to an empty notices table keyed by task and anchor', () => {
  expect(MIGRATIONS[AT]!.version).toBe(TASK_STALL_MIGRATION_VERSION)
  const before = initDatabase({ path: dbPath, migrations: MIGRATIONS.slice(0, AT) })
  expect(before.db.prepare("SELECT name FROM sqlite_master WHERE name = 'team_task_stall_notices'").get()).toBeNull()
  before.db.exec(`INSERT INTO team_task_convergence_notices (submission_id, task_id, signals_json, created_at) VALUES ('s1', 't1', '[]', '2026-11-01')`)
  before.close()

  const after = initDatabase({ path: dbPath })
  try {
    expect(after.db.prepare('SELECT COUNT(*) AS n FROM team_task_stall_notices').get()).toEqual({ n: 0 })
    expect(after.db.prepare('SELECT task_id FROM team_task_convergence_notices').all()).toEqual([{ task_id: 't1' }])
    const insert = after.db.prepare(`INSERT OR IGNORE INTO team_task_stall_notices (task_id, anchor_at, anchor_kind, message_count, message_id, created_at) VALUES (?, ?, 'created', 10, NULL, ?)`)
    expect(insert.run('t1', '2026-11-01T00:00:00.000Z', '2026-11-01T03:00:00.000Z').changes).toBe(1)
    expect(insert.run('t1', '2026-11-01T00:00:00.000Z', '2026-11-01T04:00:00.000Z').changes).toBe(0)
    expect(insert.run('t1', '2026-11-01T03:00:00.000Z', '2026-11-01T06:00:00.000Z').changes).toBe(1)
    const schema = () => after.db.prepare('SELECT name, sql FROM sqlite_master ORDER BY name').all()
    const first = schema()
    taskStallMigration.up(after.db)
    expect(schema()).toEqual(first)
  } finally { after.close() }
})
