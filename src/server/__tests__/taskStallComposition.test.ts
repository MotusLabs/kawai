// Manual-task stall notices through the production `SessionMailbox`
// composition (manual-task-stall-alerts A2, A5, I4, tasks 3.3, 4.2, 4.3): the
// shipped subscription notices a stalled task once per episode; a task an
// execution owns, seen through the shipped ownership binding, gets none; a
// restart does not repeat a notice; a flush dropped by a crash is recovered
// by the next counted message, measured from the original progress anchor.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ChatAgentDriver } from '../chat/provider/driver'
import { NULL_OWNERSHIP, type ExecutionOwnership } from '../plans/execution/executionOwnership'
import { SessionMailbox } from '../team/sessionMailbox'
import { SessionTeams } from '../team/sessionTeams'
import { TASK_STALL_TAG } from '../team/taskStallNotices'
import { schemaDb } from './schemaDb'

const TEAM = '/repo/.git'
const T0 = Date.parse('2026-11-10T08:00:00.000Z')
const MIN = 60_000
const HOUR = 60 * MIN
const at = (ms: number) => new Date(T0 + ms).toISOString()

let dir: string
let dbPath: string
let db: Database
let clock: number
const errors: unknown[] = []
const open: SessionMailbox[] = []

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-task-stall-composition-'))
  dbPath = path.join(dir, 'agentboard.db')
  db = schemaDb(dbPath)
  clock = T0
  errors.length = 0
})
afterEach(() => {
  for (const runtime of open.splice(0)) runtime.close()
  db.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

/** The production composition over `database`, on the test clock. */
function compose(database: Database = db, ownership: ExecutionOwnership = NULL_OWNERSHIP): SessionMailbox {
  const runtime = new SessionMailbox(database, {
    ownership, onTaskResultWrite: () => {},
    teams: new SessionTeams({ homeDir: dir }), records: () => [], getRecord: () => undefined, available: () => true,
    getDriver: () => ({ getPendingRequests: () => [], deliver: () => {} }) as unknown as ChatAgentDriver,
    prepare: async () => {}, restore: () => {}, watchReceipt: () => {}, archive: () => ({ ok: true }), hasLiveWorkers: () => false,
    hasRunningBackgroundTasks: () => false, transcriptFor: () => null, homeDir: dir, now: () => clock,
    onError: error => { errors.push(error) },
  })
  open.push(runtime)
  return runtime
}

const tick = () => new Promise(resolve => setImmediate(resolve))
const taskOf = (runtime: SessionMailbox) => runtime.tasks.store.create(
  { teamId: TEAM, title: 'Resume extraction', direction: 'Do it.', creator: { kind: 'agent', sessionId: 'chat-lead' } }, at(0))
const send = (runtime: SessionMailbox, taskId: string, ms: number) => runtime.tasks.store.mail!.enqueue({
  teamId: TEAM, toKind: 'session', toId: 'chat-dev', fromSession: 'chat-advisor', fromGroup: null,
  originPath: '/repo', body: `advice at ${ms}`, taskId,
}, at(ms))
const effects = (database: Database, taskId: string) => ({
  rows: database.prepare('SELECT task_id, anchor_at, anchor_kind, message_count FROM team_task_stall_notices WHERE task_id = ? ORDER BY anchor_at').all(taskId),
  journal: (database.prepare("SELECT COUNT(*) AS n FROM team_task_journal WHERE task_id = ? AND text LIKE 'Stall notice:%'").get(taskId) as { n: number }).n,
  messages: (database.prepare('SELECT tags FROM team_messages WHERE task_id = ?').all(taskId) as { tags: string }[])
    .filter(row => (JSON.parse(row.tags) as string[]).includes(TASK_STALL_TAG)).length,
})
/** Nine counted messages in the first 90 minutes, evaluated then. */
async function nineEarly(runtime: SessionMailbox, taskId: string) {
  for (let i = 1; i <= 9; i++) send(runtime, taskId, i * 10 * MIN)
  clock = T0 + 90 * MIN
  await tick()
}

// @covers: task-stall-notices › Each episode sends at most one notice › Two messages commit together past the thresholds
test('A2: through SessionMailbox, a counted message past both thresholds notices once, with one row, one journal entry, and one task-stall message', async () => {
  const runtime = compose()
  const task = taskOf(runtime)
  await nineEarly(runtime, task.id)
  expect(effects(db, task.id)).toEqual({ rows: [], journal: 0, messages: 0 })
  clock = T0 + 3 * HOUR
  send(runtime, task.id, 3 * HOUR)
  send(runtime, task.id, 3 * HOUR + 1000)
  await tick()
  await tick()
  expect(effects(db, task.id)).toEqual({ rows: [{ task_id: task.id, anchor_at: at(0), anchor_kind: 'created', message_count: 11 }], journal: 1, messages: 1 })
  expect(errors).toEqual([])
})

// @covers: task-stall-notices › A notice is sent when both thresholds are met › An execution's task is left to plan supervision
test('I4: through SessionMailbox, a task an execution owns past both thresholds gets no notice, while a manual task beside it does', async () => {
  let ownedId: string | null = null
  const runtime = compose(db, { ...NULL_OWNERSHIP, ownerOfTask: id => id === ownedId
    ? { executionId: 'execution-1', revision: 1, change: 'owned-change', step: null, worktree: null, branch: null } : null })
  const owned = taskOf(runtime)
  ownedId = owned.id
  const manual = taskOf(runtime)
  await nineEarly(runtime, owned.id)
  await nineEarly(runtime, manual.id)
  clock = T0 + 3 * HOUR
  send(runtime, owned.id, 3 * HOUR)
  send(runtime, manual.id, 3 * HOUR)
  await tick()
  expect(effects(db, owned.id)).toEqual({ rows: [], journal: 0, messages: 0 })
  expect(effects(db, manual.id)).toMatchObject({ journal: 1, messages: 1 })
  expect(errors).toEqual([])
})

// @covers: task-stall-notices › Each episode sends at most one notice › The loop continues after a notice
test('the loop continues after a notice: a second notice only once both thresholds hold again from the first', async () => {
  const runtime = compose()
  const task = taskOf(runtime)
  await nineEarly(runtime, task.id)
  clock = T0 + 3 * HOUR
  send(runtime, task.id, 3 * HOUR)
  await tick()
  const noticeAt = (db.prepare('SELECT created_at AS at FROM team_task_stall_notices').get() as { at: string }).at
  expect(noticeAt).toBe(at(3 * HOUR))
  for (let i = 1; i <= 10; i++) send(runtime, task.id, 3 * HOUR + i * 5 * MIN)
  clock = T0 + 4 * HOUR
  await tick()
  expect(effects(db, task.id).rows).toHaveLength(1)
  clock = T0 + 6 * HOUR
  send(runtime, task.id, 6 * HOUR)
  await tick()
  const rows = effects(db, task.id).rows as Array<{ anchor_at: string; anchor_kind: string; message_count: number }>
  expect(rows.map(row => [row.anchor_kind, row.anchor_at, row.message_count])).toEqual([['created', at(0), 10], ['notice', noticeAt, 11]])
})

// @covers: task-stall-notices › Each episode sends at most one notice › A restart does not repeat a notice
test('4.2: after a notice, a rebuilt SessionMailbox over the same database sends no second notice on the next message', async () => {
  const first = compose()
  const task = taskOf(first)
  await nineEarly(first, task.id)
  clock = T0 + 3 * HOUR
  send(first, task.id, 3 * HOUR)
  await tick()
  const noticed = effects(db, task.id)
  expect(noticed.rows).toHaveLength(1)
  first.close()
  db.close()

  db = new Database(dbPath)
  const second = compose(db)
  expect(effects(db, task.id)).toEqual(noticed)
  clock = T0 + 3 * HOUR + 10 * MIN
  send(second, task.id, 3 * HOUR + 10 * MIN)
  await tick()
  expect(effects(db, task.id)).toEqual(noticed)
  expect(errors).toEqual([])
})

// @covers: task-stall-notices › Each episode sends at most one notice › A dropped evaluation is recovered by the next message
test('4.3: a flush dropped before it ran is recovered by the next counted message, from the original progress anchor', async () => {
  const first = compose()
  const task = taskOf(first)
  await nineEarly(first, task.id)
  clock = T0 + 3 * HOUR
  // The threshold-crossing message commits; the server stops before its flush.
  send(first, task.id, 3 * HOUR)
  first.close()
  await tick()
  db.close()

  db = new Database(dbPath)
  const second = compose(db)
  expect(effects(db, task.id)).toEqual({ rows: [], journal: 0, messages: 0 })
  clock = T0 + 3 * HOUR + 20 * MIN
  send(second, task.id, 3 * HOUR + 20 * MIN)
  await tick()
  const recovered = effects(db, task.id)
  expect(recovered).toEqual({ rows: [{ task_id: task.id, anchor_at: at(0), anchor_kind: 'created', message_count: 11 }], journal: 1, messages: 1 })
  expect(second.stallNotices.flush()).toEqual([])
  await tick()
  expect(effects(db, task.id)).toEqual(recovered)
  expect(errors).toEqual([])
})
