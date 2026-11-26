// Table R row R5 across member scopes (process-quota-history-and-incident-
// advice D5; decision-059a92d4) through the production ManagerAdvice, queue,
// evaluator and stores: one episode's members can hold different
// model-scoped windows, each its own profile cooldown, and the episode stays
// in force — live and on reconstruction alike — while some member's own end
// is ahead and its cooldown still runs.
import { afterEach, describe, expect, test } from 'bun:test'
import { adviceHarness, MIN, recommendations, T0, TEAM, type AdviceHarness } from './helpers/adviceHarness'

let h!: AdviceHarness
let extra: AdviceHarness[] = []
afterEach(() => {
  for (const harness of [...extra.reverse(), h]) harness?.close()
  extra = []
  h = undefined as unknown as AdviceHarness
})

function team(): void {
  h.workers = [{ model: 'glm', provider: 'zai', live: 1 }, { model: 'kimi', provider: 'moon' }]
  h.scopes = { glm: 'scope-zai', kimi: 'scope-moon' }
}

/** A restart over the same database: a new ManagerAdvice with the same fixtures. */
function restart(): AdviceHarness {
  h.advice.shutdown()
  const next = adviceHarness({ db: h.db })
  Object.assign(next, { workers: h.workers, scopes: h.scopes, records: h.records })
  next.clock.now = h.clock.now
  extra.push(h)
  h = next
  return next
}

describe('R5 episodes across member scopes', () => {
  const OPUS = { profileId: 'opus', providerId: 'anthropic', window: 'seven_day_opus' }
  const SONNET = { profileId: 'sonnet', providerId: 'anthropic', window: 'seven_day_sonnet' }
  const scoped = () => {
    h = adviceHarness()
    team()
    h.workers = [...h.workers, { model: 'opus', provider: 'anthropic' }, { model: 'sonnet', provider: 'anthropic' }]
    h.observe('kimi', 'moon', T0 - MIN)
  }
  const ids = () => (h.db.db.prepare('SELECT id FROM profile_limit_events ORDER BY at, id').all() as Array<{ id: string }>).map(row => row.id)

  /** Scoped final limits ([scope, offset from T0 in minutes, reset offset]) recorded with no subscriber, then two restarts at `restartAt`. */
  const crash = (limits: Array<[typeof OPUS, number, number]>, restartAt: number) => {
    scoped()
    h.advice.shutdown()
    for (const [scope, at, reset] of limits) {
      h.clock.now = T0 + at * MIN
      h.limit({ ...scope, resetsAt: new Date(T0 + reset * MIN).toISOString() })
    }
    h.clock.now = T0 + restartAt * MIN
    for (let boot = 0; boot < 2; boot++) {
      restart()
      h.advice.start()
      h.drain()
    }
    return recommendations(h)
  }

  test('R5: a crash after mixed-scope limits reconstructs the episode while an earlier member still cools', () => {
    // The reviewer's probe: Opus 12:00 (reset 13:00), Sonnet 12:01 (reset 12:02), restart at 12:03.
    const recs = crash([[OPUS, 0, 60], [SONNET, 1, 2]], 3)
    expect(h.limits.cooldownFor('sonnet', 'anthropic').until).toBeNull()
    expect(recs).toHaveLength(1)
    expect(recs[0]).toMatchObject({ episodeKey: `quota:anthropic:${ids()[0]}`, profileId: 'opus', cutoff: new Date(T0).toISOString(), snapshotBasis: 'reconstructed' })
    expect(recs[0]!.assessments.map(assessment => assessment.version)).toEqual([1, 2])
    expect(recs[0]!.assessments.at(-1)!.state).not.toBe('resolved')
  })

  test('R5: a crash after mixed-scope limits whose earlier member expired reconstructs the coalesced episode from its first event', () => {
    // The mirror: Sonnet 12:00 (reset 12:02), Opus 12:01 (reset 13:00), restart at 12:03.
    const recs = crash([[SONNET, 0, 2], [OPUS, 1, 60]], 3)
    expect(h.limits.cooldownFor('sonnet', 'anthropic').until).toBeNull()
    expect(recs).toHaveLength(1)
    expect(recs[0]).toMatchObject({ episodeKey: `quota:anthropic:${ids()[0]}`, profileId: 'sonnet', cutoff: new Date(T0).toISOString(), snapshotBasis: 'reconstructed' })
    expect(recs[0]!.assessments.at(-1)!.state).not.toBe('resolved')
  })

  test('R5: a crash after final limits at the same instant keys the reconstructed episode by the one committed first', () => {
    scoped()
    h.advice.shutdown()
    h.limit({ ...OPUS, resetsAt: new Date(T0 + 60 * MIN).toISOString() })
    h.limit({ ...SONNET, resetsAt: new Date(T0 + 30 * MIN).toISOString() })
    // Ids that sort against commit order.
    h.db.db.prepare(`UPDATE profile_limit_events SET id = CASE profile_id WHEN 'opus' THEN 'zz-first' ELSE 'aa-second' END`).run()
    h.clock.now = T0 + 10 * MIN
    for (let boot = 0; boot < 2; boot++) {
      restart()
      h.advice.start()
      h.drain()
    }
    const recs = recommendations(h)
    expect(recs).toHaveLength(1)
    expect(recs[0]).toMatchObject({ episodeKey: 'quota:anthropic:zz-first', profileId: 'opus', cutoff: new Date(T0).toISOString() })
    expect(recs[0]!.assessments.at(-1)!.state).not.toBe('resolved')
  })

  test('R5: live, an episode whose first member stopped cooling stays open while a later member cools, and restart adds none', () => {
    scoped()
    h.limit({ ...SONNET, resetsAt: new Date(T0 + 2 * MIN).toISOString() })
    h.drain()
    h.clock.now = T0 + MIN
    h.limit({ ...OPUS, resetsAt: new Date(T0 + 60 * MIN).toISOString() })
    h.drain()
    h.clock.now = T0 + 3 * MIN
    h.advice.historyWritten([TEAM])
    h.drain()
    const live = recommendations(h)
    expect(live.map(rec => rec.episodeKey)).toEqual([`quota:anthropic:${ids()[0]}`])
    expect(live[0]!.assessments.at(-1)!.state).not.toBe('resolved')
    restart()
    h.advice.start()
    h.drain()
    expect(recommendations(h).map(rec => rec.episodeKey)).toEqual(live.map(rec => rec.episodeKey))
    // Once every member's cooldown ended, the episode resolves.
    h.clock.now = T0 + 61 * MIN
    h.advice.historyWritten([TEAM])
    h.drain()
    expect(recommendations(h)[0]!.assessments.at(-1)!.state).toBe('resolved')
  })
})
