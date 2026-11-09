// Schema migration `review-convergence` (design decisions 3, 4, 6, 7, 10): a
// database at the previous version with an execution, a change, and a card
// upgrades keeping their rows, reads the backstop default 5, a null group
// override, and the card kind 'question'; it gains the diagnoses and notices
// tables, and running `up` again changes nothing.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDatabase } from '../db'
import { MIGRATIONS } from '../dbSafety/migrations'
import { applyReviewConvergenceSchema, REVIEW_CONVERGENCE_MIGRATION_VERSION } from '../plans/execution/convergenceSchema'

const AT = MIGRATIONS.findIndex(migration => migration.name === 'review-convergence')
let dir: string
let dbPath: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-review-convergence-migration-'))
  dbPath = path.join(dir, 'agentboard.db')
})
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

test('the migration is the newest, and an older database upgrades with its rows and the defaults', () => {
  expect(MIGRATIONS[AT]!.version).toBe(REVIEW_CONVERGENCE_MIGRATION_VERSION)
  const before = initDatabase({ path: dbPath, migrations: MIGRATIONS.slice(0, AT) })
  before.db.exec(`INSERT INTO plan_executions (id, team_id, plan_id, revision, content_hash, report_id, input_hash, landing_mode, base_branch, base_commit, floor_json, max_parallel, merge_method, state, started_at)
    VALUES ('e1', 't', 'p', 1, 'h', 'r', 'i', 'direct', 'master', 'b', '{}', 3, 'merge', 'running', '2026-11-01')`)
  before.db.exec(`INSERT INTO plan_execution_changes (execution_id, change, team_id, position, state, updated_at) VALUES ('e1', 'api', 't', 0, 'gating', '2026-11-01')`)
  before.close()

  const after = initDatabase({ path: dbPath })
  try {
    expect(after.db.prepare('SELECT max_failed_fix_rounds AS n FROM plan_executions').get()).toEqual({ n: 5 })
    expect(after.db.prepare('SELECT group_override AS g, state FROM plan_execution_changes').get()).toEqual({ g: null, state: 'gating' })
    const cardColumns = (after.db.prepare('PRAGMA table_info(plan_decision_cards)').all() as Array<{ name: string; dflt_value: string | null }>)
    expect(cardColumns.find(column => column.name === 'kind')?.dflt_value).toBe("'question'")
    const tables = (after.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(row => row.name)
    expect(tables).toEqual(expect.arrayContaining(['plan_execution_diagnoses', 'team_task_convergence_notices']))
    const schema = () => after.db.prepare("SELECT name, sql FROM sqlite_master ORDER BY name").all()
    const first = schema()
    applyReviewConvergenceSchema(after.db)
    expect(schema()).toEqual(first)
  } finally { after.close() }
})

test('one diagnosis per failed round: a second row for the same round is refused', () => {
  const session = initDatabase({ path: dbPath })
  try {
    const insert = session.db.prepare(`INSERT INTO plan_execution_diagnoses (id, execution_id, change, round_id, signals_json, card_id, opened_at) VALUES (?, 'e1', 'api', 'round-1', '[]', ?, '2026-11-01')`)
    insert.run('d1', 'card-1')
    expect(() => insert.run('d2', 'card-2')).toThrow(/UNIQUE/)
  } finally { session.close() }
})
