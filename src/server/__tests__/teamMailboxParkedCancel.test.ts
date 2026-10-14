import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MailboxStore, type EnqueueInput } from '../team/mailboxStore'

const TEAM = '/repo/.git'
const lead = { kind: 'agent', sessionId: 'chat-lead' } as const

describe('MailboxStore cancel and discard with actors (team-mailbox-management)', () => {
  let dir: string
  let db: Database
  let store: MailboxStore

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-mailbox-cancel-'))
    db = new Database(path.join(dir, 'mail.db'))
    store = new MailboxStore(db)
  })
  afterEach(() => {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const send = (overrides: Partial<EnqueueInput> = {}) => store.enqueue({
    teamId: TEAM, toKind: 'group', toId: 'devs', fromSession: 'chat-lead', fromGroup: 'leads',
    originPath: '/repo', body: 'Build the thing', ...overrides,
  })

  /** Work held by chat-dev, parked until a scheduled resume message. */
  const parked = () => {
    const work = send({ toKind: 'session', toId: 'chat-dev' })
    store.claim(work.id, 'chat-dev')
    store.markPushed(work.id)
    store.markDelivered(work.id)
    const resume = send({ toKind: 'session', toId: 'chat-dev', fromSession: 'chat-dev', deliverAt: '2099-01-01T00:00:00.000Z' })
    expect(store.park(work.id, '2099-01-01T00:00:00.000Z', resume.id)).toBe(true)
    return { work, resume }
  }

  test('an existing events table gains actor_session and old rows read null', () => {
    const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-events-old-'))
    try {
      const old = new Database(path.join(legacyDir, 'mail.db'))
      old.exec(`CREATE TABLE team_message_events (message_id TEXT NOT NULL, team_id TEXT NOT NULL, seq INTEGER NOT NULL, created_at TEXT NOT NULL, kind TEXT NOT NULL, actor TEXT NOT NULL, prev_state TEXT, prev_claimed_by TEXT, prev_recipient TEXT, prev_reason TEXT, reason TEXT, PRIMARY KEY (message_id, seq));
        INSERT INTO team_message_events VALUES ('m1', '${TEAM}', 1, '2026-01-01', 'sent', 'human', NULL, NULL, NULL, NULL, NULL);`)
      const reopened = new MailboxStore(old)
      expect(reopened.eventsFor('m1')).toMatchObject([{ kind: 'sent', actor: 'human', actorSession: null }])
      old.close()
    } finally {
      fs.rmSync(legacyDir, { recursive: true, force: true })
    }
  })

  test('human cancel logs actor human without a reason; agent cancel logs the session and reason', () => {
    const human = send()
    expect(store.cancel(human.id, { kind: 'human' })).toBe(true)
    expect(store.eventsFor(human.id).at(-1)).toMatchObject({ kind: 'cancelled', actor: 'human', actorSession: null, reason: null })
    expect(store.get(human.id)?.reason).toBeNull()

    const mine = send()
    expect(store.cancel(mine.id, lead, 'stale follow-up')).toBe(true)
    expect(store.get(mine.id)).toMatchObject({ state: 'cancelled', reason: 'cancelled by chat-lead: stale follow-up' })
    expect(store.eventsFor(mine.id).at(-1)).toMatchObject({
      kind: 'cancelled', actor: 'agent', actorSession: 'chat-lead', prevState: 'queued', reason: 'cancelled by chat-lead: stale follow-up',
    })
  })

  test('agent text is cut to 300 characters and discard attributes the agent', () => {
    const dead = send()
    store.deadLetter(dead.id, 'killed')
    expect(store.discard(dead.id, lead, 'x'.repeat(500))).toBe(true)
    const reason = store.get(dead.id)!.reason!
    expect(reason).toBe(`discarded by chat-lead: ${'x'.repeat(300)}`)
    expect(store.eventsFor(dead.id).at(-1)).toMatchObject({ kind: 'discarded', actor: 'agent', actorSession: 'chat-lead', prevReason: 'killed' })
  })

  test('cancel refuses claimed, spawning and delivered mail and writes nothing', () => {
    const claimed = send(); store.claim(claimed.id, 'chat-dev')
    const spawning = send(); store.reserveForSpawn(spawning.id)
    const delivered = send(); store.claim(delivered.id, 'chat-dev'); store.markPushed(delivered.id); store.markDelivered(delivered.id)
    for (const [message, state] of [[claimed, 'claimed'], [spawning, 'spawning'], [delivered, 'delivered']] as const) {
      const events = store.eventsFor(message.id).length
      expect(store.cancel(message.id, lead, 'no')).toBe(false)
      expect(store.get(message.id)?.state).toBe(state)
      expect(store.eventsFor(message.id)).toHaveLength(events)
    }
  })

  test('parked cancel cancels the work and its queued resume mail together, both events recorded', () => {
    const { work, resume } = parked()
    expect(store.cancel(work.id, lead, 'obsolete')).toBe(true)
    expect(store.get(work.id)).toMatchObject({ state: 'cancelled', parkedUntil: null, resumeMessageId: null })
    expect(store.get(resume.id)).toMatchObject({ state: 'cancelled', reason: 'parked work ' + work.id + ' cancelled' })
    expect(store.eventsFor(work.id).at(-1)).toMatchObject({ kind: 'cancelled', actor: 'agent', prevState: 'parked' })
    expect(store.eventsFor(resume.id).at(-1)).toMatchObject({ kind: 'cancelled', actor: 'agent', actorSession: 'chat-lead', prevState: 'queued' })
    expect(store.parkedBy('chat-dev')).toHaveLength(0)
    expect(store.nextEligible({ teamId: TEAM, sessionId: 'chat-dev', groupId: 'devs' }, '2100-01-01T00:00:00.000Z')).toBeNull()
  })

  test('an awaiting-request resume is cancelled with the work', () => {
    const { work, resume } = parked()
    store.holdForRequest(resume.id)
    expect(store.cancel(work.id, lead, 'x')).toBe(true)
    expect(store.get(resume.id)?.state).toBe('cancelled')
    expect(store.claim(resume.id, 'chat-dev')).toBe(false)
  })

  test('a claimed or delivered resume means the resume turn is in flight: refused, both rows unchanged', () => {
    for (const settle of [(id: string) => store.claim(id, 'chat-dev'), (id: string) => { store.claim(id, 'chat-dev'); store.markPushed(id); store.markDelivered(id) }]) {
      const { work, resume } = parked()
      settle(resume.id)
      const before = [JSON.stringify(store.get(work.id)), JSON.stringify(store.get(resume.id)), store.eventsFor(work.id).length]
      expect(store.cancelResult(work.id, { kind: 'human' })).toEqual({ ok: false, code: 'resume-in-flight', holder: 'chat-dev', resumeId: resume.id })
      expect(store.cancel(work.id, lead, 'x')).toBe(false)
      expect([JSON.stringify(store.get(work.id)), JSON.stringify(store.get(resume.id)), store.eventsFor(work.id).length]).toEqual(before)
    }
  })

  test('work with a settled resume (rows from before this change) is cancelled alone', () => {
    const { work, resume } = parked()
    store.cancel(resume.id, { kind: 'human' }) // refused while linked, so settle it the legacy way
    db.prepare("UPDATE team_messages SET state = 'cancelled' WHERE id = ?").run(resume.id)
    expect(store.cancel(work.id, lead, 'x')).toBe(true)
    expect(store.get(work.id)?.state).toBe('cancelled')
  })

  test('a resume linked to parked work cannot be cancelled by anyone; once the work is unparked it can', () => {
    const { work, resume } = parked()
    for (const actor of [{ kind: 'human' } as const, lead, { kind: 'agent', sessionId: 'chat-dev' } as const]) {
      const before = JSON.stringify([store.get(resume.id), store.eventsFor(resume.id)])
      expect(store.cancelResult(resume.id, actor, 'x')).toEqual({ ok: false, code: 'linked-resume', parkedId: work.id })
      expect(JSON.stringify([store.get(resume.id), store.eventsFor(resume.id)])).toBe(before)
    }
    store.replaceResume(work.id)
    store.unpark(work.id)
    const stray = parked()
    store.unpark(stray.work.id)
    expect(store.get(stray.resume.id)?.state).toBe('queued')
    expect(store.cancel(stray.resume.id, { kind: 'human' })).toBe(true)
  })

  test('replaceResume unlinks and cancels an undelivered resume as the system, and leaves a delivered one', () => {
    const { work, resume } = parked()
    store.replaceResume(work.id)
    expect(store.get(work.id)).toMatchObject({ state: 'parked', resumeMessageId: null })
    expect(store.get(resume.id)?.state).toBe('cancelled')
    expect(store.eventsFor(resume.id).at(-1)).toMatchObject({ kind: 'cancelled', actor: 'system' })

    const second = parked()
    store.claim(second.resume.id, 'chat-dev'); store.markPushed(second.resume.id); store.markDelivered(second.resume.id)
    store.replaceResume(second.work.id)
    expect(store.get(second.work.id)?.resumeMessageId).toBeNull()
    expect(store.get(second.resume.id)?.state).toBe('delivered')
    store.replaceResume('missing')
    store.replaceResume(second.work.id)
  })

  test('race: a resume claimed first refuses the cancel; a cancel first leaves nothing to claim', () => {
    const first = parked()
    store.claim(first.resume.id, 'chat-dev', '2099-01-02T00:00:00.000Z')
    expect(store.cancel(first.work.id, lead, 'late')).toBe(false)
    expect(store.get(first.work.id)?.state).toBe('parked')
    expect(store.get(first.resume.id)?.state).toBe('claimed')
    expect(store.eventsFor(first.work.id).map(event => event.kind)).not.toContain('cancelled')

    const second = parked()
    expect(store.cancel(second.work.id, lead, 'early')).toBe(true)
    expect(store.claim(second.resume.id, 'chat-dev', '2099-01-02T00:00:00.000Z')).toBe(false)
    expect(store.get(second.resume.id)?.state).toBe('cancelled')
  })

  test('parked cancel is atomic: a failure cancelling the resume rolls the work back to parked', () => {
    const { work, resume } = parked()
    db.exec(`CREATE TRIGGER fail_resume BEFORE UPDATE ON team_messages WHEN OLD.id = '${resume.id}' AND NEW.state = 'cancelled'
      BEGIN SELECT RAISE(ABORT, 'boom'); END`)
    expect(() => store.cancel(work.id, lead, 'x')).toThrow()
    expect(store.get(work.id)).toMatchObject({ state: 'parked', resumeMessageId: resume.id })
    expect(store.get(resume.id)?.state).toBe('queued')
    expect(store.eventsFor(work.id).map(event => event.kind)).not.toContain('cancelled')
  })
})

describe('cancelResult typed outcomes', () => {
  test('ok, state-changed, resume-in-flight, and linked-resume', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-cancel-result-'))
    const db = new Database(path.join(dir, 'mail.db'))
    try {
      const store = new MailboxStore(db)
      const base = { teamId: TEAM, toKind: 'group', toId: 'devs', fromSession: 'chat-lead', fromGroup: 'leads', originPath: '/repo', body: 'x' } as const
      const queued = store.enqueue(base)
      expect(store.cancelResult(queued.id, { kind: 'human' })).toEqual({ ok: true })
      expect(store.cancelResult(queued.id, { kind: 'human' })).toEqual({ ok: false, code: 'state-changed', state: 'cancelled' })
      expect(store.cancelResult('missing', { kind: 'human' })).toEqual({ ok: false, code: 'state-changed', state: null })
    } finally {
      db.close(); fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
