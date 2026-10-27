// @reads: docs/architecture/mailbox.md
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { schemaDb } from './schemaDb'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MailboxStore, type EnqueueInput } from '../team/mailboxStore'
import type { MessageEventKind } from '../../shared/team'

const TEAM = '/repo/.git'

describe('team_message_events', () => {
  let dir: string
  let db: Database
  let store: MailboxStore

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-events-'))
    db = schemaDb(path.join(dir, 'mail.db'))
    store = new MailboxStore(db)
  })
  afterEach(() => {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const send = (overrides: Partial<EnqueueInput> = {}, now?: string) => store.enqueue({
    teamId: TEAM, toKind: 'group', toId: 'devs', fromSession: 'chat-lead', fromGroup: 'leads',
    originPath: '/repo', body: 'Build the thing', ...overrides,
  }, now)

  const kinds = (id: string): MessageEventKind[] => store.eventsFor(id).map(event => event.kind)

  test('opening beside an existing team_messages table creates the events table and leaves message rows alone', () => {
    const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-events-legacy-'))
    try {
      const legacyDb = new Database(path.join(legacyDir, 'mail.db'))
      legacyDb.exec(`CREATE TABLE team_messages (id TEXT PRIMARY KEY, team_id TEXT NOT NULL, to_kind TEXT NOT NULL, to_id TEXT NOT NULL, from_session TEXT NOT NULL, from_group TEXT, origin_path TEXT NOT NULL, priority TEXT NOT NULL DEFAULT 'normal', tags TEXT NOT NULL DEFAULT '[]', thread_id TEXT NOT NULL, in_reply_to TEXT, hop INTEGER NOT NULL DEFAULT 1, body TEXT NOT NULL, state TEXT NOT NULL, claimed_by TEXT, claimed_at TEXT, deliver_at TEXT, created_at TEXT NOT NULL, pushed_at TEXT, delivered_at TEXT, reason TEXT, possible_duplicate INTEGER NOT NULL DEFAULT 0, attach_thread INTEGER NOT NULL DEFAULT 0, task_id TEXT);
        INSERT INTO team_messages (id, team_id, to_kind, to_id, from_session, origin_path, thread_id, body, state, created_at)
        VALUES ('legacy', '${TEAM}', 'group', 'devs', 'lead', '/repo', 'legacy', 'hi', 'delivered', '2026-01-01');`)
      legacyDb.close()
      const legacy = schemaDb(path.join(legacyDir, 'mail.db'))
      const legacyStore = new MailboxStore(legacy)
      const tables = (legacy.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
        .map(row => row.name)
      expect(tables).toContain('team_message_events')
      expect(legacyStore.get('legacy')).toMatchObject({ id: 'legacy', body: 'hi', state: 'delivered' })
      expect(legacyStore.eventsFor('legacy')).toEqual([])
      legacy.close()
    } finally {
      fs.rmSync(legacyDir, { recursive: true, force: true })
    }
  })

  test('every transition records exactly one event with increasing per-message sequences', () => {
    const message = send()
    expect(kinds(message.id)).toEqual(['sent'])
    store.claim(message.id, 'chat-dev')
    store.markPushed(message.id, 'T1')
    store.markDelivered(message.id, 'T2')
    expect(kinds(message.id)).toEqual(['sent', 'claimed', 'pushed', 'delivered'])
    const events = store.eventsFor(message.id)
    expect(events.map(event => event.seq)).toEqual([1, 2, 3, 4])
    expect(events.every(event => event.messageId === message.id && event.teamId === TEAM)).toBe(true)
    expect(events[1]).toMatchObject({ kind: 'claimed', actor: 'system', prevState: 'queued', prevClaimedBy: null })
    expect(events[2]).toMatchObject({ kind: 'pushed', createdAt: 'T1', prevState: 'claimed' })
    expect(events[3]).toMatchObject({ kind: 'delivered', createdAt: 'T2', prevState: 'claimed' })
  })

  test('retry, requeue, and release keep the claimant and reason their row update clears', () => {
    const unsure = send()
    store.claim(unsure.id, 'chat-dev')
    store.markPushed(unsure.id)
    store.holdUncertain(unsure.id, 'torn transcript')
    expect(store.eventsFor(unsure.id).at(-1)).toMatchObject({
      kind: 'held-uncertain', prevState: 'claimed', reason: 'torn transcript', prevReason: null,
    })
    expect(store.retry(unsure.id)).toBe(true)
    expect(store.eventsFor(unsure.id).at(-1)).toMatchObject({
      kind: 'retried', actor: 'human', prevState: 'uncertain',
      prevClaimedBy: 'chat-dev', prevReason: 'torn transcript', reason: null,
    })
    expect(store.get(unsure.id)).toMatchObject({ claimedBy: null, reason: null })

    store.claim(unsure.id, 'chat-dev')
    store.markPushed(unsure.id)
    store.markDelivered(unsure.id)
    store.park(unsure.id, '2026-10-12T13:00:00.000Z', send().id)
    expect(store.release(unsure.id, 'devs')).toBe(true)
    expect(store.eventsFor(unsure.id).at(-1)).toMatchObject({
      kind: 'released', prevState: 'parked', prevClaimedBy: 'chat-dev', prevRecipient: 'chat-dev',
    })

    const direct = send({ toKind: 'session', toId: 'chat-dev' })
    store.claim(direct.id, 'chat-dev')
    store.requeue(direct.id)
    expect(store.eventsFor(direct.id).at(-1)).toMatchObject({
      kind: 'requeued', prevState: 'claimed', prevClaimedBy: 'chat-dev',
    })
  })

  test('human actions are actor human; system delivery is actor system', () => {
    const queued = send()
    expect(store.cancel(queued.id, { kind: 'human' })).toBe(true)
    expect(store.eventsFor(queued.id).at(-1)).toMatchObject({ kind: 'cancelled', actor: 'human' })

    const dead = send()
    store.deadLetter(dead.id, 'killed')
    expect(store.eventsFor(dead.id).at(-1)).toMatchObject({ kind: 'dead-lettered', actor: 'system', reason: 'killed' })
    expect(store.retry(dead.id)).toBe(true)
    expect(store.eventsFor(dead.id).at(-1)).toMatchObject({ kind: 'retried', actor: 'human' })
    store.deadLetter(dead.id, 'again')
    expect(store.discard(dead.id, { kind: 'human' })).toBe(true)
    expect(store.eventsFor(dead.id).at(-1)).toMatchObject({ kind: 'discarded', actor: 'human' })

    const humanSent = send({ actor: 'human' })
    expect(store.eventsFor(humanSent.id).at(-1)).toMatchObject({ kind: 'sent', actor: 'human' })
  })

  test('an enqueue past the hop limit records a dead-lettered event with its reason', () => {
    let original = send()
    for (let hop = 1; hop < 20; hop++) {
      original = send({ inReplyTo: original }, `2026-10-11T00:00:${String(hop).padStart(2, '0')}.000Z`)
    }
    const over = send({ inReplyTo: original }, '2026-10-11T00:01:00.000Z')
    expect(over.state).toBe('dead')
    expect(store.eventsFor(over.id)).toMatchObject([{ kind: 'dead-lettered', reason: 'hop-limit', prevState: null }])
  })

  test('killing a recipient records one dead-lettered event per affected row', () => {
    const direct = send({ toKind: 'session', toId: 'chat-dev' })
    const group = send()
    expect(store.deadLetterDirectTo('chat-dev', 'killed-recipient')).toBe(1)
    expect(kinds(direct.id)).toEqual(['sent', 'dead-lettered'])
    expect(store.eventsFor(direct.id).at(-1)).toMatchObject({ reason: 'killed-recipient', prevRecipient: 'chat-dev' })
    expect(kinds(group.id)).toEqual(['sent'])
  })

  test('spawn reservation and claim record reserved then claimed', () => {
    const message = send()
    expect(store.reserveForSpawn(message.id)).toBe(true)
    expect(store.claimSpawned(message.id, 'chat-spawned')).toBe(true)
    expect(kinds(message.id)).toEqual(['sent', 'reserved', 'claimed'])
  })

  test('park, unpark, and forward each record their event', () => {
    const message = send({ toKind: 'session', toId: 'dev' })
    store.claim(message.id, 'dev'); store.markPushed(message.id); store.markDelivered(message.id)
    store.park(message.id, '2026-10-12T13:00:00.000Z', send().id)
    store.unpark(message.id)
    store.markForwarded(message.id, 'forwarded: next')
    expect(kinds(message.id)).toEqual(['sent', 'claimed', 'pushed', 'delivered', 'parked', 'unparked', 'forwarded'])
    expect(store.eventsFor(message.id).at(-1)).toMatchObject({ kind: 'forwarded', reason: 'forwarded: next' })
  })

  test('thread history covers every message of the thread and survives a reopen', () => {
    const first = send()
    const second = send({ inReplyTo: first })
    const other = send()
    store.claim(first.id, 'chat-dev')
    store.holdUncertain(first.id, 'torn')
    store.retry(first.id)
    const before = store.threadEvents(first.threadId)
    expect(before.map(event => event.messageId)).toEqual([first.id, first.id, first.id, first.id, second.id])
    expect(before.filter(event => event.messageId === second.id).map(event => event.kind)).toEqual(['sent'])
    expect(store.threadEvents(other.threadId).map(event => event.messageId)).toEqual([other.id])

    db.close()
    db = schemaDb(path.join(dir, 'mail.db'))
    store = new MailboxStore(db)
    expect(store.threadEvents(first.threadId)).toEqual(before)
    expect(store.eventsFor(first.id)).toEqual(before.filter(event => event.messageId === first.id))
  })

  test('the How It Works event kinds match the kinds the store records', () => {
    // Walk every transition once and collect the kinds it actually records.
    const observed = new Set<MessageEventKind>()
    const walk = (message: ReturnType<MailboxStore['enqueue']>) => {
      for (const event of store.eventsFor(message.id)) observed.add(event.kind)
      return message
    }
    walk(send())
    walk(send({ inReplyTo: send() }))
    const claimed = walk(send()); store.claim(claimed.id, 'chat-dev'); walk(claimed)
    const pushed = walk(send()); store.claim(pushed.id, 'chat-dev'); store.markPushed(pushed.id); walk(pushed)
    const delivered = walk(send()); store.claim(delivered.id, 'chat-dev'); store.markPushed(delivered.id)
    store.markDelivered(delivered.id); walk(delivered)
    const held = walk(send({ toKind: 'session', toId: 'chat-dev', priority: 'urgent' }))
    store.holdForRequest(held.id); walk(held)
    const requeued = walk(send({ toKind: 'session', toId: 'chat-dev' }))
    store.claim(requeued.id, 'chat-dev'); store.requeue(requeued.id); walk(requeued)
    const unsure = walk(send()); store.claim(unsure.id, 'chat-dev'); store.markPushed(unsure.id)
    store.holdUncertain(unsure.id, 'torn'); walk(unsure)
    store.retry(unsure.id); walk(unsure)
    const parked = walk(send()); store.claim(parked.id, 'chat-dev'); store.markPushed(parked.id)
    store.markDelivered(parked.id); store.park(parked.id, '2026-10-12T13:00:00.000Z', send().id); walk(parked)
    store.unpark(parked.id); walk(parked)
    store.release(parked.id, 'devs'); walk(parked)
    const forwarded = walk(send()); store.claim(forwarded.id, 'chat-dev'); store.markPushed(forwarded.id)
    store.markDelivered(forwarded.id); store.markForwarded(forwarded.id, 'forwarded: next'); walk(forwarded)
    const cancelled = walk(send()); store.cancel(cancelled.id, { kind: 'human' }); walk(cancelled)
    const discarded = walk(send()); store.deadLetter(discarded.id, 'killed'); store.discard(discarded.id, { kind: 'human' }); walk(discarded)
    const reserved = walk(send()); store.reserveForSpawn(reserved.id); store.claimSpawned(reserved.id, 'spawned'); walk(reserved)
    const killed = walk(send({ toKind: 'session', toId: 'chat-gone' }))
    store.deadLetterDirectTo('chat-gone', 'killed-recipient'); walk(killed)

    const documented = fs.readFileSync(path.join(import.meta.dir, '../../../docs/architecture/mailbox.md'), 'utf8')
      .split('\n').find(line => line.startsWith('- Every message state change is recorded'))!
    const kinds = new Set([...documented.matchAll(/`([a-z-]+)`/g)].map(match => match[1]!)
      .filter(name => name !== 'team_message_events' && name !== 'messageEvents.ts' && name !== 'MailboxStore' && name !== 'human' && name !== 'system'))
    expect([...kinds].sort()).toEqual([...observed].sort())
    expect([...observed].sort()).toEqual([
      'cancelled', 'claimed', 'dead-lettered', 'delivered', 'discarded', 'forwarded',
      'held-for-request', 'held-uncertain', 'parked', 'pushed', 'released', 'requeued',
      'reserved', 'retried', 'sent', 'unparked',
    ])
  })
})
