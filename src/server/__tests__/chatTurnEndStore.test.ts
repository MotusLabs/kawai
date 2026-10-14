// The morning summary's durable turn-end rows (team-workspace D8, delta
// review B): written once per completed task-bound turn, read by window from
// SQL, surviving a restart, and aging out after seven days.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ChatTurnEndStore, TURN_END_RETENTION_MS } from '../chat/chatTurnEndStore'
import { initDatabase, type SessionDatabase } from '../db'

let dir: string
let db: SessionDatabase
const base = Date.parse('2026-10-15T12:00:00Z')
let clock = base

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-turn-ends-'))
  db = initDatabase({ path: path.join(dir, 'test.db') })
  clock = base
})
afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }) })

const store = () => new ChatTurnEndStore(db.db, () => clock)

test('rows read back inside the window, oldest first; older rows stay out', () => {
  const turns = store()
  turns.record('chat-1', 'task-1', '2026-10-14T08:00:00Z')
  turns.record('chat-2', 'task-2', '2026-10-14T09:00:00Z')
  turns.record('chat-3', 'task-3', '2026-10-01T09:00:00Z')
  expect(turns.since('2026-10-13T12:00:00Z')).toEqual([
    { sessionId: 'chat-1', taskId: 'task-1', endedAt: '2026-10-14T08:00:00Z' },
    { sessionId: 'chat-2', taskId: 'task-2', endedAt: '2026-10-14T09:00:00Z' },
  ])
})

test('rows survive a restart: a new store on the same database reads them', () => {
  store().record('chat-1', 'task-1', '2026-10-14T08:00:00Z')
  const restarted = store()
  expect(restarted.since('2026-10-13T12:00:00Z')).toEqual([
    { sessionId: 'chat-1', taskId: 'task-1', endedAt: '2026-10-14T08:00:00Z' },
  ])
})

test('startup prunes rows past the retention; the window keeps recent ones', () => {
  const turns = store()
  const recent = '2026-10-14T08:00:00Z' // a day old
  const stale = new Date(base - TURN_END_RETENTION_MS - 60_000).toISOString() // 7 days and a minute
  turns.record('chat-1', 'task-1', recent)
  turns.record('chat-2', 'task-2', stale)
  // A restart a moment later prunes only the stale row.
  clock += 1_000
  const restarted = store()
  expect(restarted.since('1970-01-01T00:00:00Z')).toEqual([
    { sessionId: 'chat-1', taskId: 'task-1', endedAt: recent },
  ])
})

test('write-path pruning runs at most once an hour', () => {
  const turns = store()
  const stale = new Date(base - TURN_END_RETENTION_MS - 60_000).toISOString()
  turns.record('chat-1', 'task-1', stale)
  // Half an hour later, a write does not prune yet.
  clock = base + 30 * 60 * 1000
  turns.record('chat-2', 'task-2', '2026-10-15T11:30:00Z')
  expect(turns.since('1970-01-01T00:00:00Z')).toHaveLength(2)
  // Past the hour, the next write prunes the stale row.
  clock = base + 61 * 60 * 1000
  turns.record('chat-3', 'task-3', '2026-10-15T12:00:00Z')
  expect(turns.since('1970-01-01T00:00:00Z')).toHaveLength(2)
  expect(turns.since('1970-01-01T00:00:00Z').map(row => row.sessionId)).toEqual(['chat-2', 'chat-3'])
})
