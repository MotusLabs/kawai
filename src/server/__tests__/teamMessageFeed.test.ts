// The live half of the Messages read model (team-message-threads 4.3): a
// watcher of a team is notified when that team's mail changes — send, delivery,
// retry, cancel — and every (re)registration starts from the authoritative
// snapshot of its own filters. Another team's watchers hear nothing.
import { beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { schemaDb } from './schemaDb'
import type { TeamMessage } from '../../shared/team'
import { MailboxStore } from '../team/mailboxStore'
import { MessageFeed, type MessageFeedEvent } from '../team/messageFeed'
import { MessageQuery } from '../team/messageQuery'

const TEAM = '/repo/.git'
const OTHER = '/other/.git'
const T = (n: number) => `2026-10-13T10:00:${String(n).padStart(2, '0')}.000Z`

let db: Database
let store: MailboxStore
let feed: MessageFeed
let events: MessageFeedEvent[]
let release: () => void

beforeEach(() => {
  db = schemaDb(':memory:')
  store = new MailboxStore(db)
  feed = new MessageFeed(store, new MessageQuery(db))
  events = []
  release = feed.watch(TEAM, {}, event => events.push(event))
})

/** The changed rows pushed so far (the only place a push appears). */
const changed = (log: MessageFeedEvent[] = events): TeamMessage[] =>
  log.flatMap(event => (event.kind === 'changed' ? event.messages : []))

/** The pages the log carried, newest watcher first. */
const pages = (log: MessageFeedEvent[]) =>
  log.filter((event): event is Extract<MessageFeedEvent, { kind: 'snapshot' }> => event.kind === 'snapshot')
    .map(event => event.page)

const send = (body: string, now: string, teamId = TEAM) => store.enqueue({
  teamId, toKind: 'group', toId: 'devs', fromSession: 'lead', fromGroup: 'leads',
  originPath: '/repo', body,
}, now)

describe('MessageFeed', () => {
  test('a watch starts from the authoritative snapshot of its filters', () => {
    const first = send('One', T(1))
    release()
    const filtered: MessageFeedEvent[] = []
    feed.watch(TEAM, { state: 'queued' }, event => filtered.push(event))
    expect(filtered).toHaveLength(1)
    expect(pages(filtered)[0]?.messages.map(row => row.id)).toEqual([first.id])
    expect(pages(filtered)[0]?.nextCursor).toBeNull()
  })

  test('send, delivery, retry, and cancel each notify the watcher', () => {
    events = []
    const delivered = send('Work', T(1))
    store.claim(delivered.id, 'dev', T(2))
    store.markPushed(delivered.id, T(3))
    store.markDelivered(delivered.id, T(4))
    // Delivery is terminal for a row: only an undelivered one can dead-letter.
    const retried = send('Stuck', T(5))
    store.deadLetter(retried.id, 'uncertain')
    store.retry(retried.id)
    const cancelled = send('Never mind', T(6))
    store.cancel(cancelled.id, { kind: 'human' })
    // One push per transition, each carrying the row as it stands after it.
    // A push keeps its row in `claimed`: it records pushed_at, not a state.
    expect(changed().map(row => row.state)).toEqual([
      'queued', 'claimed', 'claimed', 'delivered',
      'queued', 'dead', 'queued',
      'queued', 'cancelled',
    ])
    expect(changed().map(row => row.id)).toEqual([
      delivered.id, delivered.id, delivered.id, delivered.id,
      retried.id, retried.id, retried.id,
      cancelled.id, cancelled.id,
    ])
    expect(changed()[1]?.pushedAt).toBeNull()
    expect(changed()[2]?.pushedAt).toBe(T(3))
    expect(changed()[3]?.deliveredAt).toBe(T(4))
  })

  test('a reconnect registers again and gets a snapshot of the current filters', () => {
    const first = send('One', T(1))
    release()
    const second = send('Two', T(2))
    const reconnected: MessageFeedEvent[] = []
    feed.watch(TEAM, { state: 'queued' }, event => reconnected.push(event))
    expect(pages(reconnected)[0]?.messages.map(row => row.id)).toEqual([second.id, first.id])
    expect(pages(reconnected)[0]?.nextCursor).toBeNull()
    // The new registration keeps receiving pushes; the old one no longer does.
    events = []
    store.cancel(second.id, { kind: 'human' })
    expect(changed()).toHaveLength(0)
    expect(changed(reconnected)).toHaveLength(1)
  })

  test('another team’s watchers are never notified', () => {
    const theirs: MessageFeedEvent[] = []
    feed.watch(OTHER, {}, event => theirs.push(event))
    expect(theirs).toHaveLength(1)
    send('Ours', T(1))
    store.enqueue({
      teamId: OTHER, toKind: 'group', toId: 'devs', fromSession: 'x', fromGroup: 'devs',
      originPath: '/other', body: 'Theirs',
    }, T(2))
    expect(changed().map(message => message.body)).toEqual(['Ours'])
    expect(changed(theirs).map(message => message.body)).toEqual(['Theirs'])
  })

  test('unwatch stops the notifications; other watchers keep theirs', () => {
    const extra: MessageFeedEvent[] = []
    const releaseExtra = feed.watch(TEAM, {}, event => extra.push(event))
    send('One', T(1))
    expect(changed()).toHaveLength(1)
    expect(changed(extra)).toHaveLength(1)
    release()
    releaseExtra()
    send('Two', T(2))
    expect(changed()).toHaveLength(1)
    expect(changed(extra)).toHaveLength(1)
  })

  test('a filtered watcher is still told about rows that leave its filter', () => {
    release()
    const queued: MessageFeedEvent[] = []
    feed.watch(TEAM, { state: 'queued' }, event => queued.push(event))
    const message = send('Work', T(1))
    store.claim(message.id, 'dev', T(2))
    // The push is unfiltered: a client filtering on queued needs the claim to
    // know the row has left its list. The snapshot is filtered — and empty
    // here, because the watch registered before the row existed.
    expect(changed(queued).map(row => row.state)).toEqual(['queued', 'claimed'])
    expect(pages(queued)[0]?.messages).toHaveLength(0)
    expect(feed.snapshot(TEAM, { state: 'queued' }).messages).toHaveLength(0)
    expect(feed.snapshot(TEAM, {}).messages).toHaveLength(1)
  })
})
