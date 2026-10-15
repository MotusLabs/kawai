import { schemaDb } from './schemaDb'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  cooldownUntil, DEFAULT_COOLDOWN_MS, LIMIT_EVENT_RETENTION_MS, LimitEventStore, type LimitEvent,
} from '../team/routing/limitEvents'

const T0 = Date.parse('2026-10-12T12:00:00.000Z')
const iso = (ms: number) => new Date(ms).toISOString()
const base = { profileId: 'glm', sessionId: 's1', groupId: 'devs', kind: 'rate_limit', status: 429, message: 'quota', resetsAt: null }

describe('LimitEventStore', () => {
  let dir: string
  let file: string
  let now: number
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-limits-'))
    file = path.join(dir, 'db.sqlite')
    now = T0
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  test('records events per profile with every field and notifies listeners', () => {
    const store = new LimitEventStore(schemaDb(file), () => now)
    const seen: LimitEvent[] = []
    store.subscribe(event => seen.push(event))
    const event = store.record({ ...base, final: true, resetsAt: iso(T0 + 600_000) })
    store.record({ ...base, profileId: 'mimo', final: false })
    expect(store.forProfile('glm')).toEqual([event])
    expect(event).toMatchObject({ ...base, final: true, at: iso(T0), resetsAt: iso(T0 + 600_000) })
    expect(seen.map(e => e.profileId)).toEqual(['glm', 'mimo'])
  })

  test('survives reopening the database (server restart)', () => {
    new LimitEventStore(schemaDb(file), () => now).record({ ...base, final: true })
    now = T0 + 10 * 60_000
    const reopened = new LimitEventStore(schemaDb(file), () => now)
    expect(reopened.forProfile('glm')).toHaveLength(1)
    expect(reopened.cooldownUntil('glm')).toBe(iso(T0 + DEFAULT_COOLDOWN_MS))
  })

  test('prunes events older than 24 hours on write and at startup', () => {
    const db = schemaDb(file)
    const store = new LimitEventStore(db, () => now)
    store.record({ ...base, final: false, at: iso(T0 - LIMIT_EVENT_RETENTION_MS - 1) })
    store.record({ ...base, final: false })
    expect(store.forProfile('glm')).toHaveLength(1)
    now = T0 + LIMIT_EVENT_RETENTION_MS + 1
    new LimitEventStore(db, () => now)
    const count = db.prepare('SELECT COUNT(*) AS n FROM profile_limit_events').get() as { n: number }
    expect(count.n).toBe(0)
  })
})

describe('cooldownUntil', () => {
  const event = (over: Partial<LimitEvent>): LimitEvent =>
    ({ id: crypto.randomUUID(), ...base, at: iso(T0), final: true, ...over })

  test('the provider reset time when known', () => {
    expect(cooldownUntil([event({ resetsAt: iso(T0 + 40 * 60_000) })], T0)).toBe(iso(T0 + 40 * 60_000))
  })

  test('one hour after the failure when the reset is unknown', () => {
    expect(cooldownUntil([event({})], T0 + 1)).toBe(iso(T0 + DEFAULT_COOLDOWN_MS))
  })

  test('retried attempts alone never cool', () => {
    expect(cooldownUntil([event({ final: false }), event({ final: false })], T0)).toBeNull()
  })

  test('the latest final event decides', () => {
    const events = [
      event({ resetsAt: iso(T0 + 5 * 3_600_000) }),
      event({ at: iso(T0 + 60_000), resetsAt: iso(T0 + 120_000) }),
    ]
    expect(cooldownUntil(events, T0 + 60_000)).toBe(iso(T0 + 120_000))
  })

  test('expires', () => {
    expect(cooldownUntil([event({})], T0 + DEFAULT_COOLDOWN_MS)).toBeNull()
    expect(cooldownUntil([event({ resetsAt: 'garbage' })], T0)).toBe(iso(T0 + DEFAULT_COOLDOWN_MS))
  })
})
