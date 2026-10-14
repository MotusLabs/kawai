import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MailboxStore, type EnqueueInput } from '../team/mailboxStore'
import { formatEnvelope, messageEnvelope } from '../team/envelope'

const TEAM = '/repo/.git'

describe('MailboxStore', () => {
  let dir: string
  let db: Database
  let store: MailboxStore

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-mailbox-'))
    db = new Database(path.join(dir, 'mail.db'))
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
  const dev = { teamId: TEAM, sessionId: 'chat-dev', groupId: 'devs' }

  test('enqueue records sender context and starts a thread', () => {
    const message = send({ tags: ['ui'], priority: 'urgent' })
    expect(message).toMatchObject({
      teamId: TEAM, toKind: 'group', toId: 'devs', fromSession: 'chat-lead', fromGroup: 'leads',
      originPath: '/repo', priority: 'urgent', tags: ['ui'], threadId: message.id, inReplyTo: null,
      hop: 1, state: 'queued', claimedBy: null, possibleDuplicate: false, attachThread: false, taskId: null,
    })
  })

  test('exactly one claim wins a race', () => {
    const message = send()
    expect(store.claim(message.id, 'chat-dev-1')).toBe(true)
    expect(store.claim(message.id, 'chat-dev-2')).toBe(false)
    expect(store.get(message.id)).toMatchObject({ state: 'claimed', claimedBy: 'chat-dev-1' })
  })

  test('rows persist across reopening the database', () => {
    const message = send({ deliverAt: '2099-01-01T00:00:00.000Z' })
    store.claim(send().id, 'chat-dev')
    db.close()
    db = new Database(path.join(dir, 'mail.db'))
    store = new MailboxStore(db)
    expect(store.get(message.id)?.deliverAt).toBe('2099-01-01T00:00:00.000Z')
    expect(store.unacknowledgedClaims()).toHaveLength(1)
  })

  test('eligibility orders urgent, then direct, then oldest, and waits for due times', () => {
    const t = (n: number) => `2026-10-11T00:00:0${n}.000Z`
    const groupOld = send({}, t(1))
    const direct = send({ toKind: 'session', toId: 'chat-dev' }, t(2))
    send({ toKind: 'session', toId: 'chat-other' }, t(3))
    const urgentGroup = send({ priority: 'urgent' }, t(4))
    send({ deliverAt: '2099-01-01T00:00:00.000Z', priority: 'urgent' }, t(5))
    expect(store.nextEligible(dev, t(9))?.id).toBe(urgentGroup.id)
    store.claim(urgentGroup.id, 'chat-dev')
    expect(store.nextEligible(dev, t(9))?.id).toBe(direct.id)
    store.claim(direct.id, 'chat-dev')
    expect(store.nextEligible(dev, t(9))?.id).toBe(groupOld.id)
    // A session without a group never sees group mail.
    expect(store.nextEligible({ ...dev, groupId: null }, t(9))).toBeNull()
    expect(store.nextDueAt(t(9))).toBe('2099-01-01T00:00:00.000Z')
    expect(store.teamsWithQueuedMail(t(9))).toEqual([TEAM])
  })

  test('delivery records push then acknowledgement; requeue forgets the claim', () => {
    const message = send()
    expect(store.markPushed(message.id)).toBe(false) // not claimed yet
    store.claim(message.id, 'chat-dev')
    expect(store.markPushed(message.id, 'T1')).toBe(true)
    expect(store.requeue(message.id)).toBe(true)
    expect(store.get(message.id)).toMatchObject({ state: 'queued', claimedBy: null, pushedAt: null })
    store.claim(message.id, 'chat-dev')
    store.markPushed(message.id)
    expect(store.markDelivered(message.id, 'T2')).toBe(true)
    expect(store.get(message.id)).toMatchObject({ state: 'delivered', deliveredAt: 'T2' })
    expect(store.unacknowledgedClaims()).toEqual([])
  })

  test('cancel, dead-letter, uncertain hold, retry, and discard follow their states', () => {
    const queued = send()
    expect(store.cancel(queued.id, { kind: 'human' })).toBe(true)
    expect(store.cancel(queued.id, { kind: 'human' })).toBe(false)

    const dead = send()
    expect(store.deadLetter(dead.id, 'killed')).toBe(true)
    expect(store.retry(dead.id)).toBe(true)
    expect(store.get(dead.id)).toMatchObject({ state: 'queued', reason: null, hop: 1 })
    store.deadLetter(dead.id, 'again')
    expect(store.discard(dead.id, { kind: 'human' })).toBe(true)
    expect(store.get(dead.id)?.state).toBe('discarded')

    // Uncertain: retried only to the same recipient, flagged as a duplicate.
    const unsure = send()
    store.claim(unsure.id, 'chat-dev')
    expect(store.holdUncertain(unsure.id, 'torn transcript')).toBe(true)
    expect(store.nextEligible(dev)).toBeNull()
    expect(store.retry(unsure.id)).toBe(true)
    expect(store.get(unsure.id)).toMatchObject({
      state: 'queued', toKind: 'session', toId: 'chat-dev', possibleDuplicate: true, claimedBy: null,
    })
    // Another member of the group cannot pick it up.
    expect(store.nextEligible({ ...dev, sessionId: 'chat-dev-2' })).toBeNull()
    expect(store.retry(send().id)).toBe(false)
  })

  test('urgent direct mail can wait for a request and is then claimable', () => {
    const urgent = send({ toKind: 'session', toId: 'chat-dev', priority: 'urgent' })
    expect(store.holdForRequest(urgent.id)).toBe(true)
    expect(store.awaitingRequestFor('chat-dev').map(m => m.id)).toEqual([urgent.id])
    expect(store.nextEligible(dev)).toBeNull()
    expect(store.claim(urgent.id, 'chat-dev')).toBe(true)
  })

  test('killing a recipient dead-letters its queued direct mail only', () => {
    const direct = send({ toKind: 'session', toId: 'chat-dev' })
    const group = send()
    expect(store.deadLetterDirectTo('chat-dev', 'recipient killed')).toBe(1)
    expect(store.get(direct.id)).toMatchObject({ state: 'dead', reason: 'recipient killed' })
    expect(store.get(group.id)?.state).toBe('queued')
    expect(store.listForTeam(TEAM).map(m => m.id)).toEqual([direct.id, group.id])
  })

  test('replies join the thread; a ping-pong past the hop limit is dead-lettered and retry resets it', () => {
    let last = send({ toKind: 'session', toId: 'chat-b' })
    for (let hop = 2; hop <= 3; hop++) {
      last = send({ toKind: 'session', toId: 'chat-a', inReplyTo: last, hopLimit: 3 })
    }
    expect(last).toMatchObject({ hop: 3, state: 'queued' })
    const over = send({ inReplyTo: last, hopLimit: 3 })
    expect(over).toMatchObject({ hop: 4, state: 'dead', reason: 'hop-limit', threadId: last.threadId })
    expect(store.thread(last.threadId)).toHaveLength(0) // Queued/dead sends are not delivered history.
    // Retry resets the hop, so the conversation can continue from there.
    store.retry(over.id)
    const next = send({ inReplyTo: store.get(over.id)!, hopLimit: 3 })
    expect(next).toMatchObject({ hop: 2, state: 'queued' })
  })

  test('the default hop limit is 20', () => {
    let last = send()
    for (let hop = 2; hop <= 20; hop++) last = send({ inReplyTo: last })
    expect(last.state).toBe('queued')
    expect(send({ inReplyTo: last }).state).toBe('dead')
  })

  test('a corrupt tag list reads as no tags', () => {
    const message = send({ tags: ['a'] })
    db.prepare("UPDATE team_messages SET tags = 'not json' WHERE id = $id").run({ $id: message.id })
    expect(store.get(message.id)?.tags).toEqual([])
    expect(store.get('missing')).toBeNull()
  })
})


test('retry to a killed direct or uncertain recipient cannot leave a queue row', () => {
  const db = new Database(':memory:')
  const store = new MailboxStore(db, { recipientExists: id => id !== 'killed' })
  try {
    for (const state of ['dead', 'uncertain']) {
      const row = store.enqueue({ teamId: TEAM, toKind: state === 'dead' ? 'session' : 'group', toId: state === 'dead' ? 'killed' : 'devs', fromSession: 'lead', fromGroup: null, originPath: '/repo', body: state })
      if (state === 'dead') store.deadLetter(row.id, 'killed-recipient')
      else { store.claim(row.id, 'killed'); store.markPushed(row.id); store.holdUncertain(row.id, 'torn') }
      expect(store.retry(row.id)).toBe(false)
      expect(store.get(row.id)).toMatchObject({ state: 'dead', reason: 'killed-recipient', toKind: 'session', toId: 'killed' })
    }
  } finally { db.close() }
})
test('thread history includes confirmed delivery only, excluding queued, cancelled and dead siblings', () => {
  const db = new Database(':memory:'); const store = new MailboxStore(db)
  const base = { teamId: TEAM, toKind: 'group' as const, toId: 'devs', fromSession: 'lead', fromGroup: null, originPath: '/repo', body: 'Confirmed' }
  try {
    const original = store.enqueue(base); store.claim(original.id, 'dev'); store.markPushed(original.id); store.markDelivered(original.id)
    for (const state of ['queued', 'cancelled', 'dead']) {
      const sibling = store.enqueue({ ...base, body: state, inReplyTo: original })
      if (state === 'cancelled') store.cancel(sibling.id, { kind: 'human' })
      if (state === 'dead') store.deadLetter(sibling.id, 'hop-limit')
    }
    expect(store.thread(original.threadId).map(row => row.body)).toEqual(['Confirmed'])
  } finally { db.close() }
})

test('fixed and dynamic SQL statements are compiled once and reused across calls', () => {
  const db = new Database(':memory:'); const prepare = spyOn(db, 'prepare')
  try {
    const store = new MailboxStore(db)
    const initialized = prepare.mock.calls.length
    for (let i=0; i<10; i++) { store.get('missing'); store.nextDueAt(); store.nextEligible({ teamId: TEAM, sessionId: 'dev', groupId: 'devs' }) }
    expect(prepare.mock.calls).toHaveLength(initialized)
    store.listForTeam(TEAM); const afterFirstList = prepare.mock.calls.length
    store.listForTeam(TEAM); expect(prepare.mock.calls).toHaveLength(afterFirstList)
  } finally { prepare.mockRestore(); db.close() }
})
test('urgentDirectFor returns only due urgent direct mail for the recipient, oldest first', () => {
  const db = new Database(':memory:'); const store = new MailboxStore(db)
  try {
    const base = { teamId: TEAM, toKind: 'session' as const, toId: 'chat-dev', fromSession: 'lead', fromGroup: null, originPath: '/repo', body: '' }
    const urgentOld = store.enqueue({ ...base, body: 'old', priority: 'urgent' }, '2026-01-01T00:00:00.000Z')
    store.enqueue({ ...base, body: 'normal', priority: 'normal' })
    store.enqueue({ ...base, body: 'urgent-new', priority: 'urgent' }, '2026-01-02T00:00:00.000Z')
    store.enqueue({ ...base, body: 'scheduled', priority: 'urgent', deliverAt: '2099-01-01T00:00:00.000Z' })
    const claimed = store.enqueue({ ...base, body: 'claimed', priority: 'urgent' })
    store.claim(claimed.id, 'chat-dev') // a claimed row must not come back as urgent-queued
    store.enqueue({ ...base, toId: 'chat-other', body: 'other', priority: 'urgent' })
    store.enqueue({ ...base, toKind: 'group', toId: 'devs', body: 'group', priority: 'urgent' })
    expect(store.urgentDirectFor('chat-dev').map(row => row.body)).toEqual(['old', 'urgent-new'])
    expect(store.urgentDirectFor('chat-dev')[0]!.id).toBe(urgentOld.id)
    expect(store.urgentDirectFor('chat-none')).toEqual([])
  } finally { db.close() }
})
test('claimsFor returns one session\'s unacknowledged claims only', () => {
  const db = new Database(':memory:'); const store = new MailboxStore(db)
  try {
    const base = { teamId: TEAM, toKind: 'group' as const, toId: 'devs', fromSession: 'lead', fromGroup: null, originPath: '/repo', body: '' }
    const mine = store.enqueue(base)
    store.enqueue(base)
    store.claim(mine.id, 'chat-dev')
    expect(store.claimsFor('chat-dev').map(row => row.id)).toEqual([mine.id])
    store.markPushed(mine.id)
    expect(store.claimsFor('chat-dev').map(row => row.id)).toEqual([mine.id])
    store.markDelivered(mine.id)
    expect(store.claimsFor('chat-dev')).toEqual([])
    expect(store.claimsFor('chat-none')).toEqual([])
  } finally { db.close() }
})

describe('profile routing columns', () => {
  test('a pre-routing table gains claim, parking, and handoff columns without losing rows', () => {
    const db = new Database(':memory:')
    db.exec(`CREATE TABLE team_messages (id TEXT PRIMARY KEY, team_id TEXT NOT NULL, to_kind TEXT NOT NULL, to_id TEXT NOT NULL, from_session TEXT NOT NULL, from_group TEXT, origin_path TEXT NOT NULL, priority TEXT NOT NULL DEFAULT 'normal', tags TEXT NOT NULL DEFAULT '[]', thread_id TEXT NOT NULL, in_reply_to TEXT, hop INTEGER NOT NULL DEFAULT 1, body TEXT NOT NULL, state TEXT NOT NULL, claimed_by TEXT, claimed_at TEXT, deliver_at TEXT, created_at TEXT NOT NULL, pushed_at TEXT, delivered_at TEXT, reason TEXT, possible_duplicate INTEGER NOT NULL DEFAULT 0, attach_thread INTEGER NOT NULL DEFAULT 0, task_id TEXT);
      INSERT INTO team_messages (id, team_id, to_kind, to_id, from_session, origin_path, thread_id, body, state, created_at) VALUES ('m1', '${TEAM}', 'group', 'devs', 'lead', '/repo', 'm1', 'hi', 'queued', '2026-01-01');`)
    const store = new MailboxStore(db)
    expect(store.get('m1')).toMatchObject({
      body: 'hi', claimCommit: null, parkedUntil: null, parkCount: 0, resumeMessageId: null, handoff: null, excludedProfile: null,
    })
    db.close()
  })

  test('park, unpark, release, and forward transitions', () => {
    const db = new Database(':memory:')
    const store = new MailboxStore(db)
    const send = () => store.enqueue({ teamId: TEAM, toKind: 'session', toId: 'dev', fromSession: 'lead', fromGroup: null, originPath: '/repo', body: 'b' })
    const m = send()
    store.claim(m.id, 'dev'); store.markPushed(m.id); store.markDelivered(m.id)
    expect(store.setClaimCommit(m.id, 'abc')).toBe(true)
    expect(store.setClaimCommit(m.id, 'def')).toBe(false)
    const resume = send()
    expect(store.park(m.id, '2026-10-12T13:00:00.000Z', resume.id)).toBe(true)
    expect(store.get(m.id)).toMatchObject({ state: 'parked', parkCount: 1, resumeMessageId: resume.id })
    expect(store.parkedBy('dev').map(row => row.id)).toEqual([m.id])
    expect(store.parkedFor(resume.id)?.id).toBe(m.id)
    expect(store.listForTeam(TEAM).some(row => row.id === m.id)).toBe(true)
    expect(store.unpark(m.id)).toBe(true)
    expect(store.get(m.id)).toMatchObject({ state: 'delivered', parkCount: 1, resumeMessageId: null })
    expect(store.release(m.id, 'devs')).toBe(true)
    expect(store.get(m.id)).toMatchObject({ state: 'queued', toKind: 'group', toId: 'devs', claimedBy: null, deliveredAt: null, claimCommit: null })
    expect(store.markForwarded(m.id, 'forwarded: x')).toBe(false)
    store.claim(m.id, 'dev'); store.markPushed(m.id); store.markDelivered(m.id)
    expect(store.markForwarded(m.id, 'forwarded: x')).toBe(true)
    expect(store.get(m.id)).toMatchObject({ state: 'forwarded', reason: 'forwarded: x' })
    db.close()
  })

  test('a corrupt handoff column reads as none', () => {
    const db = new Database(':memory:')
    const store = new MailboxStore(db)
    const m = store.enqueue({ teamId: TEAM, toKind: 'group', toId: 'devs', fromSession: 'lead', fromGroup: null, originPath: '/repo', body: 'b' })
    db.prepare("UPDATE team_messages SET handoff = '{not json' WHERE id = ?").run(m.id)
    expect(store.get(m.id)?.handoff).toBeNull()
    db.close()
  })
})


test.each([
  '{"fromSession":"dev"}',
  '{"fromSession":"dev","fromProfile":"glm","claimCommit":null,"lastError":null,"progress":{"toolCalls":1}}',
  '{"fromSession":"dev","fromProfile":"glm","claimCommit":null,"lastError":null,"progress":{"toolCalls":1,"tools":[],"filesTouched":[1]}}',
  '{broken',
])('malformed stored handoff %s degrades to no package and remains deliverable', handoff => {
  const db = new Database(':memory:')
  try {
    const store = new MailboxStore(db)
    const message = store.enqueue({ teamId: TEAM, toKind: 'session', toId: 'dev', fromSession: 'lead',
      fromGroup: null, originPath: '/repo', body: 'Continue' })
    db.prepare('UPDATE team_messages SET handoff = ? WHERE id = ?').run(handoff, message.id)
    const restored = store.get(message.id)!
    expect(restored.handoff).toBeNull()
    expect(formatEnvelope(messageEnvelope(restored))).toContain('Continue')
  } finally { db.close() }
})
