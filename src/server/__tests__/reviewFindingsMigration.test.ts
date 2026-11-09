// Schema migration `review-findings` (review-findings-ledger D3, invariant
// I4): a database at the previous version with a text-only findings row
// upgrades keeping that row's columns byte-identical, reads it as
// unstructured, gains the items, events, and cards tables and the rounds'
// unique `regate_of`, and running `up` again changes nothing.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Database } from 'bun:sqlite'
import { initDatabase } from '../db'
import { MIGRATIONS } from '../dbSafety/migrations'
import { applyReviewFindingsSchema, REVIEW_FINDINGS_MIGRATION_VERSION } from '../team/findingSchema'
import { TaskResultStore } from '../team/taskResultStore'

const AT = MIGRATIONS.findIndex(migration => migration.name === 'review-findings')
let dir: string
let dbPath: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-review-findings-migration-'))
  dbPath = path.join(dir, 'agentboard.db')
})
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

const LEGACY = {
  id: 'findings-old', team_id: '/repo/.git', task_id: 'task-1', result_id: 'result-1', handoff_id: null, kind: 'review',
  verdict: 'fail', findings: 'F: the list is unsorted', author_kind: 'agent', author_session: 'chat-r', created_at: '2026-11-01T00:00:00.000Z',
}

function atPreviousVersion(): void {
  const session = initDatabase({ path: dbPath, migrations: MIGRATIONS.slice(0, AT) })
  session.db.prepare(`INSERT INTO team_task_findings (id, team_id, task_id, result_id, handoff_id, kind, verdict, findings, author_kind, author_session, created_at)
    VALUES ($id, $team_id, $task_id, $result_id, $handoff_id, $kind, $verdict, $findings, $author_kind, $author_session, $created_at)`)
    .run(Object.fromEntries(Object.entries(LEGACY).map(([key, value]) => [`$${key}`, value])) as never)
  session.close()
}

const tables = (db: Database): string[] =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>).map(row => row.name)

test('review-findings is the next dense numbered migration', () => {
  expect(MIGRATIONS[AT]!.version).toBe(REVIEW_FINDINGS_MIGRATION_VERSION)
  expect(MIGRATIONS[AT - 1]!.version).toBe(REVIEW_FINDINGS_MIGRATION_VERSION - 1)
})

test('a text-only findings row survives byte-identical and reads as unstructured', () => {
  atPreviousVersion()
  initDatabase({ path: dbPath }).close()
  const db = new Database(dbPath, { readonly: true })
  try {
    const row = db.prepare('SELECT * FROM team_task_findings WHERE id = ?').get('findings-old') as Record<string, unknown>
    expect(Object.fromEntries(Object.keys(LEGACY).map(key => [key, row[key]]))).toEqual(LEGACY)
    expect([row.structured, row.counted, row.contract_identity, row.ledger_seq, row.replaced_by]).toEqual([0, 0, null, null, null])
    expect(tables(db)).toEqual(expect.arrayContaining(['team_task_finding_items', 'team_task_finding_events', 'team_task_finding_cards']))
    const read = new TaskResultStore(db).findingsFor('result-1')
    expect(read.map(entry => [entry.id, entry.structured, entry.verdict, entry.findings])).toEqual([['findings-old', false, 'fail', LEGACY.findings]])
  } finally { db.close() }
})

test('regate_of is unique across rounds, and a second up changes nothing', () => {
  const session = initDatabase({ path: dbPath })
  const insert = (id: string, number: number, regate: string | null) => session.db.prepare(`INSERT INTO plan_execution_rounds
    (id, execution_id, change, attempt_id, number, result_id, commit_sha, fix_round, regate_of) VALUES (?, 'e', 'c', 'a', ?, 'r', 'sha', 0, ?)`)
    .run(id, number, regate)
  insert('round-1', 1, null)
  insert('round-2', 2, null)
  insert('round-3', 3, 'round-1')
  expect(() => insert('round-4', 4, 'round-1')).toThrow('UNIQUE')
  const schema = () => session.db.prepare("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name").all()
  const before = schema()
  applyReviewFindingsSchema(session.db)
  expect(schema()).toEqual(before)
  session.close()
})
