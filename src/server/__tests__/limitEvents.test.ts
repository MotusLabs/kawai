import { schemaDb } from './schemaDb'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  cooldownUntil, coolingMsWithin, coolingTimeline, DEFAULT_COOLDOWN_MS, LIMIT_EVENT_READ_WINDOW_MS, LIMIT_EVENT_RETENTION_MS,
  LimitEventStore, type LimitEvent,
} from '../team/routing/limitEvents'

const T0 = Date.parse('2026-10-12T12:00:00.000Z')
const iso = (ms: number) => new Date(ms).toISOString()
const base = { profileId: 'glm', sessionId: 's1', groupId: 'devs', kind: 'rate_limit', status: 429, message: 'quota', resetsAt: null, providerId: null, window: null }

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

  test('prunes events older than 15 days on write and at startup; routing still reads only 24 hours', () => {
    const DAY = 24 * 60 * 60 * 1000
    expect(LIMIT_EVENT_RETENTION_MS).toBe(15 * DAY)
    expect(LIMIT_EVENT_READ_WINDOW_MS).toBe(DAY)
    const db = schemaDb(file)
    const store = new LimitEventStore(db, () => now)
    store.record({ ...base, final: true, at: iso(T0 - 16 * DAY) })
    store.record({ ...base, final: true, at: iso(T0 - 10 * DAY) })
    store.record({ ...base, final: true, at: iso(T0 - DAY - 1), resetsAt: iso(T0 + DAY) })
    const count = () => (db.prepare('SELECT COUNT(*) AS n FROM profile_limit_events').get() as { n: number }).n
    // The 16-day-old event is pruned; the 10-day-old one is kept for metrics.
    expect(count()).toBe(2)
    // Routing ignores everything older than 24 hours exactly as before, even a reset still in the future.
    expect(store.forProfile('glm')).toEqual([])
    expect(store.cooldownUntil('glm')).toBeNull()
    store.record({ ...base, final: false })
    expect(store.forProfile('glm')).toHaveLength(1)
    now = T0 + 15 * DAY + 1
    new LimitEventStore(db, () => now)
    expect(count()).toBe(0)
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

describe('coolingTimeline', () => {
  const MIN = 60_000
  const HOUR = 60 * MIN
  let n = 0
  const event = (at: number, resetsAt: number | null, final = true): LimitEvent =>
    ({ id: `e${++n}`, ...base, at: iso(at), final, resetsAt: resetsAt === null ? null : iso(resetsAt) })

  test('a five-hour reset superseded a minute later by a one-minute reset counts about two minutes', () => {
    const events = [event(T0, T0 + 5 * HOUR), event(T0 + MIN, T0 + 2 * MIN)]
    expect(coolingTimeline(events)).toEqual([{ start: T0, end: T0 + 2 * MIN }])
    expect(coolingMsWithin(coolingTimeline(events), T0 - HOUR, T0 + 10 * HOUR)).toBe(2 * MIN)
  })

  test('a later event extends a cooldown; retried attempts never cool', () => {
    const events = [event(T0, null), event(T0 + 30 * MIN, T0 + 3 * HOUR), event(T0 + 4 * HOUR, null, false)]
    expect(coolingTimeline(events)).toEqual([{ start: T0, end: T0 + 3 * HOUR }])
  })

  test('a 30-hour reset is cut when the router read window drops it, and clipping to a window', () => {
    const intervals = coolingTimeline([event(T0, T0 + 30 * HOUR)])
    expect(intervals).toEqual([{ start: T0, end: T0 + 24 * HOUR }])
    expect(coolingMsWithin(intervals, T0 + 20 * HOUR, T0 + 48 * HOUR)).toBe(4 * HOUR)
  })

  test('a reset before the event itself and same-instant ties follow the router (later row wins)', () => {
    expect(coolingTimeline([event(T0, T0 - MIN)])).toEqual([])
    expect(coolingTimeline([event(T0, T0 + 5 * HOUR), event(T0, T0 + MIN)])).toEqual([{ start: T0, end: T0 + MIN }])
  })

  test('property: an instant is cooling exactly when cooldownUntil over its 24-hour read window says so', () => {
    // A deterministic generator: events on whole seconds, samples half a second off them.
    let seed = 42
    const rand = () => (seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648
    for (let round = 0; round < 40; round++) {
      const events: LimitEvent[] = []
      let at = T0
      for (let k = 0; k < 8; k++) {
        at += Math.floor(rand() * 20 * HOUR / 1000) * 1000
        const reset = rand() < 0.25 ? null : at + Math.floor((rand() * 40 * HOUR - 2 * HOUR) / 1000) * 1000
        events.push(event(at, reset, rand() < 0.8))
      }
      const intervals = coolingTimeline(events)
      for (let s = 0; s < 200; s++) {
        const t = T0 + Math.floor(rand() * 200 * HOUR / 1000) * 1000 + 500
        const visible = events.filter(e => Date.parse(e.at) >= t - LIMIT_EVENT_READ_WINDOW_MS && Date.parse(e.at) <= t)
        const inside = intervals.some(i => i.start <= t && t < i.end)
        expect({ t, inside }).toEqual({ t, inside: cooldownUntil(visible, t) !== null })
      }
    }
  })
})
