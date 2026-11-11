// Properties P1 and P2 of manual-task-stall-alerts (design "Properties",
// task 4.1), seed 0x57A11, 300 cases. Each case drives two manual tasks
// through a seeded sequence of counted mail, mail rolled back by its caller,
// Kawai mail, revisions, results, counted reviews, deliveries of old mail,
// flushes, duplicate flushes, and dropped flushes (a crash before the
// flush). P1: the notices written equal a reference model that replays
// `stallOf` over the same sequence, with one journal entry and one message
// per notice. P2: everything else (tasks, findings, assignments, other mail,
// other journal entries) equals a run with the module unsubscribed.
import { expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { schemaCopy } from './schemaDb'
import { AssignmentStore } from '../team/assignmentStore'
import { MailboxStore } from '../team/mailboxStore'
import { TaskStore } from '../team/taskStore'
import { TASK_STALL_TAG, TaskStallNotices } from '../team/taskStallNotices'
import { stallAnchor, stallOf, type StallMail } from '../../shared/taskStall'
import { propertyCases } from './helpers/propertyCases'

const SEED = 0x57A11
const CASES = 300
const OPS = 120
const TEAM = '/repo/.git'
const T0 = Date.parse('2026-11-10T08:00:00.000Z')
const MIN = 60_000

function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type Op = { kind: 'mail' | 'human' | 'rollback' | 'system' | 'revision' | 'result' | 'review' | 'deliver' | 'flush' | 'dup' | 'drop'; task: 0 | 1; step: number }
const WEIGHTS: Array<[Op['kind'], number]> = [
  ['mail', 45], ['human', 5], ['rollback', 4], ['system', 4], ['revision', 1], ['result', 1], ['review', 1], ['deliver', 4], ['flush', 30], ['dup', 3], ['drop', 2],
]
function sequence(seed: number): Op[] {
  const next = rng(seed)
  const total = WEIGHTS.reduce((sum, [, weight]) => sum + weight, 0)
  return Array.from({ length: OPS }, () => {
    let pick = next() * total
    const kind = WEIGHTS.find(([, weight]) => (pick -= weight) < 0)?.[0] ?? 'flush'
    return { kind, task: next() < 0.5 ? 0 : 1, step: 1 + Math.floor(next() * 20) }
  })
}

interface World { db: Database; mail: MailboxStore; store: TaskStore; notices: TaskStallNotices | null; clock: number; taskIds: string[] }
function world(withNotices: boolean): World {
  const db = schemaCopy()
  const mail = new MailboxStore(db)
  const store = new TaskStore(db, mail, new AssignmentStore(db, mail))
  const w: World = { db, mail, store, notices: null, clock: T0, taskIds: [] }
  const make = () => new TaskStallNotices(store, mail, { ownedByExecution: () => false, now: () => w.clock, onError: error => { throw error } })
  if (withNotices) w.notices = make()
  for (const title of ['A', 'B']) {
    const task = store.create({ teamId: TEAM, title, direction: 'Do it.', creator: { kind: 'agent', sessionId: `chat-lead-${title}` } }, new Date(T0).toISOString())
    store.setStatus(task.id, 'active', undefined, undefined, new Date(T0).toISOString())
    w.taskIds.push(task.id)
  }
  ;(w as World & { make: () => TaskStallNotices }).make = make
  return w
}

/** The reference model's view of one task (design D1 inputs, kept independently of the store). */
interface ModelTask { createdAt: string; revisionAt: string | null; resultAt: string | null; reviewAt: string | null; noticeAt: string | null; mail: StallMail[]; pending: Array<{ durable: boolean; counted: boolean; createdAt: string }>; notices: Array<[string, string, number]> }

function run(seed: number, withNotices: boolean) {
  const w = world(withNotices)
  const model: ModelTask[] = w.taskIds.map(() => ({ createdAt: new Date(T0).toISOString(), revisionAt: null, resultAt: null, reviewAt: null, noticeAt: null, mail: [], pending: [], notices: [] }))
  let seq = 0
  const nowIso = () => new Date(w.clock).toISOString()
  const send = (task: number, fromKind: 'agent' | 'human' | 'system') => w.mail.enqueue({
    teamId: TEAM, toKind: 'session', toId: 'chat-dev', fromKind, fromSession: fromKind === 'agent' ? `chat-advisor-${task}` : null, fromGroup: null,
    originPath: '/repo', body: `m${seq++}`, taskId: w.taskIds[task]!,
  }, nowIso())
  const modelFlush = () => {
    for (const m of model) {
      const { anchorAt } = stallAnchor(m)
      const trigger = m.pending.some(p => p.durable && p.counted && Date.parse(p.createdAt) > Date.parse(anchorAt))
      m.pending = []
      const state = stallOf({ status: 'active', owned: false, ...m, now: nowIso() })
      if (trigger && state.due) { m.notices.push([state.anchorAt, state.anchorKind, state.count]); m.noticeAt = nowIso() }
    }
  }
  for (const op of sequence(seed)) {
    w.clock += op.step * MIN
    const m = model[op.task]!
    const id = w.taskIds[op.task]!
    switch (op.kind) {
      case 'mail': case 'human': {
        const fromKind = op.kind === 'mail' ? 'agent' : 'human'
        send(op.task, fromKind)
        m.mail.push({ createdAt: nowIso(), fromKind, fromSession: null, fromGroup: null })
        m.pending.push({ durable: true, counted: true, createdAt: nowIso() })
        break
      }
      case 'rollback':
        try { w.db.transaction(() => { send(op.task, 'agent'); throw new Error('rollback') })() } catch { /* the caller rolled back */ }
        m.pending.push({ durable: false, counted: true, createdAt: nowIso() })
        break
      case 'system':
        send(op.task, 'system')
        break
      case 'revision':
        w.store.publish(id, { direction: `Do it, revision at ${seq++}.`, notify: false }, { kind: 'human', sessionId: null }, nowIso())
        m.revisionAt = nowIso()
        break
      case 'result':
        w.store.results.insert({ teamId: TEAM, taskId: id, summary: 'r', commit: null, diff: null, worktree: null, tests: [], limitations: null, taskRevision: 1, submittedBy: { kind: 'agent', sessionId: 'chat-dev' } }, nowIso())
        m.resultAt = nowIso()
        break
      case 'review':
        w.db.prepare(`INSERT INTO team_task_findings (id, team_id, task_id, result_id, kind, verdict, findings, author_kind, author_session, created_at, structured, counted, ledger_seq)
          VALUES (?, ?, ?, 'res', 'review', 'pass', '[]', 'agent', 'chat-reviewer', ?, 1, 1, ?)`).run(`f${seq}`, TEAM, id, nowIso(), seq++)
        m.reviewAt = nowIso()
        break
      case 'deliver': {
        const old = w.mail.forTask(id).find(message => message.state === 'queued' && message.fromKind !== 'system')
        if (old && w.mail.claim(old.id, 'chat-dev')) { w.mail.markPushed(old.id); w.mail.markDelivered(old.id) }
        break
      }
      case 'flush': w.notices?.flush(); if (withNotices) modelFlush(); break
      case 'dup': w.notices?.flush(); w.notices?.flush(); if (withNotices) modelFlush(); break
      case 'drop':
        if (w.notices) { w.notices.close(); w.notices = (w as World & { make: () => TaskStallNotices }).make() }
        for (const t of model) t.pending = []
        break
    }
  }
  w.notices?.flush()
  if (withNotices) modelFlush()
  w.notices?.close()
  return { w, model }
}

const rowsOf = (db: Database, taskId: string) => (db.prepare('SELECT anchor_at, anchor_kind, message_count FROM team_task_stall_notices WHERE task_id = ? ORDER BY anchor_at')
  .all(taskId) as Array<{ anchor_at: string; anchor_kind: string; message_count: number }>).map(row => [row.anchor_at, row.anchor_kind, row.message_count])

test(`P1: over ${CASES} seeded cases (seed 0x57A11) the notices equal the stallOf reference model, one journal entry and one message each`, () => {
  let noticed = 0
  let repeated = 0
  for (let c = 0; c < propertyCases(CASES); c++) {
    const { w, model } = run(SEED + c, true)
    w.taskIds.forEach((taskId, i) => {
      const rows = rowsOf(w.db, taskId)
      expect({ case: c, task: i, rows }).toEqual({ case: c, task: i, rows: model[i]!.notices })
      expect(w.store.journal(taskId).filter(entry => entry.text.startsWith('Stall notice')).length).toBe(rows.length)
      expect(w.mail.forTask(taskId).filter(message => message.tags.includes(TASK_STALL_TAG)).length).toBe(rows.length)
      noticed += rows.length
      if (rows.length > 1) repeated++
    })
    w.db.close()
  }
  // The generator reaches the interesting space: notices, and tasks noticed more than once.
  expect(noticed).toBeGreaterThan(propertyCases(CASES) / 3)
  expect(repeated).toBeGreaterThan(10)
}, 120_000)

const snapshot = (w: World) => ({
  tasks: w.db.prepare('SELECT title, status, revision FROM team_tasks ORDER BY title').all(),
  revisions: w.db.prepare('SELECT t.title, r.revision, r.direction, r.created_at FROM team_task_revisions r JOIN team_tasks t ON t.id = r.task_id ORDER BY t.title, r.revision').all(),
  findings: w.db.prepare('SELECT id, verdict, created_at FROM team_task_findings ORDER BY id').all(),
  assignments: w.db.prepare('SELECT COUNT(*) AS n FROM team_task_assignments').get(),
  mail: (w.db.prepare('SELECT body, from_kind, state, created_at, tags FROM team_messages ORDER BY created_at, body').all() as Array<{ tags: string }>)
    .filter(row => !(JSON.parse(row.tags) as string[]).includes(TASK_STALL_TAG)),
  journal: (w.db.prepare('SELECT t.title, j.text FROM team_task_journal j JOIN team_tasks t ON t.id = j.task_id ORDER BY j.created_at, j.rowid').all() as Array<{ text: string }>)
    .filter(row => !row.text.startsWith('Stall notice')),
})

test(`P2: over ${CASES} seeded cases nothing but the notices differs from a run with the module unsubscribed`, () => {
  for (let c = 0; c < propertyCases(CASES); c++) {
    const on = run(SEED + c, true).w
    const off = run(SEED + c, false).w
    expect({ case: c, ...snapshot(on) }).toEqual({ case: c, ...snapshot(off) })
    on.db.close()
    off.db.close()
  }
}, 120_000)
