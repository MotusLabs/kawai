// Tables TR and EF of manual-task-stall-alerts (design "Acceptance oracles")
// against the shipped `TaskStallNotices` and `emitStallNotice`: only a
// durable counted enqueue after the anchor triggers an evaluation; a due
// episode writes one row, one journal entry, and a message to a session
// creator; the same episode handed again writes nothing; nothing else
// about the task changes.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { schemaCopy } from './schemaDb'
import { AssignmentStore } from '../team/assignmentStore'
import { MailboxStore } from '../team/mailboxStore'
import { TaskStore } from '../team/taskStore'
import { emitStallNotice, TASK_STALL_TAG, TaskStallNotices, type StallEpisode } from '../team/taskStallNotices'
import type { TaskCreator, TeamTask } from '../../shared/teamTasks'

const TEAM = '/repo/.git'
const T0 = Date.parse('2026-11-10T08:00:00.000Z')
const MIN = 60_000
const HOUR = 60 * MIN
const at = (ms: number) => new Date(T0 + ms).toISOString()
const LEAD: TaskCreator = { kind: 'agent', sessionId: 'chat-lead' }
const HUMAN: TaskCreator = { kind: 'human', sessionId: null }

let db: { db: Database }
let mail: MailboxStore
let store: TaskStore
let clock: number
let owned: boolean
let notices: TaskStallNotices
const errors: unknown[] = []

beforeEach(() => {
  db = { db: schemaCopy() }
  mail = new MailboxStore(db.db)
  store = new TaskStore(db.db, mail, new AssignmentStore(db.db, mail))
  clock = T0
  owned = false
  errors.length = 0
  notices = new TaskStallNotices(store, mail, { ownedByExecution: () => owned, now: () => clock, onError: error => errors.push(error) })
})
afterEach(() => {
  notices.close()
  db.db.close()
})

const task = (creator: TaskCreator = LEAD): TeamTask =>
  store.create({ teamId: TEAM, title: 'Resume extraction', direction: 'Do it.', creator }, at(0))
const send = (taskId: string, ms: number, from: 'agent' | 'human' | 'system' = 'agent') => mail.enqueue({
  teamId: TEAM, toKind: 'session', toId: 'chat-dev', fromKind: from,
  fromSession: from === 'agent' ? `chat-advisor-${ms % 3}` : null, fromGroup: null,
  originPath: '/repo', body: `advice at ${ms}`, taskId,
}, at(ms))
/** Ten counted messages in the task's first 40 minutes, evaluated then: not due. */
const tenEarly = (taskId: string) => {
  for (let i = 1; i <= 10; i++) send(taskId, i * 4 * MIN)
  clock = T0 + 40 * MIN
  expect(notices.flush()).toEqual([])
}
const effects = (taskId: string) => ({
  rows: db.db.prepare('SELECT * FROM team_task_stall_notices WHERE task_id = ? ORDER BY anchor_at').all(taskId),
  journal: store.journal(taskId).filter(entry => entry.text.startsWith('Stall notice')).map(entry => entry.text),
  messages: mail.forTask(taskId).filter(message => message.tags.includes(TASK_STALL_TAG)).map(message => `${message.toKind}:${message.toId}:${message.fromKind}`),
})
const none = { rows: [], journal: [], messages: [] }

describe('TR: the trigger check', () => {
  // @covers: task-stall-notices › A notice is sent when both thresholds are met › An advisory loop crosses both thresholds
  test('TR1: a committed counted enqueue after the anchor that crosses both thresholds notices', () => {
    const t = task()
    for (let i = 1; i <= 9; i++) send(t.id, i * 10 * MIN)
    clock = T0 + 3 * HOUR + 10 * MIN
    expect(notices.flush()).toEqual([])
    send(t.id, 3 * HOUR + 10 * MIN)
    const [notice] = notices.flush()
    expect(notice!.episode).toMatchObject({ taskId: t.id, anchorAt: at(0), anchorKind: 'created', count: 10 })
    const seen = effects(t.id)
    expect(seen.rows).toHaveLength(1)
    expect(seen.journal).toHaveLength(1)
    expect(seen.messages).toEqual(['session:chat-lead:system'])
    expect(errors).toEqual([])
  })

  test('TR1 deferred: the flush runs on its own after the enqueue', async () => {
    const t = task()
    for (let i = 1; i <= 9; i++) send(t.id, i * 10 * MIN)
    notices.flush()
    clock = T0 + 3 * HOUR
    send(t.id, 3 * HOUR)
    expect(effects(t.id).rows).toHaveLength(0)
    await new Promise(resolve => setImmediate(resolve))
    expect(effects(t.id).rows).toHaveLength(1)
  })

  // @covers: task-stall-notices › A notice is sent when both thresholds are met › A rolled-back message triggers nothing
  test('TR2: an enqueue rolled back by its caller triggers nothing, though old mail meets both thresholds', () => {
    const t = task()
    tenEarly(t.id)
    clock = T0 + 3 * HOUR
    expect(() => db.db.transaction(() => {
      send(t.id, 3 * HOUR)
      throw new Error('caller rolls back')
    })()).toThrow('caller rolls back')
    expect(mail.forTask(t.id)).toHaveLength(10)
    expect(notices.flush()).toEqual([])
    expect(effects(t.id)).toEqual(none)
  })

  // @covers: task-stall-notices › A notice is sent when both thresholds are met › Delivering old mail triggers nothing
  test('TR3: a claim, push, and delivery of an old message trigger nothing', () => {
    const t = task()
    tenEarly(t.id)
    clock = T0 + 3 * HOUR
    const old = mail.forTask(t.id)[0]!
    expect(mail.claim(old.id, 'chat-dev')).toBe(true)
    expect(mail.markPushed(old.id)).toBe(true)
    expect(mail.markDelivered(old.id)).toBe(true)
    expect(notices.flush()).toEqual([])
    expect(effects(t.id)).toEqual(none)
  })

  test('TR4: Kawai\'s own enqueue on the task triggers nothing', () => {
    const t = task()
    tenEarly(t.id)
    clock = T0 + 3 * HOUR
    send(t.id, 3 * HOUR, 'system')
    expect(notices.flush()).toEqual([])
    expect(effects(t.id)).toEqual(none)
  })
})

describe('EF: emitStallNotice', () => {
  const episode = (taskId: string): StallEpisode => ({ taskId, anchorAt: at(0), anchorKind: 'created', count: 10, senders: ['chat-a', 'human'], elapsedMs: 3 * HOUR + 5 * MIN })

  // @covers: task-stall-notices › The notice is journaled and sent to a session creator › The Lead's task stalls
  test('EF1: a new episode of an agent-created task writes a row, a journal entry, and one task-stall message', () => {
    const t = task(LEAD)
    const notice = emitStallNotice(store, { task: t, originPath: '/repo', episode: episode(t.id), now: at(3 * HOUR + 5 * MIN) })
    expect(notice!.messageId).not.toBeNull()
    const seen = effects(t.id)
    expect(seen.rows).toEqual([{ task_id: t.id, anchor_at: at(0), anchor_kind: 'created', message_count: 10, message_id: notice!.messageId, created_at: at(3 * HOUR + 5 * MIN) }])
    expect(seen.journal).toEqual([`Stall notice: 10 messages from chat-a, human in 3h 5m since created at ${at(0)}, with no new revision, result, or counted review. Judge it by "Keep advisory checkpoints separate from final review" (docs/agent-collaboration.md); nothing waits.`])
    expect(seen.messages).toEqual(['session:chat-lead:system'])
    const message = mail.get(notice!.messageId!)!
    expect([message.taskId, message.tags]).toEqual([t.id, [TASK_STALL_TAG]])
    expect(message.body).toContain(`Task "Resume extraction" (${t.id}) has 10 messages`)
  })

  // @covers: task-stall-notices › The notice is journaled and sent to a session creator › The human's task stalls
  test('EF2: a human-created task gets the row and the journal entry, and no message', () => {
    const t = task(HUMAN)
    const notice = emitStallNotice(store, { task: t, originPath: '/repo', episode: episode(t.id), now: at(4 * HOUR) })
    expect(notice!.messageId).toBeNull()
    const seen = effects(t.id)
    expect([seen.rows.length, seen.journal.length, seen.messages.length]).toEqual([1, 1, 0])
    expect(mail.forTask(t.id)).toEqual([])
  })

  test('EF3: the same episode handed again writes nothing', () => {
    const t = task(LEAD)
    expect(emitStallNotice(store, { task: t, originPath: '/repo', episode: episode(t.id), now: at(4 * HOUR) })).not.toBeNull()
    const before = effects(t.id)
    const allMail = mail.forTask(t.id).length
    expect(emitStallNotice(store, { task: t, originPath: '/repo', episode: episode(t.id), now: at(5 * HOUR) })).toBeNull()
    expect(effects(t.id)).toEqual(before)
    expect(mail.forTask(t.id)).toHaveLength(allMail)
  })

  test('EF4: a not-due evaluation through the composition writes nothing', () => {
    const t = task()
    tenEarly(t.id)
    expect(effects(t.id)).toEqual(none)
  })
})

describe('the notice decides nothing', () => {
  // @covers: task-stall-notices › The notice is journaled and sent to a session creator › Nothing waits on the notice
  test('a notice leaves the status, revision, and assignment as they were, and later mail flows as before', () => {
    const t = task()
    store.setStatus(t.id, 'active')
    const before = store.get(t.id)!
    for (let i = 1; i <= 10; i++) send(t.id, i * 10 * MIN)
    clock = T0 + 3 * HOUR
    send(t.id, 3 * HOUR)
    expect(notices.flush()).toHaveLength(1)
    const after = store.get(t.id)!
    // A journal entry bumps updatedAt, as every journal write does; nothing else moves.
    expect([after.status, after.revision, after.direction]).toEqual([before.status, before.revision, before.direction])
    expect(store.results.listByTask(t.id)).toEqual([])
    expect(db.db.prepare('SELECT COUNT(*) AS n FROM team_task_assignments WHERE task_id = ?').get(t.id)).toEqual({ n: 0 })
    const later = send(t.id, 3 * HOUR + MIN)
    expect(mail.get(later.id)!.state).toBe('queued')
  })

  test('a composition replay after a notice adds nothing: the notice anchors the next episode', () => {
    const t = task()
    for (let i = 1; i <= 10; i++) send(t.id, i * 10 * MIN)
    clock = T0 + 3 * HOUR
    send(t.id, 3 * HOUR)
    expect(notices.flush()).toHaveLength(1)
    const before = effects(t.id)
    clock = T0 + 3 * HOUR + 30 * MIN
    send(t.id, 3 * HOUR + 30 * MIN)
    send(t.id, 3 * HOUR + 31 * MIN)
    expect(notices.flush()).toEqual([])
    expect(notices.flush()).toEqual([])
    expect(effects(t.id)).toEqual(before)
  })
})
