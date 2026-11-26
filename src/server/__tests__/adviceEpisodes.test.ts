// Quota incident episodes (process-quota-history-and-incident-advice D4/D5,
// R5; decision-059a92d4): the pure rules the live path and reconstruction
// share — chaining by own ends, ties in commit order, the episode that holds
// a key event, the in-force predicate over every member, and the router's
// cooldown as of a time.
import { describe, expect, test } from 'bun:test'
import type { LimitEvent } from '../../shared/routing'
import { episodeFrom, episodeInForce, eventEnd, quotaEpisodes, type EpisodeEvent } from '../chat/quota/adviceEpisodes'
import { routerCoolsAt, type ManagerAdviceDeps } from '../chat/quota/managerAdvice'

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

describe('routerCoolsAt', () => {
  const limit = (profileId: string, at: number, reset: number, window = 'seven_day_opus'): LimitEvent => ({
    id: `${profileId}-${at}`, profileId, sessionId: 's1', groupId: null, at: new Date(T0 + at * MIN).toISOString(), kind: 'rate_limit', final: true,
    status: 429, message: null, resetsAt: new Date(T0 + reset * MIN).toISOString(), providerId: 'anthropic', window,
  })
  const limits = (events: LimitEvent[], until: (profileId: string) => string | null): ManagerAdviceDeps['limits'] => ({
    subscribe: () => () => {},
    forProfile: profileId => events.filter(event => event.profileId === profileId),
    forProvider: providerId => events.filter(event => event.providerId === providerId),
    cooldownFor: profileId => ({ until: until(profileId) }),
  })
  const sonnet = [limit('sonnet', 0, 2, 'seven_day_sonnet')]

  test('a cooldown that ended by now still ran at an earlier time', () => {
    const store = limits(sonnet, () => null)
    expect(routerCoolsAt(store, 'sonnet', 'anthropic', T0 + MIN, T0 + 3 * MIN)).toBe(true)
    expect(routerCoolsAt(store, 'sonnet', 'anthropic', T0 + 2 * MIN, T0 + 3 * MIN)).toBe(false)
  })

  test('a limit committed after the time does not cool it', () => {
    expect(routerCoolsAt(limits(sonnet, () => null), 'sonnet', 'anthropic', T0 - MIN, T0 + MIN)).toBe(false)
  })

  test('a cooldown the router ended early (credit returned) counts as ended at every time', () => {
    const opus = [limit('opus', 0, 60)]
    expect(routerCoolsAt(limits(opus, () => null), 'opus', 'anthropic', T0 + MIN, T0 + 3 * MIN)).toBe(false)
    expect(routerCoolsAt(limits(opus, () => new Date(T0 + 60 * MIN).toISOString()), 'opus', 'anthropic', T0 + MIN, T0 + 3 * MIN)).toBe(true)
  })

  test('another profile\'s model-scoped limit does not cool it; a provider-scoped one does', () => {
    const events = [limit('opus', 0, 60), limit('haiku', 0, 30, 'five_hour')]
    const store = limits(events, () => new Date(T0 + 60 * MIN).toISOString())
    expect(routerCoolsAt(store, 'sonnet', 'anthropic', T0 + 10 * MIN, T0 + 10 * MIN)).toBe(true)
    expect(routerCoolsAt(store, 'sonnet', 'anthropic', T0 + 40 * MIN, T0 + 40 * MIN)).toBe(false)
  })
})
