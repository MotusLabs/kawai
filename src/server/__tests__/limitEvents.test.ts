import { schemaDb } from './schemaDb'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  cooldownUntil, coolingMsWithin, coolingTimeline, DEFAULT_COOLDOWN_MS, LIMIT_EVENT_READ_WINDOW_MS, LIMIT_EVENT_RETENTION_MS,
  LimitEventStore, providerCooldownUntil, relevantEvents, type LimitEvent,
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
    expect(reopened.cooldownFor('glm').until).toBe(iso(T0 + DEFAULT_COOLDOWN_MS))
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
    expect(store.cooldownFor('glm').until).toBeNull()
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
    expect(cooldownUntil('glm', null, [event({ resetsAt: iso(T0 + 40 * 60_000) })], T0)).toBe(iso(T0 + 40 * 60_000))
  })

  test('one hour after the failure when the reset is unknown', () => {
    expect(cooldownUntil('glm', null, [event({})], T0 + 1)).toBe(iso(T0 + DEFAULT_COOLDOWN_MS))
  })

  test('retried attempts alone never cool', () => {
    expect(cooldownUntil('glm', null, [event({ final: false }), event({ final: false })], T0)).toBeNull()
  })

  test('the latest final event decides', () => {
    const events = [
      event({ resetsAt: iso(T0 + 5 * 3_600_000) }),
      event({ at: iso(T0 + 60_000), resetsAt: iso(T0 + 120_000) }),
    ]
    expect(cooldownUntil('glm', null, events, T0 + 60_000)).toBe(iso(T0 + 120_000))
  })

  test('expires', () => {
    expect(cooldownUntil('glm', null, [event({})], T0 + DEFAULT_COOLDOWN_MS)).toBeNull()
    expect(cooldownUntil('glm', null, [event({ resetsAt: 'garbage' })], T0)).toBe(iso(T0 + DEFAULT_COOLDOWN_MS))
  })
})

describe('provider cooldown (providers-and-workers D8)', () => {
  const MIN = 60_000
  const HOUR = 60 * MIN
  const DAY = 24 * HOUR
  const event = (over: Partial<LimitEvent>): LimitEvent =>
    ({ id: crypto.randomUUID(), ...base, at: iso(T0), final: true, ...over })

  test('profiles of one provider cool together from one event; others do not', () => {
    const glm = event({ providerId: 'zai', resetsAt: iso(T0 + 3 * HOUR) })
    expect(cooldownUntil('glm-flash', 'zai', [glm], T0)).toBe(iso(T0 + 3 * HOUR))
    expect(cooldownUntil('claude', 'claude', [glm], T0)).toBeNull()
    // Without a provider only the profile's own events count.
    expect(cooldownUntil('glm-flash', null, [glm], T0)).toBeNull()
  })

  test('a model-scoped window cools one profile', () => {
    const opus = event({ profileId: 'opus', providerId: 'claude', window: 'seven_day_opus', resetsAt: iso(T0 + 3 * DAY) })
    expect(cooldownUntil('opus', 'claude', [opus], T0)).toBe(iso(T0 + 3 * DAY))
    expect(cooldownUntil('sonnet', 'claude', [opus], T0)).toBeNull()
    expect(providerCooldownUntil('claude', [opus], T0)).toBeNull()
    expect(providerCooldownUntil(null, [opus], T0)).toBeNull()
  })

  test('a short later window does not release a weekly one', () => {
    const weekly = event({ profileId: 'opus', providerId: 'claude', window: 'seven_day', resetsAt: iso(T0 + 3 * DAY) })
    const short = event({ profileId: 'sonnet', at: iso(T0 + HOUR), providerId: 'claude', window: 'five_hour', resetsAt: iso(T0 + 2 * HOUR) })
    expect(cooldownUntil('opus', 'claude', [weekly, short], T0 + 2 * HOUR)).toBe(iso(T0 + 3 * DAY))
    expect(cooldownUntil('sonnet', 'claude', [weekly, short], T0 + 2 * HOUR)).toBe(iso(T0 + 3 * DAY))
  })

  test('events recorded before providers cool their profile alone', () => {
    const old = event({ providerId: null })
    expect(cooldownUntil('glm', 'zai', [old], T0)).toBe(iso(T0 + DEFAULT_COOLDOWN_MS))
    expect(cooldownUntil('glm-flash', 'zai', [old], T0)).toBeNull()
  })

  test('an unknown window cools the provider', () => {
    const weird = event({ profileId: 'glm', providerId: 'zai', window: 'seven_day_newmodel' })
    expect(cooldownUntil('glm-flash', 'zai', [weird], T0)).toBe(iso(T0 + DEFAULT_COOLDOWN_MS))
  })
})

// B2 (findings-7f4df8a6): the timeline is the router's rule — at every
// sampled instant, an event set's timeline holds t exactly when a store
// clocked at t reports the profile cooling.
describe('coolingTimeline equivalence with cooldownFor', () => {
  const MIN = 60_000
  const HOUR = 60 * MIN
  const DAY = 24 * HOUR
  let n = 0
  const event = (over: Partial<LimitEvent>): LimitEvent =>
    ({ id: `eq${++n}`, ...base, at: iso(T0), final: true, ...over })

  const SETS: Array<{ label: string; profile: string; provider: string; events: LimitEvent[] }> = [
    {
      label: 'same-window shorter replacement', profile: 'glm', provider: 'zai', events: [
        event({ resetsAt: iso(T0 + 5 * HOUR) }),
        event({ at: iso(T0 + MIN), resetsAt: iso(T0 + 2 * MIN) }),
      ],
    },
    {
      label: 'same-window longer replacement', profile: 'glm', provider: 'zai', events: [
        event({ resetsAt: iso(T0 + MIN) }),
        event({ at: iso(T0 + 30 * MIN), resetsAt: iso(T0 + 5 * HOUR) }),
      ],
    },
    {
      label: 'a model-scoped own event plus a provider-scoped sibling', profile: 'opus', provider: 'claude', events: [
        event({ profileId: 'opus', providerId: 'claude', window: 'seven_day_opus', resetsAt: iso(T0 + 3 * DAY) }),
        event({ profileId: 'sonnet', providerId: 'claude', window: 'five_hour', at: iso(T0 + HOUR), resetsAt: iso(T0 + 3 * HOUR) }),
      ],
    },
    {
      label: 'a null window plus a named window', profile: 'glm', provider: 'zai', events: [
        event({ resetsAt: iso(T0 + HOUR) }),
        event({ profileId: 'glm-flash', providerId: 'zai', window: 'five_hour', at: iso(T0 + 30 * MIN), resetsAt: iso(T0 + 3 * HOUR) }),
      ],
    },
    { label: 'no reset cools one hour', profile: 'glm', provider: 'zai', events: [event({})] },
    {
      label: 'an event older than the read window', profile: 'glm', provider: 'zai', events: [
        event({ at: iso(T0 - 25 * HOUR), resetsAt: iso(T0 - 24 * HOUR + 30 * MIN) }),
      ],
    },
    {
      label: 'retried attempts never cool', profile: 'glm', provider: 'zai', events: [
        event({ final: false, resetsAt: iso(T0 + 5 * HOUR) }),
        event({ at: iso(T0 + HOUR), resetsAt: iso(T0 + 2 * HOUR) }),
      ],
    },
  ]

  test('every minute and every boundary instant agree with cooldownFor', () => {
    for (const set of SETS) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-timeline-equiv-'))
      try {
        const db = schemaDb(path.join(dir, 'db.sqlite'))
        // Sampling starts at the earliest `at`: an event cannot reach the
        // router before it is recorded. Points move forward in time, so each
        // event is inserted as the clock passes its `at` — the router only
        // ever sees what has been recorded by t.
        const points = new Set<number>()
        let lo = Infinity
        let hi = -Infinity
        for (const entry of set.events) {
          const at = Date.parse(entry.at)
          lo = Math.min(lo, at)
          hi = Math.max(hi, at + DAY + MIN, entry.resetsAt ? Date.parse(entry.resetsAt) + MIN : 0)
          points.add(at + 1)
          points.add(entry.resetsAt ? Date.parse(entry.resetsAt) + 1 : at + DEFAULT_COOLDOWN_MS + 1)
          points.add(at + DAY + 1)
        }
        for (let t = lo; t <= hi; t += MIN) points.add(t)
        const ordered = [...set.events].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
        const insert = db.prepare(`INSERT INTO profile_limit_events
          (id, profile_id, session_id, group_id, at, kind, final, status, message, resets_at, provider_id, limit_window)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        let clock = lo
        const store = new LimitEventStore(db, () => clock)
        let known = 0
        for (const t of [...points].sort((a, b) => a - b)) {
          clock = t
          while (known < ordered.length && Date.parse(ordered[known]!.at) <= t) {
            const entry = ordered[known++]!
            insert.run(entry.id, entry.profileId, entry.sessionId, entry.groupId, entry.at, entry.kind,
              entry.final ? 1 : 0, entry.status, entry.message, entry.resetsAt, entry.providerId, entry.window)
          }
          const timeline = coolingTimeline(relevantEvents(ordered.slice(0, known), set.profile, set.provider))
          const inside = timeline.some(interval => interval.start <= t && t < interval.end)
          const effective = store.cooldownFor(set.profile, set.provider).until !== null
          expect({ set: set.label, t, inside }).toEqual({ set: set.label, t, inside: effective })
        }
        db.close()
      } finally {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    }
  }, 30_000)
})

describe('cooldownFor', () => {
  let dir: string
  let file: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-cooldownfor-'))
    file = path.join(dir, 'db.sqlite')
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  test('the shipped glm and glm-flash of zai cool together from one event', () => {
    const store = new LimitEventStore(schemaDb(file), () => T0)
    store.record({ ...base, final: true, providerId: 'zai', resetsAt: iso(T0 + 3 * 3_600_000) })
    expect(store.cooldownFor('glm', 'zai')).toEqual({ until: iso(T0 + 3 * 3_600_000), provider: true, providerId: 'zai' })
    expect(store.cooldownFor('glm-flash', 'zai')).toEqual({ until: iso(T0 + 3 * 3_600_000), provider: true, providerId: 'zai' })
    expect(store.cooldownFor('claude', 'claude')).toEqual({ until: null, provider: false, providerId: 'claude' })
  })

  test('a model-scoped own event decides; the provider flag stays false', () => {
    const HOUR = 3_600_000
    const DAY = 24 * HOUR
    const store = new LimitEventStore(schemaDb(file), () => T0)
    store.record({ ...base, final: true, providerId: 'zai', resetsAt: iso(T0 + HOUR) })
    store.record({ ...base, profileId: 'opus', final: true, providerId: 'claude', window: 'seven_day_opus', resetsAt: iso(T0 + 3 * DAY) })
    expect(store.cooldownFor('opus', 'claude')).toEqual({ until: iso(T0 + 3 * DAY), provider: false, providerId: 'claude' })
    expect(store.cooldownFor('sonnet', 'claude')).toEqual({ until: null, provider: false, providerId: 'claude' })
    expect(store.cooldownFor('glm', 'zai')).toEqual({ until: iso(T0 + HOUR), provider: true, providerId: 'zai' })
    // forProvider reads across the provider's profiles.
    expect(store.forProvider('zai').map(event => event.profileId)).toEqual(['glm'])
    expect(store.forProvider('claude').map(event => event.profileId)).toEqual(['opus'])
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
    // The read cutoff is inclusive (`at >= t - 24 h`), so the event still
    // decides at exactly `at + 24 h` — the interval runs 1 ms past it.
    expect(intervals).toEqual([{ start: T0, end: T0 + 24 * HOUR + 1 }])
    expect(coolingMsWithin(intervals, T0 + 20 * HOUR, T0 + 48 * HOUR)).toBe(4 * HOUR + 1)
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
        expect({ t, inside }).toEqual({ t, inside: cooldownUntil('glm', null, visible, t) !== null })
      }
    }
  })
})
