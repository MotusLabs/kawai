// Live advice equals restart reconstruction (process-quota-history-and-
// incident-advice D5, R5; contract r3 V7): seeded final limits of several
// profiles of one provider — model-scoped and provider-scoped windows, random
// resets — through the production ManagerAdvice, queue, evaluator, stores and
// the real LimitEventStore, with drains (and so recorded resolutions)
// interleaved between the commits. The reference processes every limit live;
// the crash run stops the advice subscriber before a seeded suffix of the
// limits, commits it, and restarts twice. After the restarts both hold the
// same recommendations for every limit seen live, with the same members and
// versions; the same open episodes, anchors, members and first cutoffs for
// the crash gap; each final limit belongs to at most one episode, and none
// joins an episode at or after its recorded resolution.
import { afterEach, expect, test } from 'bun:test'
import { propertyCases } from './helpers/propertyCases'
import { adviceHarness, MIN, T0, TEAM, recommendations, type AdviceHarness } from './helpers/adviceHarness'

const SEED = 0x5EED5
const CASES = 200
const PROFILES = [
  { profileId: 'opus', window: 'seven_day_opus' },
  { profileId: 'sonnet', window: 'seven_day_sonnet' },
  { profileId: 'haiku', window: 'five_hour' },
] as const

function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6D2B79F5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

interface Limit { profileId: string; window: string; at: number; resetsAt: number | null }
/** `drains[i]`: drain times after limit i and at or before limit i + 1 (a drain at a commit's instant runs first). */
interface Case { limits: Limit[]; drains: number[][]; crashAt: number; restartAt: number }

/**
 * The resolved-episode boundary family: A and a later B of one window (B's
 * shorter reset supersedes A's), a drain after B's reset that resolves the
 * episode while A's own end is still ahead, then the crash and a gap limit C
 * inside A's own end, with further limits after it.
 */
function drawBoundary(rng: () => number): Case {
  const pick = () => PROFILES[Math.floor(rng() * PROFILES.length)]!
  const profile = pick()
  const bAt = T0 + (1 + Math.floor(rng() * 3)) * MIN
  const bReset = bAt + (1 + Math.floor(rng() * 3)) * MIN
  const drainAt = bReset + Math.floor(rng() * 3) * MIN
  const limits: Limit[] = [
    { ...profile, at: T0, resetsAt: T0 + (30 + Math.floor(rng() * 60)) * MIN },
    { ...profile, at: bAt, resetsAt: bReset },
  ]
  let at = drainAt + Math.floor(rng() * 5) * MIN
  for (let n = 1 + Math.floor(rng() * 3); n > 0; n--) {
    limits.push({ ...pick(), at, resetsAt: rng() < 0.2 ? null : at + (1 + Math.floor(rng() * 90)) * MIN })
    at += Math.floor(rng() * 20) * MIN
  }
  const drains = limits.map((): number[] => [])
  drains[1] = [drainAt]
  return { limits, drains, crashAt: 2, restartAt: limits.at(-1)!.at + Math.floor(rng() * 10) * MIN }
}

function draw(rng: () => number): Case {
  if (rng() < 0.35) return drawBoundary(rng)
  const limits: Limit[] = []
  let at = T0
  const count = 1 + Math.floor(rng() * 6)
  for (let i = 0; i < count; i++) {
    // Close commits and short resets often, so later limits supersede a window and episodes resolve between commits.
    if (i > 0) at += Math.floor(rng() * (rng() < 0.5 ? 6 : 40)) * MIN
    const profile = rng() < 0.5 ? PROFILES[2] : PROFILES[Math.floor(rng() * PROFILES.length)]!
    const reset = rng()
    limits.push({ ...profile, at, resetsAt: reset < 0.2 ? null : at + (1 + Math.floor(rng() * (reset < 0.6 ? 5 : 90))) * MIN })
  }
  // The crash most often falls inside the sequence, so its gap follows resolutions recorded live.
  const crashAt = count > 2 && rng() < 0.6 ? 2 + Math.floor(rng() * (count - 2)) : Math.floor(rng() * (count + 1))
  const drains = limits.map((limit, i) => {
    const next = limits[i + 1]?.at ?? limit.at + 40 * MIN
    // No drain runs in the crash gap: once the first unseen limit is due, the process is down.
    if (i >= crashAt) return []
    const times: number[] = []
    for (let n = Math.floor(rng() * 3); n > 0; n--) times.push(limit.at + Math.floor(rng() * (next - limit.at + 1)))
    return times.sort((a, b) => a - b)
  })
  const last = limits.at(-1)!.at
  const lastDrain = drains.flat().reduce((max, time) => Math.max(max, time), last)
  return { limits, drains, crashAt, restartAt: lastDrain + Math.floor(rng() * (rng() < 0.5 ? 10 : 100)) * MIN }
}

let open: AdviceHarness[] = []
afterEach(() => {
  for (const harness of open.reverse()) harness.close()
  open = []
})

function harness(db?: AdviceHarness['db']): AdviceHarness {
  const h = adviceHarness(db ? { db } : {})
  h.workers = PROFILES.map(({ profileId }) => ({ model: profileId, provider: 'anthropic' }))
  open.push(h)
  return h
}

function commit(h: AdviceHarness, limit: Limit): void {
  h.clock.now = limit.at
  h.limit({ profileId: limit.profileId, providerId: 'anthropic', window: limit.window, resetsAt: limit.resetsAt === null ? null : new Date(limit.resetsAt).toISOString() })
}

/** The live part: limits before the crash through the subscriber, each followed by its drains. */
function live(entry: Case, h: AdviceHarness, upTo: number): void {
  entry.limits.slice(0, upTo).forEach((limit, i) => {
    commit(h, limit)
    h.drain()
    for (const time of entry.drains[i]!) {
      h.clock.now = time
      h.advice.historyWritten([TEAM])
      h.drain()
    }
  })
}

function boot(db: AdviceHarness['db'], at: number): AdviceHarness {
  const h = harness(db)
  h.clock.now = at
  h.advice.start()
  h.drain()
  h.drain()
  return h
}

interface Observed { anchor: number; members: number[] | null; cutoff: string; basis: string; resolved: boolean; versions: Array<[number, string, string]> }

/** Every recommendation by limit index, oldest anchor first. */
function observe(h: AdviceHarness): Observed[] {
  const ids = (h.db.db.prepare('SELECT id FROM profile_limit_events ORDER BY rowid').all() as Array<{ id: string }>).map(row => row.id)
  return recommendations(h).map(rec => ({
    anchor: ids.indexOf(rec.episodeKey.slice('quota:anthropic:'.length)),
    members: h.advice.members(rec.id)?.map(id => ids.indexOf(id)) ?? null,
    cutoff: rec.cutoff,
    basis: rec.snapshotBasis,
    resolved: rec.assessments.at(-1)?.state === 'resolved',
    versions: rec.assessments.map(assessment => [assessment.version, assessment.cutoff, assessment.state] as [number, string, string]),
  })).sort((a, b) => a.anchor - b.anchor)
}

/** Each final limit in at most one episode, none at or after its episode's recorded resolution. */
function expectPartition(h: AdviceHarness, entry: Case, label: string): void {
  const seen = new Set<number>()
  for (const rec of recommendations(h)) {
    const resolvedAt = rec.assessments.find(assessment => assessment.state === 'resolved')?.createdAt
    const ids = (h.db.db.prepare('SELECT id FROM profile_limit_events ORDER BY rowid').all() as Array<{ id: string }>).map(row => row.id)
    for (const id of h.advice.members(rec.id) ?? []) {
      const index = ids.indexOf(id)
      expect(seen.has(index), label).toBe(false)
      seen.add(index)
      if (resolvedAt && id !== rec.episodeKey.slice('quota:anthropic:'.length)) expect(entry.limits[index]!.at < Date.parse(resolvedAt), label).toBe(true)
    }
  }
}

test('P-R5: live advice and restart reconstruction hold the same open quota episodes, incident events and cutoffs', () => {
  const rng = mulberry32(SEED)
  let resolvedBeforeCrash = 0
  let gapAfterResolution = 0
  for (let index = 0; index < propertyCases(CASES); index++) {
    const entry = draw(rng)
    const label = JSON.stringify({ index, ...entry })

    // Reference: every limit live; the crash gap's limits reach the subscriber but no drain runs until the restart time.
    const reference = harness()
    live(entry, reference, entry.crashAt)
    for (const limit of entry.limits.slice(entry.crashAt)) commit(reference, limit)
    reference.clock.now = entry.restartAt
    reference.advice.historyWritten([TEAM])
    reference.drain()
    reference.drain()
    const expected = observe(reference)
    expectPartition(reference, entry, label)

    // Crash: the same live prefix, then the subscriber stops, the gap commits, and the process restarts twice.
    const crashed = harness()
    live(entry, crashed, entry.crashAt)
    const beforeCrash = observe(crashed)
    if (beforeCrash.some(rec => rec.resolved)) {
      resolvedBeforeCrash++
      if (entry.crashAt < entry.limits.length) gapAfterResolution++
    }
    crashed.advice.shutdown()
    for (const limit of entry.limits.slice(entry.crashAt)) commit(crashed, limit)
    const first = boot(crashed.db, entry.restartAt)
    const actual = observe(first)
    expectPartition(first, entry, label)

    // Limits seen live: the same recommendations, members, cutoffs and versions.
    const seenLive = (rec: Observed) => rec.anchor < entry.crashAt
    expect(actual.filter(seenLive), label).toEqual(expected.filter(seenLive))
    // The crash gap: the same open episodes, anchors, members and first cutoffs; ended ones are not revived.
    const gapOpen = (rec: Observed) => !seenLive(rec) && !rec.resolved
    const shape = (rec: Observed) => ({ anchor: rec.anchor, members: rec.members, cutoff: rec.cutoff, first: rec.versions[0] })
    expect(actual.filter(gapOpen).map(shape), label).toEqual(expected.filter(gapOpen).map(shape))
    expect(actual.filter(rec => !seenLive(rec)).every(rec => !rec.resolved && rec.basis === 'reconstructed'), label).toBe(true)

    // A second restart adds nothing.
    first.advice.shutdown()
    const second = boot(crashed.db, entry.restartAt)
    expect(observe(second), label).toEqual(actual)
    for (const h of open.reverse()) h.close()
    open = []
  }
  // The seeds reach the boundary: resolutions before a crash, with limits committed in its gap.
  expect(resolvedBeforeCrash).toBeGreaterThan(0)
  expect(gapAfterResolution).toBeGreaterThan(0)
}, 600_000)
