// Live advice equals restart reconstruction (process-quota-history-and-
// incident-advice D5, R5; decision-059a92d4): seeded final limits of several
// profiles of one provider — model-scoped and provider-scoped windows, random
// resets, early router ends (a credit return, as of a known time) — through
// the production ManagerAdvice, queue, evaluator and stores. Processed live
// (each limit through the subscriber, then a re-evaluation at the restart
// time), and replayed from the committed limit events alone on a fresh
// database at that time, both hold the same open episodes with the same
// incident events and cutoffs; a restart over the live database adds none.
import { afterEach, expect, test } from 'bun:test'
import { routerCoolsAt, type ManagerAdviceDeps } from '../chat/quota/managerAdvice'
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
interface Case { limits: Limit[]; early: Record<string, number>; restartAt: number }

function draw(rng: () => number): Case {
  const limits: Limit[] = []
  let at = T0
  const count = 1 + Math.floor(rng() * 5)
  for (let i = 0; i < count; i++) {
    if (i > 0) at += Math.floor(rng() * 40) * MIN
    const profile = PROFILES[Math.floor(rng() * PROFILES.length)]!
    limits.push({ ...profile, at, resetsAt: rng() < 0.2 ? null : at + (1 + Math.floor(rng() * 90)) * MIN })
  }
  const early: Record<string, number> = {}
  for (const { profileId } of PROFILES) if (rng() < 0.3) early[profileId] = T0 + Math.floor(rng() * 150) * MIN
  return { limits, early, restartAt: at + Math.floor(rng() * 100) * MIN }
}

let open: AdviceHarness[] = []
afterEach(() => {
  for (const harness of open.reverse()) harness.close()
  open = []
})

/** The router's cooldown with the case's early ends: a credit return at E ends the cooldown of the profile's limits from before E. */
const coolsAtFor = (entry: Case, h: () => AdviceHarness): ManagerAdviceDeps['coolsAt'] => (profileId, providerId, atMs) => {
  const early = entry.early[profileId]
  if (early !== undefined && atMs >= early && !entry.limits.some(limit => limit.profileId === profileId && limit.at >= early && limit.at <= atMs)) return false
  return routerCoolsAt(h().limits, profileId, providerId, atMs, h().clock.now)
}

function harness(entry: Case, db?: AdviceHarness['db']): AdviceHarness {
  let h!: AdviceHarness
  h = adviceHarness({ ...(db ? { db } : {}), coolsAt: coolsAtFor(entry, () => h) })
  h.workers = PROFILES.map(({ profileId }) => ({ model: profileId, provider: 'anthropic' }))
  open.push(h)
  return h
}

/** Open episodes as (incident event index, cutoff), oldest first. */
function openEpisodes(h: AdviceHarness, ids: string[]): Array<[number, string]> {
  return recommendations(h).filter(rec => rec.assessments.at(-1)?.state !== 'resolved')
    .map(rec => [ids.indexOf(rec.episodeKey.slice('quota:anthropic:'.length)), rec.cutoff])
}

function boot(entry: Case, db: AdviceHarness['db'], at: number): AdviceHarness {
  const h = harness(entry, db)
  h.clock.now = at
  h.advice.start()
  h.drain()
  return h
}

test('P-R5: live advice and restart reconstruction hold the same open quota episodes, incident events and cutoffs', () => {
  const rng = mulberry32(SEED)
  for (let index = 0; index < propertyCases(CASES); index++) {
    const entry = draw(rng)
    const label = JSON.stringify({ index, ...entry })
    // Live: every final limit through the subscriber, then a re-evaluation at the restart time.
    const live = harness(entry)
    for (const limit of entry.limits) {
      live.clock.now = limit.at
      live.limit({ profileId: limit.profileId, providerId: 'anthropic', window: limit.window, resetsAt: limit.resetsAt === null ? null : new Date(limit.resetsAt).toISOString() })
      live.drain()
    }
    live.clock.now = entry.restartAt
    live.advice.historyWritten([TEAM])
    live.drain()
    const rows = live.db.db.prepare('SELECT * FROM profile_limit_events ORDER BY rowid').all() as Array<Record<string, string | number | null>>
    const ids = rows.map(row => String(row.id))
    const expected = openEpisodes(live, ids)

    // Replay: the committed limit events alone, on a fresh database, at the restart time.
    const fresh = harness(entry)
    fresh.advice.shutdown()
    const columns = Object.keys(rows[0]!)
    const insert = fresh.db.db.prepare(`INSERT INTO profile_limit_events (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
    for (const row of rows) insert.run(...columns.map(column => row[column]!))
    const replayed = boot(entry, fresh.db, entry.restartAt)
    expect(openEpisodes(replayed, ids), label).toEqual(expected)
    expect(recommendations(replayed).filter(rec => rec.assessments.at(-1)?.state !== 'resolved').every(rec => rec.snapshotBasis === 'reconstructed'), label).toBe(true)

    // A restart over the live database adds none.
    live.advice.shutdown()
    const before = recommendations(live).map(rec => rec.id)
    const restarted = boot(entry, live.db, entry.restartAt)
    expect(recommendations(restarted).map(rec => rec.id), label).toEqual(before)
    expect(openEpisodes(restarted, ids), label).toEqual(expected)
    for (const h of open.reverse()) h.close()
    open = []
  }
}, 600_000)
