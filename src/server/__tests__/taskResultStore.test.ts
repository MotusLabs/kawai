// Task results store (task-results-handoffs 1.1–1.3): the additive migration
// on a pre-existing database, supersession keeping one outstanding result and
// every earlier one readable, findings bound per result, acceptance marking
// one row, persistence across a reopen, and Needs re-evaluation derived from
// the revision rows at read time — moved by nothing but the revision number.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDatabase, type SessionDatabase } from '../db'
import { AssignmentStore } from '../team/assignmentStore'
import { MailboxStore } from '../team/mailboxStore'
import { TaskStore } from '../team/taskStore'
import type { ResultInsert } from '../team/taskResultStore'

const TEAM = '/repo/.git'
const human = { kind: 'human' as const, sessionId: null }
const dev = { kind: 'agent' as const, sessionId: 'dev' }

let dir: string
let session: SessionDatabase
let store: TaskStore

const open = () => {
  session = initDatabase({ path: path.join(dir, 'tasks.db') })
  store = new TaskStore(session.db, new MailboxStore(session.db))
}
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-results-'))
  open()
})
afterEach(() => { session.close(); fs.rmSync(dir, { recursive: true, force: true }) })

const create = () => store.create({ teamId: TEAM, title: 'Export', direction: 'v1', creator: human })
const submit = (taskId: string, extra: Partial<ResultInsert> = {}) => store.results.insert({
  teamId: TEAM, taskId, summary: 'CSV export', commit: 'abc123', diff: null, worktree: '/repo-feat',
  tests: [{ description: 'bun run test', outcome: 'pass' }], limitations: null,
  taskRevision: store.get(taskId)!.revision, submittedBy: dev, ...extra,
})

test('a pre-existing database gains the result tables and handoff columns; plain assignments read with null handoff fields', () => {
  session.close()
  const legacy = new Database(path.join(dir, 'legacy.db'))
  legacy.exec(`CREATE TABLE team_task_assignments (id TEXT PRIMARY KEY, team_id TEXT NOT NULL, task_id TEXT NOT NULL,
    request_key TEXT NOT NULL, target_kind TEXT NOT NULL, target_id TEXT NOT NULL, role TEXT, instruction TEXT NOT NULL,
    created_by_kind TEXT NOT NULL, created_by_session TEXT, message_id TEXT, claimed_by TEXT, claimed_at TEXT,
    superseded_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`)
  legacy.exec(`INSERT INTO team_task_assignments VALUES ('assignment-old', '${TEAM}', 'task-1', 'k', 'group', 'devs', 'devs',
    'Build it', 'human', NULL, NULL, NULL, NULL, NULL, 'now', 'now')`)
  legacy.close()
  for (let pass = 0; pass < 2; pass++) {
    // Twice: the migration is idempotent across a reopen.
    const db = new Database(path.join(dir, 'legacy.db'))
    const assignments = new AssignmentStore(db, new MailboxStore(db))
    new TaskStore(db, undefined, assignments)
    expect(assignments.listByTask('task-1')).toMatchObject([{ id: 'assignment-old', handoffKind: null, resultId: null, expectedResponse: null }])
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(row => row.name)
    expect(tables).toEqual(expect.arrayContaining(['team_task_results', 'team_task_findings']))
    assignments.close()
    db.close()
  }
  open()
})

test('the first result is outstanding; a new one supersedes it and every earlier result stays readable', () => {
  const task = create()
  const first = submit(task.id)
  expect(first).toMatchObject({ supersedesResultId: null, supersededBy: null, taskRevision: 1, submittedBy: dev,
    tests: [{ description: 'bun run test', outcome: 'pass' }], worktree: '/repo-feat' })
  const second = submit(task.id, { summary: 'CSV export, fixed' })
  const third = submit(task.id, { summary: 'CSV export, fixed again' })
  expect(store.results.outstanding(task.id)?.id).toBe(third.id)
  expect(store.results.listByTask(task.id).map(row => [row.id, row.supersedesResultId, row.supersededBy])).toEqual([
    [third.id, second.id, null],
    [second.id, first.id, third.id],
    [first.id, null, second.id],
  ])
  expect(store.list(TEAM).find(row => row.id === task.id)?.outstandingResult).toEqual({ id: third.id, needsReevaluation: false, accepted: false })
})

test('findings bind to their result; a newer result has none; acceptance marks exactly one row; all of it survives a reopen', () => {
  const task = create()
  const first = submit(task.id)
  store.results.insertFindings({ teamId: TEAM, taskId: task.id, resultId: first.id, handoffId: null, kind: 'review',
    verdict: 'fail', findings: 'Missing header row', author: { kind: 'agent', sessionId: 'reviewer' } })
  const second = submit(task.id)
  expect(store.results.get(first.id)!.findings).toMatchObject([{ verdict: 'fail', author: { sessionId: 'reviewer' } }])
  expect(store.results.get(second.id)!.findings).toEqual([])
  expect(store.results.markAccepted(second.id, human)).toBe(true)
  session.close()
  open()
  const [outstanding, earlier] = store.results.listByTask(task.id)
  expect(outstanding).toMatchObject({ id: second.id, acceptedBy: human, findings: [] })
  expect(outstanding!.acceptedAt).toEqual(expect.any(String))
  expect(earlier).toMatchObject({ id: first.id, acceptedBy: null, acceptedAt: null, findings: [{ findings: 'Missing header row' }] })
  expect(store.detail(task.id)!.results!.map(row => row.id)).toEqual([second.id, first.id])
})

test('Needs re-evaluation is derived from the revision rows: a publication flags, nothing else does, and it never clears', () => {
  const task = create()
  const result = submit(task.id)
  expect(store.results.get(result.id)!.needsReevaluation).toBe(false)
  // A journal note, a status change, and a draft are not revisions.
  store.appendJournal(task.id, human, 'note')
  store.setStatus(task.id, 'active')
  store.drafts.save(task.id, { baseRevision: 1, direction: 'draft', acceptance: null, rationale: null })
  expect(store.results.get(result.id)!.needsReevaluation).toBe(false)
  store.publish(task.id, { direction: 'v2', notify: false }, human)
  expect(store.results.get(result.id)!.needsReevaluation).toBe(true)
  store.publish(task.id, { direction: 'v3', notify: false }, human)
  expect(store.results.get(result.id)!.needsReevaluation).toBe(true)
  // A result at the current revision carries no label; the old one keeps its own.
  const fresh = submit(task.id)
  expect(store.results.get(fresh.id)!.needsReevaluation).toBe(false)
  expect(store.results.get(result.id)!.needsReevaluation).toBe(true)
  // Only the revision number moves it: the label is the row comparison itself.
  session.db.prepare('UPDATE team_tasks SET revision = 1 WHERE id = ?').run(task.id)
  expect(store.results.get(result.id)!.needsReevaluation).toBe(false)
})

test('outstandingSince lists the team’s outstanding results in the window; submittedBy tells a session’s result from none', () => {
  const task = create()
  const other = store.create({ teamId: '/other/.git', title: 'Elsewhere', direction: 'v1', creator: human })
  submit(task.id)
  const first = store.results.listByTask(task.id)[0]!
  const second = store.results.insert({
    teamId: TEAM, taskId: task.id, summary: 'v2', commit: null, diff: null, worktree: null, tests: [], limitations: null,
    taskRevision: 1, submittedBy: dev,
  })
  store.results.insert({
    teamId: '/other/.git', taskId: other.id, summary: 'x', commit: null, diff: null, worktree: null, tests: [], limitations: null,
    taskRevision: 1, submittedBy: dev,
  })
  const since = new Date(Date.now() - 60_000).toISOString()
  // The superseded result and the other team's result stay out.
  expect(store.results.outstandingSince(TEAM, since).map(result => result.id)).toEqual([second.id])
  expect(store.results.outstandingSince(TEAM, new Date(Date.now() + 60_000).toISOString())).toEqual([])
  expect(first.id).not.toBe(second.id)
  expect(store.results.submittedBy(task.id, 'dev')).toBe(true)
  expect(store.results.submittedBy(task.id, 'someone-else')).toBe(false)
})
