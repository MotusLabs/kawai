// Table R row R5 at an episode's boundaries (process-quota-history-and-
// incident-advice D5, I5; contract r3 V6 and V8) through the production
// ManagerAdvice, coalescing queue, evaluator, durable recommendations and the
// real LimitEventStore: a recorded resolution closes the episode, so a
// restart never repartitions a consumed episode, and every assessment reads
// the router's cooldown — credit overlay included — as of its own cutoff.
import { afterEach, describe, expect, test } from 'bun:test'
import { CREDIT_LIMIT_WINDOW } from '../chat/limitSignals'
import { adviceHarness, MIN, recommendations, T0, TEAM, type AdviceHarness } from './helpers/adviceHarness'

let h!: AdviceHarness
let extra: AdviceHarness[] = []
afterEach(() => {
  for (const harness of [...extra.reverse(), h]) harness?.close()
  extra = []
  h = undefined as unknown as AdviceHarness
})

const iso = (minutes: number) => new Date(T0 + minutes * MIN).toISOString()

function team(): void {
  h.workers = [{ model: 'glm', provider: 'zai', live: 1 }, { model: 'kimi', provider: 'moon' }, { model: 'or', provider: 'openrouter' }]
  h.scopes = { glm: 'scope-zai', kimi: 'scope-moon', or: 'scope-or' }
  h.observe('kimi', 'moon', T0 - MIN)
}

/** A restart over the same database: a new ManagerAdvice and LimitEventStore with the same fixtures. */
function restart(): AdviceHarness {
  h.advice.shutdown()
  const next = adviceHarness({ db: h.db })
  Object.assign(next, { workers: h.workers, scopes: h.scopes, records: h.records })
  next.clock.now = h.clock.now
  extra.push(h)
  h = next
  return next
}

/** Boot: startup reconstruction and reconciliation, then the queue twice (a late first assessment enqueues its next version). */
function boot(): void {
  restart()
  h.advice.start()
  h.drain()
  h.drain()
}

const limitIds = () => (h.db.db.prepare('SELECT id FROM profile_limit_events ORDER BY at, rowid').all() as Array<{ id: string }>).map(row => row.id)
const frozen = (rec: ReturnType<typeof recommendations>[number]) =>
  rec.assessments.map(({ id, version, cutoff, state, evidenceHash, advice, createdAt }) => ({ id, version, cutoff, state, evidenceHash, advice, createdAt }))

describe('R5 episode boundaries', () => {
  test('R5: a restart after a resolved episode and a crash-gap limit anchors advice at the episode and the new limit only', () => {
    h = adviceHarness()
    team()
    // A at 12:00 (reset 13:00) and B at 12:01 (reset 12:02), same team, profile and window, each drained.
    h.limit({ resetsAt: iso(60) })
    h.drain()
    h.clock.now = T0 + MIN
    h.limit({ resetsAt: iso(2) })
    h.drain()
    // 12:03: B superseded the window and it ended; the episode resolves.
    h.clock.now = T0 + 3 * MIN
    h.advice.historyWritten([TEAM])
    h.drain()
    const [a, b] = limitIds()
    const resolved = recommendations(h)
    expect(resolved.map(rec => rec.episodeKey)).toEqual([`quota:zai:${a}`])
    expect(resolved[0]!.assessments.at(-1)!.state).toBe('resolved')
    expect(h.advice.members(resolved[0]!.id)).toEqual([a, b])
    const aFrozen = frozen(resolved[0]!)

    // The advice subscriber stops (a crash); C commits at 12:04 (reset 13:20).
    h.advice.shutdown()
    h.clock.now = T0 + 4 * MIN
    h.limit({ resetsAt: iso(80) })
    const c = limitIds()[2]!

    h.clock.now = T0 + 5 * MIN
    boot()
    const recs = recommendations(h)
    expect(recs.map(rec => rec.episodeKey)).toEqual([`quota:zai:${a}`, `quota:zai:${c}`])
    expect(recs[0]).toMatchObject({ id: resolved[0]!.id, cutoff: iso(0), snapshotBasis: 'incident' })
    expect(frozen(recs[0]!)).toEqual(aFrozen)
    expect(recs[1]).toMatchObject({ cutoff: iso(4), snapshotBasis: 'reconstructed' })
    expect(recs[1]!.assessments[0]!.cutoff).toBe(iso(4))
    expect(recs[1]!.assessments.at(-1)!.state).not.toBe('resolved')
    expect(h.advice.members(recs[0]!.id)).toEqual([a, b])
    expect(h.advice.members(recs[1]!.id)).toEqual([c])

    // A second restart adds nothing.
    boot()
    const again = recommendations(h)
    expect(again.map(rec => rec.id)).toEqual(recs.map(rec => rec.id))
    expect(again.map(frozen)).toEqual(recs.map(frozen))
  })

  test('R5: an assessment made after a credit return reads the router cooldown at its own cutoff, first new then resolved', () => {
    // The oracle: the same incident drained at its own cutoff, before any credit reading.
    h = adviceHarness()
    team()
    h.limit({ profileId: 'or', providerId: 'openrouter', window: CREDIT_LIMIT_WINDOW, resetsAt: null })
    h.drain()
    const control = recommendations(h)[0]!.assessments
    expect(control).toHaveLength(1)
    extra.push(h)

    h = adviceHarness()
    team()
    // A final OpenRouter credit limit at 12:00 with no reset; readings 0 at 12:01 and 10 at 12:02 before any drain.
    h.limit({ profileId: 'or', providerId: 'openrouter', window: CREDIT_LIMIT_WINDOW, resetsAt: null })
    h.clock.now = T0 + MIN
    h.limits.reportRemainingCredit('openrouter', 0)
    h.clock.now = T0 + 2 * MIN
    h.limits.reportRemainingCredit('openrouter', 10)
    expect(h.limits.cooldownFor('or', 'openrouter').until).toBeNull()
    expect(h.limits.cooldownAt('or', 'openrouter', T0)).toBe(iso(60))

    h.drain()
    const first = recommendations(h)[0]!
    expect(first.assessments).toHaveLength(1)
    const v1 = first.assessments[0]!
    expect(v1).toMatchObject({ version: 1, state: 'new', cutoff: iso(0) })
    // Observation ids differ between the two databases; the advice is otherwise the same.
    const withoutIds = (advice: unknown) => JSON.parse(JSON.stringify(advice).replace(/"observationId":"[^"]*"/g, '"observationId":"-"')) as unknown
    expect(withoutIds(v1.advice)).toEqual(withoutIds(control[0]!.advice))

    h.drain()
    const after = recommendations(h)[0]!
    expect(after.assessments.map(({ version, state, cutoff }) => ({ version, state, cutoff })))
      .toEqual([{ version: 1, state: 'new', cutoff: iso(0) }, { version: 2, state: 'resolved', cutoff: iso(2) }])
    expect(frozen(after)[0]).toEqual(frozen(first)[0])
  })
})
