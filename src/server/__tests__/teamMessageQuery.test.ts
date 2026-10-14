// The Messages read model (team-message-threads D1/D6): delivered history and
// pending mail in one keyset-paged, filterable list, one thread's messages
// with their append-only events, and the task revision recorded at push time
// beside the delivery-time task context — a fact about the past that a later
// amendment must not rewrite.
import { beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { MailboxStore, type TeamMessage } from '../team/mailboxStore'
import { MessageQuery, type MessageCursor, type MessageQueryFilters } from '../team/messageQuery'
import { TaskStore } from '../team/taskStore'

const TEAM = '/repo/.git'
const OTHER = '/other/.git'
const EMPTY = '/third/.git'
const T = (n: number) => `2026-10-13T10:00:${String(n).padStart(2, '0')}.000Z`

let db: Database
let store: MailboxStore
let tasks: TaskStore
let query: MessageQuery

beforeEach(() => {
  db = new Database(':memory:')
  store = new MailboxStore(db)
  tasks = new TaskStore(db)
  query = new MessageQuery(db)
})

const send = (input: Partial<Parameters<MailboxStore['enqueue']>[0]> & { body: string }, now?: string): TeamMessage =>
  store.enqueue({
    teamId: TEAM, toKind: 'group', toId: 'devs', fromSession: 'lead', fromGroup: 'leads',
    originPath: '/repo', ...input,
  }, now)

const task = (teamId = TEAM) => tasks.create({
  teamId, title: 'Export', direction: 'CSV', creator: { kind: 'agent', sessionId: 'lead' },
})

/** A cross-section of rows: two teams, both actors, every state the view lists. */
function seed() {
  const exportTask = task()
  const review = send({ body: 'Review please', taskId: exportTask.id }, T(1))
  store.claim(review.id, 'dev', T(2)); store.markPushed(review.id, T(3), exportTask.revision); store.markDelivered(review.id, T(4))
  const question = send({ body: 'Quick question', toKind: 'session', toId: 'dev' }, T(5))
  store.claim(question.id, 'dev', T(6))
  const urgent = send({ body: 'Ship it', priority: 'urgent', toKind: 'session', toId: 'dev' }, T(7))
  const fromHuman = send({ body: 'Please advise', fromKind: 'human', fromSession: null, fromGroup: null }, T(8))
  const toHuman = send({
    body: 'Answer', toKind: 'human', toId: null, fromSession: 'dev', fromGroup: 'devs', taskId: exportTask.id,
  }, T(9))
  store.deliverOnSend(toHuman.id, exportTask.revision, T(10))
  const cancelled = send({ body: 'Never mind' }, T(11)); store.cancel(cancelled.id)
  const theirs = store.enqueue({
    teamId: OTHER, toKind: 'group', toId: 'devs', fromSession: 'x', fromGroup: 'devs',
    originPath: '/other', body: 'Another team',
  }, T(12))
  return { exportTask, review, question, urgent, fromHuman, toHuman, cancelled, theirs }
}

describe('list', () => {
  test('delivered history and pending mail come back together, newest first', () => {
    const rows = seed()
    const page = query.list(TEAM)
    expect(page.messages.map(message => message.body)).toEqual([
      'Never mind', 'Answer', 'Please advise', 'Ship it', 'Quick question', 'Review please',
    ])
    expect(page.messages.map(message => message.state)).toEqual([
      'cancelled', 'delivered', 'queued', 'queued', 'claimed', 'delivered',
    ])
    expect(page.nextCursor).toBeNull()
    expect(page.messages.map(message => message.id)).not.toContain(rows.theirs.id)
  })

  test('another team’s rows are never returned, under any filter', () => {
    seed()
    const filters: MessageQueryFilters[] = [
      {}, { taskId: task().id }, { threadId: 'anything' }, { groupId: 'devs' },
      { sessionId: 'dev' }, { priority: 'urgent' }, { state: 'queued' }, { human: true },
    ]
    for (const each of filters) {
      // Scoping is by team, not by the filter: each team sees only its own rows.
      expect(query.list(TEAM, each).messages.every(message => message.teamId === TEAM)).toBe(true)
      expect(query.list(OTHER, each).messages.every(message => message.teamId === OTHER)).toBe(true)
      expect(query.list(EMPTY, each).messages).toEqual([])
    }
  })

  test('filters by task, thread, role, session, priority, and delivery state', () => {
    const rows = seed()
    expect(query.list(TEAM, { taskId: rows.exportTask.id }).messages.map(m => m.body))
      .toEqual(['Answer', 'Review please'])
    expect(query.list(TEAM, { threadId: rows.review.threadId }).messages.map(m => m.body))
      .toEqual(['Review please'])
    // Role: the recipient group of group mail, or the sender's group. Direct
    // mail to a session belongs to neither role unless its sender is in one.
    expect(query.list(TEAM, { groupId: 'devs' }).messages.map(m => m.body))
      .toEqual(['Never mind', 'Answer', 'Please advise', 'Review please'])
    expect(query.list(TEAM, { groupId: 'leads' }).messages.map(m => m.body))
      .toEqual(['Never mind', 'Ship it', 'Quick question', 'Review please'])
    // Session: sender, current recipient, or claimant.
    expect(query.list(TEAM, { sessionId: 'dev' }).messages.map(m => m.body))
      .toEqual(['Answer', 'Ship it', 'Quick question', 'Review please'])
    expect(query.list(TEAM, { sessionId: 'lead' }).messages.map(m => m.body))
      .toEqual(['Never mind', 'Ship it', 'Quick question', 'Review please'])
    expect(query.list(TEAM, { priority: 'urgent' }).messages.map(m => m.body)).toEqual(['Ship it'])
    expect(query.list(TEAM, { state: 'delivered' }).messages.map(m => m.body))
      .toEqual(['Answer', 'Review please'])
    expect(query.list(TEAM, { state: ['queued', 'claimed'] }).messages.map(m => m.body))
      .toEqual(['Please advise', 'Ship it', 'Quick question'])
  })

  test('filters by human involvement in either direction', () => {
    seed()
    expect(query.list(TEAM, { human: true }).messages.map(m => m.body))
      .toEqual(['Answer', 'Please advise'])
    expect(query.list(TEAM, { human: false }).messages.map(m => m.body))
      .toEqual(['Never mind', 'Ship it', 'Quick question', 'Review please'])
  })

  test('filters combine, and an impossible combination is empty', () => {
    const rows = seed()
    expect(query.list(TEAM, { taskId: rows.exportTask.id, state: 'delivered' }).messages.map(m => m.body))
      .toEqual(['Answer', 'Review please'])
    expect(query.list(TEAM, { taskId: rows.exportTask.id, priority: 'urgent' }).messages).toEqual([])
    expect(query.list(TEAM, { human: true, state: 'queued' }).messages.map(m => m.body))
      .toEqual(['Please advise'])
  })

  test('paging walks the list once, newest first, with no repeats or gaps', () => {
    seed()
    const seen: string[] = []
    let cursor: MessageCursor | null = null
    for (let page = 0; page < 5; page++) {
      const result = query.list(TEAM, {}, cursor, 2)
      seen.push(...result.messages.map(message => message.body))
      if (page < 2) expect(result.nextCursor).not.toBeNull()
      cursor = result.nextCursor
      if (!cursor) break
    }
    expect(seen).toEqual(['Never mind', 'Answer', 'Please advise', 'Ship it', 'Quick question', 'Review please'])
    expect(cursor).toBeNull()
  })

  test('a page that ends exactly at the last row reports no further page', () => {
    seed()
    const first = query.list(TEAM, {}, null, 3)
    expect(first.messages).toHaveLength(3)
    expect(first.nextCursor).not.toBeNull()
    const second = query.list(TEAM, {}, first.nextCursor, 3)
    expect(second.messages).toHaveLength(3)
    expect(second.nextCursor).toBeNull()
    // The same walk with a page size that does not divide the list.
    const head = query.list(TEAM, {}, null, 4)
    expect(head.messages).toHaveLength(4)
    expect(head.nextCursor).not.toBeNull()
    const tail = query.list(TEAM, {}, head.nextCursor, 4)
    expect(tail.messages).toHaveLength(2)
    expect(tail.nextCursor).toBeNull()
  })

  test('rows sharing a timestamp page by rowid, with no repeats or gaps', () => {
    // One millisecond is enough for several enqueues, so the keyset's
    // tie-break is the row that decides whether a page boundary holds.
    for (const body of ['One', 'Two', 'Three', 'Four']) send({ body }, T(1))
    const seen: string[] = []
    let cursor: MessageCursor | null = null
    for (let page = 0; page < 4; page++) {
      const result = query.list(TEAM, {}, cursor, 2)
      seen.push(...result.messages.map(message => message.body))
      cursor = result.nextCursor
      if (!cursor) break
    }
    expect(seen).toEqual(['Four', 'Three', 'Two', 'One'])
    expect(cursor).toBeNull()
  })

  test('an empty team is an empty page with no cursor', () => {
    seed()
    expect(query.list(EMPTY)).toEqual({ messages: [], nextCursor: null })
    expect(query.list(TEAM, { taskId: 'task-missing' })).toEqual({ messages: [], nextCursor: null })
  })
})

describe('thread', () => {
  test('a thread lists its messages chronologically, each with its own events', () => {
    const rows = seed()
    const reply = send({
      body: 'On it', toKind: 'human', toId: null, fromSession: 'dev', fromGroup: 'devs',
      inReplyTo: rows.fromHuman,
    }, T(20))
    store.deliverOnSend(reply.id, rows.exportTask.revision, T(21))
    const thread = query.thread(TEAM, rows.fromHuman.threadId)
    expect(thread.map(entry => entry.message.body)).toEqual(['Please advise', 'On it'])
    expect(thread[0]!.events.map(event => event.kind)).toEqual(['sent'])
    expect(thread[1]!.events.map(event => event.kind)).toEqual(['sent', 'delivered'])
    expect(thread[1]!.message.taskRevision).toBe(rows.exportTask.revision)
  })

  test('a thread of another team is empty, and events stay per message', () => {
    const rows = seed()
    expect(query.thread(OTHER, rows.review.threadId)).toEqual([])
    const events = query.threadEvents(rows.review.threadId)
    expect(events.map(event => event.kind)).toEqual(['sent', 'claimed', 'pushed', 'delivered'])
  })
})

describe('task revision at push time (D6)', () => {
  test('a later amendment does not rewrite the revision the delivery carried', () => {
    const created = task()
    const message = send({ body: 'Work', taskId: created.id }, T(1))
    store.claim(message.id, 'dev', T(2))
    store.markPushed(message.id, T(3), created.revision)
    store.markDelivered(message.id, T(4))
    expect(store.get(message.id)?.taskRevision).toBe(1)
    tasks.amend(created.id, { direction: 'JSON' }, { kind: 'agent', sessionId: 'lead' })
    expect(tasks.get(created.id)?.revision).toBe(2)
    const row = store.get(message.id)
    expect(row?.taskRevision).toBe(1)
    expect(query.list(TEAM, { taskId: created.id }).messages[0]?.taskRevision).toBe(1)
  })

  test('a human-directed reply carries the revision, and a taskless message records none', () => {
    const created = task()
    const toHuman = send({ body: 'Done', toKind: 'human', toId: null, fromSession: 'dev', fromGroup: 'devs' }, T(1))
    store.deliverOnSend(toHuman.id, created.revision, T(2))
    expect(store.get(toHuman.id)?.taskRevision).toBe(1)
    const taskless = send({ body: 'Ping' }, T(3))
    store.claim(taskless.id, 'dev', T(4)); store.markPushed(taskless.id, T(5))
    expect(store.get(taskless.id)?.taskRevision).toBeNull()
  })
})
