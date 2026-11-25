// Headroom evidence (process-quota-history-and-incident-advice D3, Table F,
// bindings B7–B11): may the quota history available at a cutoff establish
// headroom for a routed provider's account? Pure — the caller passes the
// team's observations and the provider's limit events, and only those at or
// before the cutoff count, so a later report can never leak into a frozen
// assessment (Table E row E7).
//
// A window establishes headroom only when all of these hold:
// - it is the routed provider's own account (a host-login report never
//   counts, F5), observed by this process under the candidate's effective
//   key — its account scope (B12); another or an unknown credential at the
//   same provider@host leaves headroom unknown;
// - its own observation time is at most 10 minutes old (F2, F6);
// - its reset has not passed (F3);
// - no failure or limit of the same account at or after it vetoes it (F4);
// - it shows room (below 100%).
// The account has headroom when its latest windowed observation has at least
// one window and every window passes.
import type { QuotaObservation, QuotaWindowObservation } from './quotaObservations'

export const HEADROOM_FRESH_MS = 10 * 60_000
const MODEL_SCOPED = new Set(['seven_day_opus', 'seven_day_sonnet'])

export interface HeadroomLimit {
  providerId: string | null
  at: string
  final: boolean
  window: string | null
}

export type HeadroomReason = 'fresh' | 'none' | 'host-login' | 'other-account' | 'stale' | 'reset-passed' | 'later-failure' | 'exhausted'

export interface WindowEvidence {
  key: string
  percentUsed: number
  resetsAt: string | null
  observedAt: string
  ageMs: number
  reason: HeadroomReason
}

export interface HeadroomEvidence {
  /** True only for Table F row F1. */
  valid: boolean
  reason: HeadroomReason
  /** The observation the windows came from; null without one. */
  observationId: string | null
  accountAlias: string | null
  windows: WindowEvidence[]
}

const time = (iso: string): number => Date.parse(iso)

function windowReason(
  window: QuotaWindowObservation, alias: string, cutoff: number,
  observations: QuotaObservation[], limits: HeadroomLimit[], providerId: string
): HeadroomReason {
  const at = time(window.observedAt)
  if (cutoff - at > HEADROOM_FRESH_MS) return 'stale'
  if (window.resetsAt !== null && time(window.resetsAt) <= cutoff) return 'reset-passed'
  const failed = observations.some(other =>
    other.accountAlias === alias && other.providerId === providerId &&
    (other.outcome === 'failed' || other.outcome === 'auth-refused' || other.outcome === 'unavailable') &&
    time(other.observedAt) >= at && time(other.observedAt) <= cutoff)
  const limited = limits.some(limit =>
    limit.final && limit.providerId === providerId && time(limit.at) >= at && time(limit.at) <= cutoff &&
    (limit.window === null || !MODEL_SCOPED.has(limit.window) || limit.window === window.key))
  if (failed || limited) return 'later-failure'
  if (window.percentUsed >= 100) return 'exhausted'
  return 'fresh'
}

/**
 * The evidence for `providerId` at `cutoff` (epoch ms) from a team's quota
 * observations and the provider's limit events; anything after the cutoff is
 * ignored.
 */
export function headroomEvidence(input: {
  providerId: string
  /** The candidate's account scope in this process (B12); null when it has no resolvable key. */
  accountScope: string | null
  cutoff: number
  observations: QuotaObservation[]
  limits: HeadroomLimit[]
}): HeadroomEvidence {
  const { providerId, cutoff } = input
  const known = input.observations.filter(row => row.providerId === providerId && time(row.observedAt) <= cutoff)
  const limits = input.limits.filter(limit => time(limit.at) <= cutoff)
  const windowed = known.filter(row => row.windows.length > 0)
  const routed = windowed.filter(row => row.accountBasis === 'routed')
  const latest = routed.filter(row => input.accountScope !== null && row.accountScope === input.accountScope).at(-1)
  if (!latest) {
    return {
      valid: false, reason: routed.length > 0 ? 'other-account' : windowed.length > 0 ? 'host-login' : 'none',
      observationId: null, accountAlias: null, windows: [],
    }
  }
  const windows = latest.windows.map((window): WindowEvidence => ({
    key: window.key, percentUsed: window.percentUsed, resetsAt: window.resetsAt, observedAt: window.observedAt,
    ageMs: cutoff - time(window.observedAt),
    reason: windowReason(window, latest.accountAlias, cutoff, known, limits, providerId),
  }))
  const failing = windows.find(window => window.reason !== 'fresh')
  return {
    valid: !failing, reason: failing?.reason ?? 'fresh',
    observationId: latest.id, accountAlias: latest.accountAlias, windows,
  }
}
