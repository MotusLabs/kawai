// The morning summary's durable turn-end rows (team-workspace D8, delta
// review B and round-3 items): written once per completed task-bound turn
// with its outcome, read by window and team from SQL, surviving a restart,
// and aging out after seven days.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ChatTurnEndStore, TURN_END_RETENTION_MS } from '../chat/chatTurnEndStore'
import { initDatabase, type SessionDatabase } from '../db'
import { MailboxStore } from '../team/mailboxStore'
import { AssignmentStore } from '../team/assignmentStore'
import { TaskStore } from '../team/taskStore'
import { TaskService } from '../team/TaskService'

let dir: string
let db: SessionDatabase
let tasks: TaskService
const base = Date.parse('2026-10-15T12:00:00Z')
let clock = base

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-turn-ends-'))
  db = initDatabase({ path: path.join(dir, 'test.db') })
  const mail = new MailboxStore(db.db)
  tasks = new TaskService(new TaskStore(db.db, mail, new AssignmentStore(db.db, mail)), { getSession: () => undefined })
  clock = base
})
afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }) })

const store = () => new ChatTurnEndStore(db.db, () => clock)
const human = (teamId: string) => ({ kind: 'human' as const, team: { teamId, groupsRoot: dir } })

test('rows read back inside the window, oldest first, with their outcome; older rows stay out', () => {
  const turns = store()
  turns.record('chat-1', 'task-1', '2026-10-14T08:00:00Z', true)
  turns.record('chat-2', 'task-2', '2026-10-14T09:00:00Z', false)
  turns.record('chat-3', 'task-3', '2026-10-01T09:00:00Z', true)
  expect(turns.since('2026-10-13T12:00:00Z')).toEqual([
    { sessionId: 'chat-1', taskId: 'task-1', endedAt: '2026-10-14T08:00:00Z', ok: true },
    { sessionId: 'chat-2', taskId: 'task-2', endedAt: '2026-10-14T09:00:00Z', ok: false },
  ])
})

test('rows survive a restart: a new store on the same database reads them', () => {
  store().record('chat-1', 'task-1', '2026-10-14T08:00:00Z', true)
  const restarted = store()
  expect(restarted.since('2026-10-13T12:00:00Z')).toEqual([
    { sessionId: 'chat-1', taskId: 'task-1', endedAt: '2026-10-14T08:00:00Z', ok: true },
  ])
})

test('startup prunes rows past the retention; the window keeps recent ones', () => {
  const turns = store()
  const recent = '2026-10-14T08:00:00Z' // a day old
  const stale = new Date(base - TURN_END_RETENTION_MS - 60_000).toISOString() // 7 days and a minute
  turns.record('chat-1', 'task-1', recent, true)
  turns.record('chat-2', 'task-2', stale, true)
  // A restart a moment later prunes only the stale row.
  clock += 1_000
  const restarted = store()
  expect(restarted.since('1970-01-01T00:00:00Z')).toEqual([
    { sessionId: 'chat-1', taskId: 'task-1', endedAt: recent, ok: true },
  ])
})

test('write-path pruning runs at most once an hour', () => {
  const turns = store()
  const stale = new Date(base - TURN_END_RETENTION_MS - 60_000).toISOString()
  turns.record('chat-1', 'task-1', stale, true)
  // Half an hour later, a write does not prune yet.
  clock = base + 30 * 60 * 1000
  turns.record('chat-2', 'task-2', '2026-10-15T11:30:00Z', true)
  expect(turns.since('1970-01-01T00:00:00Z')).toHaveLength(2)
  // Past the hour, the next write prunes the stale row.
  clock = base + 61 * 60 * 1000
  turns.record('chat-3', 'task-3', '2026-10-15T12:00:00Z', true)
  expect(turns.since('1970-01-01T00:00:00Z').map(row => row.sessionId)).toEqual(['chat-2', 'chat-3'])
})

test("finishedForTeam keeps a killed session's turns, drops errored ones, and stays to one team", async () => {
  const ours = await tasks.create(human('team'), { title: 'Ours', direction: 'd' })
  const theirs = await tasks.create(human('other'), { title: 'Theirs', direction: 'd' })
  const turns = store()
  turns.record('killed-dev', ours.id, '2026-10-14T08:00:00Z', true) // session gone; task remains
  turns.record('live-dev', ours.id, '2026-10-14T09:00:00Z', true)
  turns.record('errored-dev', ours.id, '2026-10-14T10:00:00Z', false) // errored turn: never finished work
  turns.record('their-dev', theirs.id, '2026-10-14T11:00:00Z', true) // another team's row
  expect(turns.finishedForTeam('team', '2026-10-13T12:00:00Z')).toEqual([
    { sessionId: 'killed-dev', taskId: ours.id, endedAt: '2026-10-14T08:00:00Z', ok: true },
    { sessionId: 'live-dev', taskId: ours.id, endedAt: '2026-10-14T09:00:00Z', ok: true },
  ])
  // The window applies inside the query too.
  expect(turns.finishedForTeam('team', '2026-10-14T08:30:00Z').map(row => row.sessionId)).toEqual(['live-dev'])
})
