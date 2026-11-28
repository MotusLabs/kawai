// Table R row R5 at a recorded closure (process-quota-history-and-incident-
// advice D5; contract r3 V6/V7, findings F1 round 2) through the production
// ManagerAdvice, coalescing queue, evaluator, durable recommendations and the
// real LimitEventStore. The first `resolved` version of a quota episode
// closes it together with its membership witness — the limit events the
// episode held when it closed — so a restart honors that closure before any
// provider-wide cooldown (another team's limit keeps the profile cooling but
// never reopens it) and keeps both orders of a commit and a drain at the same
// millisecond: a limit committed before the closing drain stays a member, one
// committed after it anchors its own episode.
import { afterEach, describe, expect, test } from 'bun:test'
import { adviceHarness, MIN, recommendations, T0, TEAM, type AdviceHarness } from './helpers/adviceHarness'

const OTHER = 'team-b'
let open: AdviceHarness[] = []
afterEach(() => {
  for (const harness of open.reverse()) harness.close()
  open = []
})

const iso = (time: number) => new Date(time).toISOString()
const DAY = 24 * 60 * MIN

/** A harness where session `foreign` (project /other/team) belongs to team B and s1 to team A. */
function harness(db?: AdviceHarness['db']): AdviceHarness {
  const h = adviceHarness({ ...(db ? { db } : {}), teamOf: id => (id === 'foreign' ? OTHER : id === 's1' ? TEAM : null) })
  h.workers = [{ model: 'glm', provider: 'zai', live: 1 }]
  h.records.set('foreign', { ...h.records.get('s1')!, sessionId: 'foreign', projectPath: '/other/team' })
  open.push(h)
  return h
}

/** Restart over the same database at `at`: startup reconstruction and reconciliation, then the queue twice. */
function boot(previous: AdviceHarness, at: number): AdviceHarness {
  previous.advice.shutdown()
  const h = harness(previous.db)
  h.clock.now = at
  h.advice.start()
  h.drain()
  h.drain()
  return h
}

const limitIds = (h: AdviceHarness) => (h.db.db.prepare('SELECT id FROM profile_limit_events ORDER BY rowid').all() as Array<{ id: string }>).map(row => row.id)
const teamRecs = (h: AdviceHarness, teamId: string) => h.advice.store.list(teamId, 200).reverse().map(rec => h.advice.store.get(teamId, rec.id)!)
const anchors = (h: AdviceHarness, teamId: string, names: Record<string, string>) =>
  teamRecs(h, teamId).map(rec => names[rec.episodeKey.slice('quota:zai:'.length)] ?? rec.episodeKey)
const membersOf = (h: AdviceHarness, teamId: string, names: Record<string, string>) =>
  teamRecs(h, teamId).map(rec => (h.advice.members(rec.id) ?? []).map(id => names[id] ?? id))
const frozen = (h: AdviceHarness, teamId: string) =>
  teamRecs(h, teamId).map(rec => rec.assessments.map(({ id, version, cutoff, state, evidenceHash, createdAt }) => ({ id, version, cutoff, state, evidenceHash, createdAt })))

describe('R5 closure witness', () => {
  test('R5: another team\'s later limit keeps the profile cooling but never reopens a closed episode on restart', () => {
    const h = harness()
    // Team A: A at 12:00 (reset 13:00) and B at 12:01 (reset 12:02), each drained; at 12:03 the episode resolves.
    h.limit({ resetsAt: iso(T0 + 60 * MIN) })
    h.drain()
    h.clock.now = T0 + MIN
    h.limit({ resetsAt: iso(T0 + 2 * MIN) })
    h.drain()
    h.clock.now = T0 + 3 * MIN
    h.advice.historyWritten([TEAM])
    h.drain()
    const [a, b] = limitIds(h)
    const names = { [a!]: 'A', [b!]: 'B' }
    expect(anchors(h, TEAM, names)).toEqual(['A'])
    expect(teamRecs(h, TEAM)[0]!.assessments.at(-1)!.state).toBe('resolved')
    expect(membersOf(h, TEAM, names)).toEqual([['A', 'B']])
    const versions = frozen(h, TEAM)
    // The advice subscriber stops; team B's C commits at 12:04 (reset 13:20) on the same provider, profile and window.
    h.advice.shutdown()
    h.clock.now = T0 + 4 * MIN
    h.limit({ sessionId: 'foreign', resetsAt: iso(T0 + 80 * MIN) })
    const c = limitIds(h)[2]!
    names[c] = 'C'

    const first = boot(h, T0 + 5 * MIN)
    // C keeps the profile cooling at the restart, yet team A's closed episode stays closed.
    expect(first.limits.cooldownAt('glm', 'zai', first.clock.now)).toBe(iso(T0 + 80 * MIN))
    expect(anchors(first, TEAM, names)).toEqual(['A'])
    expect(membersOf(first, TEAM, names)).toEqual([['A', 'B']])
    expect(frozen(first, TEAM)).toEqual(versions)
    expect(anchors(first, OTHER, names)).toEqual(['C'])
    expect(membersOf(first, OTHER, names)).toEqual([['C']])

    // A second restart adds nothing.
    const after = { team: frozen(first, TEAM), other: frozen(first, OTHER) }
    const second = boot(first, T0 + 5 * MIN)
    expect(anchors(second, TEAM, names)).toEqual(['A'])
    expect(membersOf(second, TEAM, names)).toEqual([['A', 'B']])
    expect({ team: frozen(second, TEAM), other: frozen(second, OTHER) }).toEqual(after)
  })

  test('R5: a limit committed before a same-millisecond closing drain stays a member; one committed after it anchors its own episode', () => {
    const h = harness()
    // A at 12:00 (reset 13:00); B at 12:02 with reset 12:02 joins A, then the drain at that same millisecond resolves it.
    h.limit({ resetsAt: iso(T0 + 60 * MIN) })
    h.drain()
    h.clock.now = T0 + 2 * MIN
    h.limit({ resetsAt: iso(T0 + 2 * MIN) })
    const [a, b] = limitIds(h)
    const names = { [a!]: 'A', [b!]: 'B' }
    expect(membersOf(h, TEAM, names)).toEqual([['A', 'B']])
    h.drain()
    expect(recommendations(h)[0]!.assessments.at(-1)).toMatchObject({ state: 'resolved', createdAt: iso(T0 + 2 * MIN) })
    // C at the same millisecond, after the closing drain: its own episode.
    h.limit({ resetsAt: iso(T0 + 80 * MIN) })
    h.drain()
    names[limitIds(h)[2]!] = 'C'
    const live = { anchors: anchors(h, TEAM, names), members: membersOf(h, TEAM, names) }
    expect(live).toEqual({ anchors: ['A', 'C'], members: [['A', 'B'], ['C']] })
    const versions = frozen(h, TEAM)

    const first = boot(h, T0 + 3 * MIN)
    expect({ anchors: anchors(first, TEAM, names), members: membersOf(first, TEAM, names) }).toEqual(live)
    expect(frozen(first, TEAM).slice(0, 1)).toEqual(versions.slice(0, 1))
    const after = frozen(first, TEAM)
    const second = boot(first, T0 + 3 * MIN)
    expect({ anchors: anchors(second, TEAM, names), members: membersOf(second, TEAM, names) }).toEqual(live)
    expect(frozen(second, TEAM)).toEqual(after)
  })

  test('R5: a drain that closes an episode before a same-millisecond limit leaves that limit its own episode, across restarts', () => {
    const h = harness()
    // A at 12:00 with reset 12:02; the drain at 12:02 resolves it before B commits at that same millisecond.
    h.limit({ resetsAt: iso(T0 + 2 * MIN) })
    h.drain()
    h.clock.now = T0 + 2 * MIN
    h.advice.historyWritten([TEAM])
    h.drain()
    expect(recommendations(h)[0]!.assessments.at(-1)).toMatchObject({ state: 'resolved', createdAt: iso(T0 + 2 * MIN) })
    h.limit({ resetsAt: iso(T0 + 60 * MIN) })
    h.drain()
    const [a, b] = limitIds(h)
    const names = { [a!]: 'A', [b!]: 'B' }
    const live = { anchors: anchors(h, TEAM, names), members: membersOf(h, TEAM, names) }
    expect(live).toEqual({ anchors: ['A', 'B'], members: [['A'], ['B']] })

    const first = boot(h, T0 + 3 * MIN)
    expect({ anchors: anchors(first, TEAM, names), members: membersOf(first, TEAM, names) }).toEqual(live)
    const second = boot(first, T0 + 3 * MIN)
    expect({ anchors: anchors(second, TEAM, names), members: membersOf(second, TEAM, names) }).toEqual(live)
  })

  test('R5: an open episode whose anchor was pruned keeps its surviving members, live and across a restart', () => {
    const h = harness()
    // A at day 0 (seven-day window, reset day 20); B at day 15 joins it, and its commit prunes A (15-day retention).
    h.limit({ window: 'seven_day', resetsAt: iso(T0 + 20 * DAY) })
    h.drain()
    h.clock.now = T0 + 15 * DAY + 1_000
    h.limit({ window: 'seven_day', resetsAt: iso(T0 + 17 * DAY) })
    h.drain()
    const [b] = limitIds(h)
    expect(limitIds(h)).toHaveLength(1)
    const anchor = recommendations(h)[0]!.episodeKey.slice('quota:zai:'.length)
    const names = { [anchor]: 'A', [b!]: 'B' }
    expect(membersOf(h, TEAM, names)).toEqual([['A', 'B']])
    const first = boot(h, T0 + 15 * DAY + MIN)
    expect(anchors(first, TEAM, names)).toEqual(['A'])
    expect(membersOf(first, TEAM, names)).toEqual([['A', 'B']])
  })

  test('R5: a closure after its anchor was pruned records the surviving members, so a restart never replays them', () => {
    const h = harness()
    // A at day 0 (reset day 20); B at day 15 (reset day 17); D a minute later (reset two minutes later) supersedes the
    // window, and its commit prunes A. The drain at day 15 + 3 min resolves the episode while A and B are still ahead.
    h.limit({ window: 'seven_day', resetsAt: iso(T0 + 20 * DAY) })
    h.drain()
    h.clock.now = T0 + 15 * DAY
    h.limit({ window: 'seven_day', resetsAt: iso(T0 + 17 * DAY) })
    h.drain()
    h.clock.now = T0 + 15 * DAY + MIN
    h.limit({ window: 'seven_day', resetsAt: iso(T0 + 15 * DAY + 2 * MIN) })
    h.drain()
    const [b, d] = limitIds(h)
    expect(limitIds(h)).toHaveLength(2)
    const rec = recommendations(h)[0]!
    const names = { [rec.episodeKey.slice('quota:zai:'.length)]: 'A', [b!]: 'B', [d!]: 'D' }
    h.clock.now = T0 + 15 * DAY + 3 * MIN
    h.advice.historyWritten([TEAM])
    h.drain()
    expect(recommendations(h)[0]!.assessments.at(-1)!.state).toBe('resolved')
    const witness = (h.db.db.prepare('SELECT limit_event_id FROM process_episode_members WHERE recommendation_id = ? ORDER BY ordinal')
      .all(rec.id) as Array<{ limit_event_id: string }>).map(row => names[row.limit_event_id])
    expect(witness).toEqual(['A', 'B', 'D'])
    const versions = frozen(h, TEAM)
    // Team B's C keeps the profile cooling on the same window; the subscriber is stopped.
    h.advice.shutdown()
    h.clock.now = T0 + 15 * DAY + 4 * MIN
    h.limit({ sessionId: 'foreign', window: 'seven_day', resetsAt: iso(T0 + 20 * DAY) })
    names[limitIds(h)[2]!] = 'C'

    const first = boot(h, T0 + 15 * DAY + 5 * MIN)
    expect(anchors(first, TEAM, names)).toEqual(['A'])
    expect(membersOf(first, TEAM, names)).toEqual([['A', 'B', 'D']])
    expect(frozen(first, TEAM)).toEqual(versions)
    expect(anchors(first, OTHER, names)).toEqual(['C'])
  })

  test('R5: the closing version and its witness commit together, and the witness is immutable', () => {
    const h = harness()
    h.limit({ resetsAt: iso(T0 + 2 * MIN) })
    h.drain()
    h.clock.now = T0 + 2 * MIN
    h.advice.historyWritten([TEAM])
    h.drain()
    const rec = recommendations(h)[0]!
    const rows = h.db.db.prepare('SELECT limit_event_id FROM process_episode_members WHERE recommendation_id = ? ORDER BY ordinal').all(rec.id) as Array<{ limit_event_id: string }>
    expect(rows.map(row => row.limit_event_id)).toEqual(limitIds(h))
    expect(() => h.db.db.prepare('UPDATE process_episode_members SET limit_event_id = ?').run('x')).toThrow()
    expect(() => h.db.db.prepare('DELETE FROM process_episode_members').run()).toThrow()
    // Later versions add no witness rows.
    h.clock.now = T0 + 10 * MIN
    h.advice.historyWritten([TEAM])
    h.drain()
    expect((h.db.db.prepare('SELECT COUNT(*) AS n FROM process_episode_members').get() as { n: number }).n).toBe(1)
  })
})
