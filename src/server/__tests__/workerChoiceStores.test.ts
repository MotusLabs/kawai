// The worker choice on stored rows (dispatch-worker-choice D1, task 1.3):
// group mail and dispatches round-trip their canonical selector; a row
// without one reads exactly as before (no `workerChoice` key at all); a
// release back to the group keeps it; a store opened before migration 17
// still enqueues ordinary mail.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { initDatabase } from '../db'
import { MIGRATIONS } from '../dbSafety/migrations'
import { AssignmentStore } from '../team/assignmentStore'
import { MailboxStore } from '../team/mailboxStore'
import { TaskStore } from '../team/taskStore'
import type { EnqueueInput } from '../team/enqueueInput'
import { schemaDb } from './schemaDb'

const TEAM = '/repo/.git'

describe('team_messages.worker_choice', () => {
  let db: Database
  let store: MailboxStore
  beforeEach(() => { db = schemaDb(); store = new MailboxStore(db) })
  afterEach(() => db.close())
  const send = (over: Partial<EnqueueInput> = {}) => store.enqueue({
    teamId: TEAM, toKind: 'group', toId: 'devs', fromSession: 'chat-lead', fromGroup: 'lead', originPath: '/repo', body: 'Build it', ...over,
  })

  test('a choice round-trips through enqueue, get, and the due group queue', () => {
    const sent = send({ workerChoice: 'zai/glm-flash' })
    expect(sent.workerChoice).toBe('zai/glm-flash')
    expect(store.get(sent.id)!.workerChoice).toBe('zai/glm-flash')
    expect(store.dueGroupMail().map(message => message.workerChoice)).toEqual(['zai/glm-flash'])
    expect(db.prepare('SELECT worker_choice FROM team_messages WHERE id = ?').get(sent.id)).toEqual({ worker_choice: 'zai/glm-flash' })
  })

  test('a message without a choice reads exactly as before: no key, a NULL column', () => {
    const sent = send()
    expect('workerChoice' in sent).toBe(false)
    expect('workerChoice' in store.get(sent.id)!).toBe(false)
    expect(db.prepare('SELECT worker_choice FROM team_messages WHERE id = ?').get(sent.id)).toEqual({ worker_choice: null })
  })

  test('scheduled mail keeps its choice until it is due', () => {
    const sent = send({ workerChoice: 'claude', deliverAt: '2999-01-01T00:00:00.000Z' })
    expect(store.dueGroupMail()).toEqual([])
    expect(store.get(sent.id)!.workerChoice).toBe('claude')
  })

  test('a release back to the group queue keeps the choice', () => {
    const sent = send({ workerChoice: 'zai' })
    expect(store.claim(sent.id, 'chat-dev')).toBe(true)
    store.markPushed(sent.id)
    store.markDelivered(sent.id)
    expect(store.release(sent.id, 'devs')).toBe(true)
    expect(store.get(sent.id)).toMatchObject({ state: 'queued', workerChoice: 'zai' })
  })
})

test('a store opened on a version-16 database still enqueues mail without a choice', () => {
  const session = initDatabase({ path: ':memory:', migrations: MIGRATIONS.filter(migration => migration.version <= 16) })
  const store = new MailboxStore(session.db)
  const sent = store.enqueue({ teamId: TEAM, toKind: 'group', toId: 'devs', fromSession: null, fromGroup: null, originPath: '/repo', body: 'Old build' })
  expect('workerChoice' in sent).toBe(false)
  session.close()
})

describe('team_task_assignments.worker_choice', () => {
  let db: Database
  let assignments: AssignmentStore
  let taskId: string
  beforeEach(() => {
    db = schemaDb()
    const mail = new MailboxStore(db)
    assignments = new AssignmentStore(db, mail)
    taskId = new TaskStore(db, mail, assignments).create({ teamId: TEAM, title: 'T', direction: 'go', creator: { kind: 'human', sessionId: null } }).id
  })
  afterEach(() => db.close())
  const insert = (requestKey: string, workerChoice?: string) => assignments.insert({
    teamId: TEAM, taskId, requestKey, targetKind: 'group', targetId: 'devs', role: 'devs', instruction: 'Do it',
    creator: { kind: 'human', sessionId: null }, ...(workerChoice ? { workerChoice } : {}),
  })

  test('a dispatch round-trips its choice through insert, byKey, and listByTask', () => {
    expect(insert('k1', 'claude/sonnet').assignment.workerChoice).toBe('claude/sonnet')
    expect(assignments.byKey(TEAM, 'k1')!.workerChoice).toBe('claude/sonnet')
    expect(assignments.listByTask(taskId).map(row => row.workerChoice)).toEqual(['claude/sonnet'])
  })

  test('a dispatch without a choice reads exactly as before', () => {
    const { assignment } = insert('k2')
    expect('workerChoice' in assignment).toBe(false)
    expect(db.prepare('SELECT worker_choice FROM team_task_assignments WHERE id = ?').get(assignment.id)).toEqual({ worker_choice: null })
  })
})
