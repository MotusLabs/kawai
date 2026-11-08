// Task-revision publication schema (task-revision-publication 1.1): the
// additive migration on a database that predates it — old revisions read
// with no rationale and `notify` null — the new tables, the partial unique
// publication key, and `revision_notice` on mail rows across a reopen.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { schemaDb } from './schemaDb'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MailboxStore } from '../team/mailboxStore'
import { TaskStore } from '../team/taskStore'
import { identityOf } from '../team/contractHash'

let dir: string
let dbPath: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-revision-schema-'))
  dbPath = path.join(dir, 'tasks.db')
})
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

/** A database as the release before publication left it: one task at revision 1. */
function legacyDatabase(): void {
  const db = new Database(dbPath)
  db.exec(`CREATE TABLE team_tasks (id TEXT PRIMARY KEY, team_id TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL,
    creator_kind TEXT NOT NULL, creator_session TEXT, parent_id TEXT, worktree TEXT, openspec_change TEXT, request_key TEXT,
    revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`)
  db.exec(`CREATE TABLE team_task_revisions (task_id TEXT NOT NULL, revision INTEGER NOT NULL, direction TEXT NOT NULL,
    acceptance TEXT, author_kind TEXT NOT NULL, author_session TEXT, created_at TEXT NOT NULL, PRIMARY KEY (task_id, revision))`)
  db.exec(`INSERT INTO team_tasks VALUES ('task-old', '/repo/.git', 'Old', 'open', 'human', NULL, NULL, NULL, NULL, NULL, 1,
    '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`)
  db.exec(`INSERT INTO team_task_revisions VALUES ('task-old', 1, 'Build it', NULL, 'human', NULL, '2026-01-01T00:00:00.000Z')`)
  db.close()
}

const open = () => {
  const db = schemaDb(dbPath)
  const mail = new MailboxStore(db)
  return { db, mail, tasks: new TaskStore(db, mail) }
}

test('a pre-existing database gains the columns and tables; old revisions read with no rationale and notify null', () => {
  legacyDatabase()
  const { db, tasks } = open()
  expect(tasks.revisions('task-old')).toEqual([{
    revision: 1, direction: 'Build it', acceptance: null, author: { kind: 'human', sessionId: null },
    createdAt: '2026-01-01T00:00:00.000Z', rationale: null, notify: null,
    // Contract columns (implementation-contract 2.1, I4): null, no backfill; a text identity on read.
    contract: null, contractHash: null, identity: identityOf({ revision: 1, direction: 'Build it', acceptance: null, contractHash: null }),
  }])
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(row => row.name)
  expect(tables).toEqual(expect.arrayContaining(['team_task_drafts', 'team_task_notifications', 'team_task_acknowledgements']))
  db.close()
  // Reopening migrates nothing twice and reads the same rows.
  const again = open()
  expect(again.tasks.revisions('task-old')[0]).toMatchObject({ rationale: null, notify: null })
  again.db.close()
})

test('the publication key is unique per task where set; unkeyed revisions never collide', () => {
  const { db, tasks } = open()
  const task = tasks.create({ teamId: '/repo/.git', title: 't', direction: 'd', creator: { kind: 'human', sessionId: null } })
  const insert = (revision: number, key: string | null) => db.prepare(`INSERT INTO team_task_revisions
    (task_id, revision, direction, author_kind, created_at, request_key) VALUES (?, ?, 'd', 'human', 'now', ?)`).run(task.id, revision, key)
  insert(2, null)
  insert(3, null)
  insert(4, 'publish-1')
  expect(() => insert(5, 'publish-1')).toThrow(/UNIQUE/)
  db.close()
})

test('a notice mail row keeps its revision_notice across a reopen; other rows read none', () => {
  const { db, mail } = open()
  const notice = { revision: 2, previousRevision: 1, assignmentId: 'assignment-1', rationale: 'Scope changed' }
  const sent = mail.enqueue({ teamId: '/repo/.git', toKind: 'session', toId: 'dev', fromSession: null, fromGroup: null,
    originPath: '/repo', body: 'notice', taskId: 'task-1', tags: ['task-revision'], revisionNotice: notice })
  const plain = mail.enqueue({ teamId: '/repo/.git', toKind: 'session', toId: 'dev', fromSession: null, fromGroup: null, originPath: '/repo', body: 'hi' })
  db.close()
  const again = open()
  expect(again.mail.get(sent.id)?.revisionNotice).toEqual(notice)
  expect(again.mail.get(plain.id)?.revisionNotice).toBeNull()
  again.db.close()
})

test('the contract migration adds nullable contract, contract_hash, and contract_text columns', () => {
  legacyDatabase()
  const { db } = open()
  const columns = (table: string) => db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; notnull: number; type: string }>
  const pick = (table: string, names: string[]) => columns(table).filter(column => names.includes(column.name)).map(({ name, notnull, type }) => ({ name, notnull, type }))
  expect(pick('team_task_revisions', ['contract', 'contract_hash'])).toEqual([
    { name: 'contract', notnull: 0, type: 'TEXT' }, { name: 'contract_hash', notnull: 0, type: 'TEXT' },
  ])
  expect(pick('team_task_drafts', ['contract_text'])).toEqual([{ name: 'contract_text', notnull: 0, type: 'TEXT' }])
  // The legacy row is unchanged: no backfill (I4).
  expect(db.prepare("SELECT contract, contract_hash FROM team_task_revisions WHERE task_id = 'task-old'").get()).toEqual({ contract: null, contract_hash: null })
  db.close()
})
