// Property P2, no stale headroom (process-quota-history-and-incident-advice
// D3, Table F, bindings B7–B12): over seeded random quota histories, limit
// events and cutoffs, `headroomEvidence` grants headroom exactly when an
// independently written reading of Table F row F1 holds at the cutoff — the
// latest routed windowed observation under the candidate's account scope, at
// or before the cutoff, whose every window is at most 10 minutes old by its
// own time, has not reset, shows room, and has no failure of the same account
// or final limit of the provider (model-scoped limits only for their window)
// at or after it. Evidence after the cutoff never counts (E7). The advice
// evaluator's listed alternatives are checked against the same oracle in the
// recommendation tests.
import { expect, test } from 'bun:test'
import { headroomEvidence, type HeadroomLimit } from '../metrics/observations/headroom'
import type { QuotaObservation, QuotaObservationOutcome } from '../metrics/observations/quotaObservations'
import { propertyCases } from './helpers/propertyCases'

const SEED = 0xF4E5
const CASES = 200
const MIN = 60_000
const T0 = Date.parse('2026-06-01T00:00:00.000Z')
const OUTCOMES: QuotaObservationOutcome[] = ['supported', 'supported', 'supported', 'unavailable', 'auth-refused', 'failed', 'unsupported']
const WINDOWS = ['zai:time_limit', 'seven_day_opus', 'five_hour']

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

const iso = (ms: number) => new Date(ms).toISOString()

/** Table F row F1, read from the design rather than from headroom.ts. */
function oracle(providerId: string, scope: string | null, cutoff: number, observations: QuotaObservation[], limits: HeadroomLimit[]): boolean {
  const visible = observations.filter(row => row.providerId === providerId && Date.parse(row.observedAt) <= cutoff)
  const mine = visible.filter(row => row.accountBasis === 'routed' && row.windows.length > 0 && scope !== null && row.accountScope === scope)
  const latest = mine[mine.length - 1]
  if (!latest) return false
  return latest.windows.every((window) => {
    const at = Date.parse(window.observedAt)
    if (cutoff - at > 10 * MIN) return false
    if (window.resetsAt !== null && Date.parse(window.resetsAt) <= cutoff) return false
    if (window.percentUsed >= 100) return false
    const inSpan = (time: number) => time >= at && time <= cutoff
    if (visible.some(row => row.accountAlias === latest.accountAlias &&
      ['failed', 'auth-refused', 'unavailable'].includes(row.outcome) && inSpan(Date.parse(row.observedAt)))) return false
    return !limits.some(limit => limit.final && limit.providerId === providerId && inSpan(Date.parse(limit.at)) &&
      (limit.window === null || !['seven_day_opus', 'seven_day_sonnet'].includes(limit.window) || limit.window === window.key))
  })
}

function history(rng: () => number): { observations: QuotaObservation[]; limits: HeadroomLimit[]; cutoff: number; scope: string | null } {
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rng() * items.length)]!
  const observations: QuotaObservation[] = []
  let at = T0
  const count = Math.floor(rng() * 8)
  for (let i = 0; i < count; i++) {
    at += Math.floor(rng() * 8 * MIN)
    const outcome = pick(OUTCOMES)
    const observedAt = iso(at)
    const windows = outcome === 'supported' && rng() < 0.85
      ? Array.from({ length: 1 + Math.floor(rng() * 2) }, (_, w) => ({
          key: WINDOWS[(w + Math.floor(rng() * 3)) % 3]!, label: 'w',
          percentUsed: pick([0, 40, 99, 100, 120]),
          resetsAt: rng() < 0.3 ? null : iso(at + Math.floor((rng() - 0.2) * 30 * MIN)),
          observedAt,
        }))
      : []
    observations.push({
      id: `quota-${i}`, teamId: 'team-a', providerId: rng() < 0.85 ? 'zai' : 'other',
      accountAlias: rng() < 0.85 ? 'zai@zai.test' : 'zai@other.test', accountScope: pick(['scope-a', 'scope-a', 'scope-b']),
      accountBasis: rng() < 0.8 ? 'routed' : 'host-login', source: windows.length ? 'pull' : 'none',
      reason: 'worker', outcome, status: null, windows, timeBasis: 'receipt', observedAt, recordedAt: observedAt,
    })
  }
  const limits: HeadroomLimit[] = Array.from({ length: Math.floor(rng() * 3) }, () => ({
    providerId: pick(['zai', 'zai', 'other', null]), at: iso(T0 + Math.floor(rng() * 60 * MIN)),
    final: rng() < 0.7, window: pick([null, null, 'seven_day_opus', 'seven_day_sonnet']),
  }))
  const cutoff = at + Math.floor((rng() - 0.3) * 20 * MIN)
  return { observations, limits, cutoff, scope: pick(['scope-a', 'scope-a', 'scope-b', null]) }
}

test('P2: headroom is granted exactly when Table F row F1 holds at the cutoff (seed 0xF4E5, 200 cases)', () => {
  const failures: string[] = []
  let granted = 0
  for (let index = 0; index < propertyCases(CASES); index++) {
    const rng = mulberry32(SEED + index)
    const { observations, limits, cutoff, scope } = history(rng)
    const result = headroomEvidence({ providerId: 'zai', accountScope: scope, cutoff, observations, limits })
    const expected = oracle('zai', scope, cutoff, observations, limits)
    if (result.valid) granted += 1
    if (result.valid !== expected) failures.push(`case ${index}: valid=${result.valid} oracle=${expected} (${result.reason})`)
    // Later evidence never changes the answer at the cutoff (E7).
    const later = headroomEvidence({
      providerId: 'zai', accountScope: scope, cutoff, limits: [...limits, { providerId: 'zai', at: iso(cutoff + 1), final: true, window: null }],
      observations: [...observations, {
        id: 'later', teamId: 'team-a', providerId: 'zai', accountAlias: 'zai@zai.test', accountScope: scope ?? 'scope-a',
        accountBasis: 'routed', source: 'pull', reason: 'worker', outcome: 'supported', status: null, timeBasis: 'receipt',
        windows: [{ key: 'zai:time_limit', label: 'w', percentUsed: 1, resetsAt: null, observedAt: iso(cutoff + 1) }],
        observedAt: iso(cutoff + 1), recordedAt: iso(cutoff + 1),
      }],
    })
    if (later.valid !== result.valid) failures.push(`case ${index}: later evidence changed the answer`)
  }
  expect(failures).toEqual([])
  // The generator reaches both answers.
  expect(granted).toBeGreaterThan(0)
})
