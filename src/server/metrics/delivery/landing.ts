// First-containing-position walk (delivery-outcome-metrics D3). Time never
// orders landings: backdating widens [at, bound], it never moves a position.
import type { CommitGraph, Integration, Landing, LandingPositions } from './types'
import { DeliveryHistoryError } from './types'

export { changeLandings } from './archive'
export { resolveResultCommit } from './resultCommit'

/** Git %ct is integer seconds; delivery predicates use milliseconds. */
export function commitTimeMs(seconds: number): number {
  const ms = seconds * 1000
  if (!Number.isSafeInteger(seconds) || !Number.isSafeInteger(ms)) {
    throw new DeliveryHistoryError('history-malformed')
  }
  return ms
}

/** The caller supplies a complete DAG. Missing chain/parent nodes fail closed. */
export function landingPositions(graph: CommitGraph, head: string): LandingPositions {
  const reversed: string[] = []
  const seen = new Set<string>()
  let sha: string | undefined = head
  while (sha !== undefined) {
    if (seen.has(sha)) throw new DeliveryHistoryError('history-malformed')
    seen.add(sha)
    const commit = graph.get(sha)
    if (commit === undefined) throw new DeliveryHistoryError('history-incomplete')
    reversed.push(sha)
    sha = commit.parents[0]
  }

  const chain: Integration[] = []
  const commits = new Map<string, Landing>()
  let bound = -Infinity
  for (const id of reversed.reverse()) {
    const at = graph.get(id)!.committedAt
    if (!Number.isSafeInteger(at)) throw new DeliveryHistoryError('history-malformed')
    bound = Math.max(bound, at)
    const landing: Integration = { sha: id, position: chain.length + 1, at, bound }
    chain.push(landing)
    const pending = [id]
    for (let index = 0; index < pending.length; index++) {
      const reached = pending[index]!
      if (commits.has(reached)) continue
      const commit = graph.get(reached)
      if (commit === undefined) throw new DeliveryHistoryError('history-incomplete')
      commits.set(reached, { position: landing.position, at, bound })
      pending.push(...commit.parents)
    }
  }
  return { chain, commits }
}

function validInterval(landing: Landing): boolean {
  return Number.isFinite(landing.at) && Number.isFinite(landing.bound) && landing.at <= landing.bound
}

/** Inclusive containment answers a different question from event membership. */
export function containedBy(landing: Landing, end: number): 'yes' | 'no' | 'unknown' {
  if (!validInterval(landing) || !Number.isFinite(end)) return 'unknown'
  if (landing.bound <= end) return 'yes'
  if (landing.at > end) return 'no'
  return 'unknown'
}

/** Membership in [from, end); an interval straddling either edge is unknown. */
export function intervalMembership(landing: Landing, from: number, end: number): 'in' | 'out' | 'unknown' {
  if (!validInterval(landing) || !Number.isFinite(from) || !Number.isFinite(end) || from >= end) return 'unknown'
  if (from <= landing.at && landing.bound < end) return 'in'
  if (landing.bound < from || landing.at >= end) return 'out'
  return 'unknown'
}
