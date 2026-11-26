// Quota incident episodes (process-quota-history-and-incident-advice D4/D5,
// R5; decision-059a92d4): the pure rules the live path and reconstruction
// share — chaining by own ends, ties in commit order, the episode that holds
// a key event, the admission boundary at a recorded resolution, the in-force
// predicate over every member, and the router's cooldown as of a time
// (`LimitEventStore.cooldownAt`, I5).
import { afterEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { episodeFrom, episodeInForce, eventEnd, quotaEpisodes, type EpisodeEvent } from '../chat/quota/adviceEpisodes'
import { CREDIT_LIMIT_WINDOW } from '../chat/limitSignals'
import type { SessionDatabase } from '../db'
import { LimitEventStore } from '../team/routing/limitEvents'
import { freshTestDatabase } from './helpers/testDatabase'

const T0 = Date.parse('2026-06-01T12:00:00.000Z')
const MIN = 60_000
const ev = (id: string, at: number, reset: number | null): EpisodeEvent & { profile: string } =>
  ({ id, at: new Date(T0 + at * MIN).toISOString(), resetsAt: reset === null ? null : new Date(T0 + reset * MIN).toISOString(), profile: id })

describe('quota episodes', () => {
  test('an event without a reset ends one hour after it', () => {
    expect(eventEnd(ev('a', 0, null))).toBe(T0 + 60 * MIN)
  })

  test('events at the same instant keep their commit order, whatever their ids', () => {
    const [episode] = quotaEpisodes([ev('zz', 0, 30), ev('aa', 0, 20)])
    expect(episode!.events.map(event => event.id)).toEqual(['zz', 'aa'])
  })

  test('the episode a tied event opened is found whichever event at its instant leads', () => {
    const episode = episodeFrom([ev('aa', 0, 20), ev('zz', 0, 30), ev('mm', 10, 40)], 'zz')
    expect(episode?.events.map(event => event.id)).toEqual(['aa', 'zz', 'mm'])
    expect(episode?.end).toBe(T0 + 40 * MIN)
    expect(episodeFrom([ev('aa', 0, 20)], 'gone')).toBeNull()
  })

  test('a member joins while the episode\'s own end so far is ahead; at its end a new episode opens', () => {
    expect(quotaEpisodes([ev('a', 0, 10), ev('b', 5, 20), ev('c', 20, 30)]).map(entry => entry.events.map(event => event.id))).toEqual([['a', 'b'], ['c']])
  })

  test('a recorded resolution closes admission: a later event inside the own end opens a new episode', () => {
    const events = [ev('a', 0, 60), ev('b', 1, 2), ev('c', 4, 80)]
    const closed = (id: string) => (id === 'a' ? T0 + 3 * MIN : null)
    expect(quotaEpisodes(events, closed).map(entry => entry.events.map(event => event.id))).toEqual([['a', 'b'], ['c']])
    expect(quotaEpisodes(events).map(entry => entry.events.map(event => event.id))).toEqual([['a', 'b', 'c']])
    expect(episodeFrom(events, 'a', closed)?.events.map(event => event.id)).toEqual(['a', 'b'])
  })

  test('an event at the resolution\'s recorded instant counts as after it', () => {
    const events = [ev('a', 0, 60), ev('b', 3, 70)]
    expect(quotaEpisodes(events, id => (id === 'a' ? T0 + 3 * MIN : null)).map(entry => entry.events.map(event => event.id))).toEqual([['a'], ['b']])
  })

  test('a tied leader before the anchor still closes at the anchor\'s resolution', () => {
    const events = [ev('aa', 0, 60), ev('zz', 0, 60), ev('mm', 10, 70)]
    const closed = (id: string) => (id === 'zz' ? T0 + 5 * MIN : null)
    expect(episodeFrom(events, 'zz', closed)?.events.map(event => event.id)).toEqual(['aa', 'zz'])
  })
})

describe('episodeInForce', () => {
  const cooling = (profiles: string[]) => (member: { profile: string }) => profiles.includes(member.profile)
  const members = [ev('opus', 0, 60), ev('sonnet', 1, 2)]

  test('in force while an earlier member is ahead and cooling, the newest expired', () => {
    expect(episodeInForce(members, T0 + 3 * MIN, cooling(['opus']))).toBe(true)
  })

  test('in force while a later member is ahead and cooling, the first expired', () => {
    expect(episodeInForce([ev('sonnet', 0, 2), ev('opus', 1, 60)], T0 + 3 * MIN, cooling(['opus']))).toBe(true)
  })

  test('a member whose own end passed does not hold the episode, even while its profile still cools', () => {
    expect(episodeInForce(members, T0 + 3 * MIN, cooling(['sonnet']))).toBe(false)
  })

  test('a member ahead whose profile cooldown ended early does not hold the episode', () => {
    expect(episodeInForce(members, T0 + 3 * MIN, cooling([]))).toBe(false)
  })

  test('the cooldown is asked at the time in question', () => {
    const asked: number[] = []
    episodeInForce(members, T0 + MIN, (_member, at) => { asked.push(at); return false })
    expect(asked).toEqual([T0 + MIN, T0 + MIN])
  })
})

describe('LimitEventStore.cooldownAt', () => {
  let root: string | null = null
  let db: SessionDatabase | null = null
  afterEach(() => {
    db?.close()
    if (root) fs.rmSync(root, { recursive: true, force: true })
    root = null
    db = null
  })
  const open = () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-cooldown-at-')))
    db = freshTestDatabase(path.join(root, 'test.db'))
    return db
  }
  const clock = { now: T0 }
  const iso = (minutes: number) => new Date(T0 + minutes * MIN).toISOString()
  const record = (store: LimitEventStore, profileId: string, at: number, reset: number | null, window: string, providerId = 'anthropic') =>
    store.record({ profileId, sessionId: 's1', groupId: null, kind: 'rate_limit', final: true, status: 429, message: null,
      resetsAt: reset === null ? null : iso(reset), providerId, window, at: iso(at) })

  test('a cooldown that ended by now still ran at an earlier time; a limit after the time does not cool it', () => {
    clock.now = T0 + 3 * MIN
    const store = new LimitEventStore(open().db, () => clock.now)
    record(store, 'sonnet', 0, 2, 'seven_day_sonnet')
    expect(store.cooldownFor('sonnet', 'anthropic').until).toBeNull()
    expect(store.cooldownAt('sonnet', 'anthropic', T0 + MIN)).toBe(iso(2))
    expect(store.cooldownAt('sonnet', 'anthropic', T0 + 2 * MIN)).toBeNull()
    expect(store.cooldownAt('sonnet', 'anthropic', T0 - MIN)).toBeNull()
  })

  test('a later same-window limit supersedes only from its own time', () => {
    clock.now = T0 + 3 * MIN
    const store = new LimitEventStore(open().db, () => clock.now)
    record(store, 'glm', 0, 60, 'five_hour', 'zai')
    record(store, 'glm', 1, 2, 'five_hour', 'zai')
    expect(store.cooldownAt('glm', 'zai', T0 + 30 * 1000)).toBe(iso(60))
    expect(store.cooldownAt('glm', 'zai', T0 + 90 * 1000)).toBe(iso(2))
    expect(store.cooldownAt('glm', 'zai', T0 + 3 * MIN)).toBeNull()
  })

  test('another profile\'s model-scoped limit does not cool it; a provider-scoped one does', () => {
    clock.now = T0 + 40 * MIN
    const store = new LimitEventStore(open().db, () => clock.now)
    record(store, 'opus', 0, 60, 'seven_day_opus')
    record(store, 'haiku', 0, 30, 'five_hour')
    expect(store.cooldownAt('sonnet', 'anthropic', T0 + 10 * MIN)).toBe(iso(30))
    expect(store.cooldownAt('sonnet', 'anthropic', T0 + 40 * MIN)).toBeNull()
  })

  test('a credit return ends the cooldown only from the reading that showed it, and only for an event this process recorded', () => {
    clock.now = T0
    const database = open()
    const store = new LimitEventStore(database.db, () => clock.now)
    record(store, 'or', 0, null, CREDIT_LIMIT_WINDOW, 'openrouter')
    clock.now = T0 + MIN
    store.reportRemainingCredit('openrouter', 0)
    clock.now = T0 + 2 * MIN
    store.reportRemainingCredit('openrouter', 10)
    const rows = () => database.db.prepare('SELECT COUNT(*) AS n FROM profile_limit_events').get()
    const before = rows()
    // The current-time API is unchanged: credit returned, nothing cools now.
    expect(store.cooldownFor('or', 'openrouter').until).toBeNull()
    expect(store.cooldownAt('or', 'openrouter', T0)).toBe(iso(60))
    expect(store.cooldownAt('or', 'openrouter', T0 + MIN)).toBe(iso(60))
    expect(store.cooldownAt('or', 'openrouter', T0 + 2 * MIN)).toBeNull()
    expect(rows()).toEqual(before)
    // After a restart the event is untracked: it ends at its one-hour bound, now and at any past time.
    const restarted = new LimitEventStore(database.db, () => clock.now)
    restarted.reportRemainingCredit('openrouter', 20)
    expect(restarted.cooldownFor('or', 'openrouter').until).toBe(iso(60))
    expect(restarted.cooldownAt('or', 'openrouter', T0 + 2 * MIN)).toBe(iso(60))
  })
})
