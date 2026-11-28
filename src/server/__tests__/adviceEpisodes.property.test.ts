// Live advice equals restart reconstruction (process-quota-history-and-
// incident-advice D5, R5; contract r3 V7): seeded final limits of several
// profiles of one provider, for two teams — model-scoped and provider-scoped
// windows, random resets, commits and drains at one millisecond in both
// orders — through the production ManagerAdvice, queue, evaluator, stores and
// the real LimitEventStore, with drains (and so recorded resolutions)
// interleaved between the commits. An independent step model
// (`helpers/adviceEpisodeModel.ts`) gives the expected anchors, members,
// resolutions and bases before the crash and after each restart, never the
// partition under test. The reference processes every limit live;
// the crash run stops the advice subscriber before a seeded suffix of the
// limits, commits it, and restarts twice. After the restarts both hold the
// same recommendations for every limit seen live, with the same members and
// versions; the same open episodes, anchors, members and first cutoffs for
// the crash gap; each final limit belongs to at most one episode, and none
// committed after its recorded resolution joins it.
import { afterEach, expect, test } from 'bun:test'
import { propertyCases } from './helpers/propertyCases'
import { EpisodeModel } from './helpers/adviceEpisodeModel'
import { adviceHarness, MIN, T0, TEAM, type AdviceHarness } from './helpers/adviceHarness'

const OTHER = 'team-b'

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

interface Limit { team: Team; profileId: string; window: string; at: number; resetsAt: number | null }
type Team = typeof TEAM | typeof OTHER
/** `drains[i]`: drain times after limit i and at or before limit i + 1 (a drain at limit i's instant runs after it, one at limit i + 1's before it). */
interface Case { limits: Limit[]; drains: number[][]; crashAt: number; restartAt: number }

/** Mostly team A; sometimes another team's session on the same provider and profiles (its limits cool the shared profile). */
const teamOf = (rng: () => number): Team => (rng() < 0.2 ? OTHER : TEAM)

/**
 * The resolved-episode boundary family: A and a later B of one window (B's
 * shorter reset supersedes A's), a drain after B's reset that resolves the
 * episode while A's own end is still ahead, then the crash and a gap limit C
 * inside A's own end — of either team — with further limits after it.
 */
function drawBoundary(rng: () => number): Case {
  const pick = () => PROFILES[Math.floor(rng() * PROFILES.length)]!
  const profile = pick()
  const bAt = T0 + (1 + Math.floor(rng() * 3)) * MIN
  const bReset = bAt + (1 + Math.floor(rng() * 3)) * MIN
  const drainAt = bReset + Math.floor(rng() * 3) * MIN
  const limits: Limit[] = [
    { team: TEAM, ...profile, at: T0, resetsAt: T0 + (30 + Math.floor(rng() * 60)) * MIN },
    { team: TEAM, ...profile, at: bAt, resetsAt: bReset },
  ]
  let at = drainAt + Math.floor(rng() * 5) * MIN
  for (let n = 1 + Math.floor(rng() * 3); n > 0; n--) {
    limits.push({ team: rng() < 0.5 ? OTHER : TEAM, ...pick(), at, resetsAt: rng() < 0.2 ? null : at + (1 + Math.floor(rng() * 90)) * MIN })
    at += Math.floor(rng() * 20) * MIN
  }
  const drains = limits.map((): number[] => [])
  drains[1] = [drainAt]
  return { limits, drains, crashAt: 2, restartAt: limits.at(-1)!.at + Math.floor(rng() * 10) * MIN }
}

/**
 * The same-millisecond family: A, then B at instant t whose reset is t or
 * just after (so it supersedes A's window and the episode stops cooling), a
 * drain at t either after B commits (B is consumed by the closing version)
 * or before it (B opens its own episode), and C at that same t after the
 * drain, of either team; the crash falls anywhere after A.
 */
function drawTie(rng: () => number): Case {
  const profile = PROFILES[Math.floor(rng() * PROFILES.length)]!
  const t = T0 + Math.floor(rng() * 4) * MIN
  const commitFirst = rng() < 0.5
  const limits: Limit[] = [
    // Drain before B: A must itself end by t for that drain to resolve it.
    { team: TEAM, ...profile, at: T0, resetsAt: commitFirst ? T0 + (30 + Math.floor(rng() * 60)) * MIN : t },
    { team: TEAM, ...profile, at: t, resetsAt: rng() < 0.7 ? t : t + MIN },
    { team: teamOf(rng), ...profile, at: t, resetsAt: t + (40 + Math.floor(rng() * 60)) * MIN },
  ]
  if (rng() < 0.5) limits.push({ team: teamOf(rng), ...profile, at: t + Math.floor(rng() * 30) * MIN, resetsAt: rng() < 0.3 ? null : t + (10 + Math.floor(rng() * 90)) * MIN })
  const drains = limits.map((): number[] => [])
  drains[commitFirst ? 1 : 0] = [t]
  const crashAt = 1 + Math.floor(rng() * limits.length)
  for (let i = crashAt; i < limits.length; i++) drains[i] = []
  const last = Math.max(limits.at(-1)!.at, ...drains.flat())
  return { limits, drains, crashAt, restartAt: last + Math.floor(rng() * (rng() < 0.5 ? 3 : 100)) * MIN }
}

function draw(rng: () => number): Case {
  const family = rng()
  if (family < 0.25) return drawBoundary(rng)
  if (family < 0.5) return drawTie(rng)
  const limits: Limit[] = []
  let at = T0
  const count = 1 + Math.floor(rng() * 6)
  for (let i = 0; i < count; i++) {
    // Close commits and short resets often, so later limits supersede a window and episodes resolve between commits.
    if (i > 0) at += Math.floor(rng() * (rng() < 0.5 ? 6 : 40)) * MIN
    const profile = rng() < 0.5 ? PROFILES[2] : PROFILES[Math.floor(rng() * PROFILES.length)]!
    const reset = rng()
    limits.push({ team: teamOf(rng), ...profile, at, resetsAt: reset < 0.2 ? null : at + (1 + Math.floor(rng() * (reset < 0.6 ? 5 : 90))) * MIN })
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
  const h = adviceHarness({ ...(db ? { db } : {}), teamOf: id => (id === 'foreign' ? OTHER : id === 's1' ? TEAM : null) })
  h.workers = PROFILES.map(({ profileId }) => ({ model: profileId, provider: 'anthropic' }))
  h.records.set('foreign', { ...h.records.get('s1')!, sessionId: 'foreign', projectPath: '/other/team' })
  open.push(h)
  return h
}

function commit(h: AdviceHarness, limit: Limit): void {
  h.clock.now = limit.at
  h.limit({
    sessionId: limit.team === OTHER ? 'foreign' : 's1', profileId: limit.profileId, providerId: 'anthropic', window: limit.window,
    resetsAt: limit.resetsAt === null ? null : new Date(limit.resetsAt).toISOString(),
  })
}

/** The live part: limits before the crash through the subscriber, each followed by its drains, mirrored step by step in the model. */
function live(entry: Case, h: AdviceHarness, upTo: number, model?: EpisodeModel): void {
  entry.limits.slice(0, upTo).forEach((limit, i) => {
    commit(h, limit)
    h.drain()
    model?.commit(limit, true)
    model?.drain(limit.at)
    for (const time of entry.drains[i]!) {
      h.clock.now = time
      h.advice.historyWritten([TEAM, OTHER])
      h.drain()
      model?.historyWritten([TEAM, OTHER])
      model?.drain(time)
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

interface Observed { team: string; anchor: number; members: number[] | null; cutoff: string; basis: string; resolved: boolean; versions: Array<[number, string, string]> }

const limitIds = (h: AdviceHarness) => (h.db.db.prepare('SELECT id FROM profile_limit_events ORDER BY rowid').all() as Array<{ id: string }>).map(row => row.id)

/** Every recommendation of both teams by limit index, oldest anchor first. */
function observe(h: AdviceHarness): Observed[] {
  const ids = limitIds(h)
  return [TEAM, OTHER].flatMap(team => h.advice.store.list(team, 200).map(rec => h.advice.store.get(team, rec.id)!).map(rec => ({
    team,
    anchor: ids.indexOf(rec.episodeKey.slice('quota:anthropic:'.length)),
    members: h.advice.members(rec.id)?.map(id => ids.indexOf(id)) ?? null,
    cutoff: rec.cutoff,
    basis: rec.snapshotBasis,
    resolved: rec.assessments.at(-1)?.state === 'resolved',
    versions: rec.assessments.map(assessment => [assessment.version, assessment.cutoff, assessment.state] as [number, string, string]),
  }))).sort((a, b) => a.anchor - b.anchor)
}

/** The observable decisions: each team's anchors, members, resolution and basis. */
const decisions = (observed: Observed[]) =>
  observed.map(({ team, anchor, members, resolved, basis }) => ({ team, anchor, members, resolved, reconstructed: basis === 'reconstructed' }))
const modelled = (model: EpisodeModel) =>
  [TEAM, OTHER].flatMap(team => model.memberships(team).map(entry => ({ team, ...entry }))).sort((a, b) => a.anchor - b.anchor)

/** Each final limit in at most one episode, none committed after its episode's recorded resolution. */
function expectPartition(h: AdviceHarness, entry: Case, label: string): void {
  const seen = new Set<number>()
  const ids = limitIds(h)
  for (const team of [TEAM, OTHER]) {
    for (const { id } of h.advice.store.list(team, 200)) {
      const rec = h.advice.store.get(team, id)!
      const resolvedAt = rec.assessments.find(assessment => assessment.state === 'resolved')?.createdAt
      for (const member of h.advice.members(rec.id) ?? []) {
        const index = ids.indexOf(member)
        expect(seen.has(index), label).toBe(false)
        seen.add(index)
        if (resolvedAt) expect(entry.limits[index]!.at <= Date.parse(resolvedAt), label).toBe(true)
      }
    }
  }
}

test('P-R5: live advice and restart reconstruction hold the same open quota episodes, incident events and cutoffs', () => {
  const rng = mulberry32(SEED)
  const reached = { resolvedBeforeCrash: 0, gapAfterResolution: 0, consumedAtClosingInstant: 0, openedAtClosingInstant: 0, foreignGapAfterClosure: 0 }
  for (let index = 0; index < propertyCases(CASES); index++) {
    const entry = draw(rng)
    const label = JSON.stringify({ index, ...entry })

    // Reference: every limit live; the crash gap's limits reach the subscriber but no drain runs until the restart time.
    const reference = harness()
    live(entry, reference, entry.crashAt)
    for (const limit of entry.limits.slice(entry.crashAt)) commit(reference, limit)
    reference.clock.now = entry.restartAt
    reference.advice.historyWritten([TEAM, OTHER])
    reference.drain()
    reference.drain()
    const expected = observe(reference)
    expectPartition(reference, entry, label)

    // Crash: the same live prefix, then the subscriber stops, the gap commits, and the process restarts twice.
    const model = new EpisodeModel('anthropic')
    const crashed = harness()
    live(entry, crashed, entry.crashAt, model)
    const beforeCrash = observe(crashed)
    // Before the crash the live decisions are the model's.
    expect(decisions(beforeCrash), label).toEqual(modelled(model))
    if (beforeCrash.some(rec => rec.resolved)) {
      reached.resolvedBeforeCrash++
      if (entry.crashAt < entry.limits.length) reached.gapAfterResolution++
    }
    const closures = model.episodes.filter(episode => episode.closedAt !== null)
    if (closures.some(episode => episode.members.some(member => entry.limits[member]!.at === episode.closedAt && member !== episode.anchor))) reached.consumedAtClosingInstant++
    if (model.episodes.some(episode => closures.some(closed => closed.team === episode.team && closed !== episode && entry.limits[episode.anchor]!.at === closed.closedAt))) reached.openedAtClosingInstant++
    if (closures.some(closed => closed.team === TEAM && entry.limits.slice(entry.crashAt).some(limit => limit.team === OTHER && limit.at >= closed.closedAt!))) reached.foreignGapAfterClosure++
    crashed.advice.shutdown()
    for (const limit of entry.limits.slice(entry.crashAt)) {
      commit(crashed, limit)
      model.commit(limit, false)
    }
    const first = boot(crashed.db, entry.restartAt)
    model.restart(entry.restartAt)
    const actual = observe(first)
    expectPartition(first, entry, label)
    // After the restart: the model's anchors, members, resolutions and bases, both teams.
    expect(decisions(actual), label).toEqual(modelled(model))

    // Limits seen live: the same recommendations, members, cutoffs and versions.
    const seenLive = (rec: Observed) => rec.anchor < entry.crashAt
    expect(actual.filter(seenLive), label).toEqual(expected.filter(seenLive))
    // The crash gap: the same open episodes, anchors, members and first cutoffs; ended ones are not revived.
    const gapOpen = (rec: Observed) => !seenLive(rec) && !rec.resolved
    const shape = (rec: Observed) => ({ team: rec.team, anchor: rec.anchor, members: rec.members, cutoff: rec.cutoff, first: rec.versions[0] })
    expect(actual.filter(gapOpen).map(shape), label).toEqual(expected.filter(gapOpen).map(shape))
    expect(actual.filter(rec => !seenLive(rec)).every(rec => !rec.resolved && rec.basis === 'reconstructed'), label).toBe(true)

    // A second restart adds nothing.
    first.advice.shutdown()
    const second = boot(crashed.db, entry.restartAt)
    model.restart(entry.restartAt)
    expect(observe(second), label).toEqual(actual)
    expect(decisions(observe(second)), label).toEqual(modelled(model))
    for (const h of open.reverse()) h.close()
    open = []
  }
  // The seeds reach the boundaries: resolutions before a crash with limits in its gap, both orders of a
  // commit and a closing drain at one instant, and another team's gap limit after a closure.
  for (const [boundary, count] of Object.entries(reached)) expect(count, boundary).toBeGreaterThan(0)
}, 600_000)
