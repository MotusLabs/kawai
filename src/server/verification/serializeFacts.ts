// serializeFacts.ts - The result-check facts as stored (independent-
// verification D2): versioned JSON of at most 64 KB. Oversized lists
// shrink progressively, their true totals preserved — every `more` count
// absorbs what its list gave up, and the compared list trades length for
// the skipped count. Split from resultChecks.ts (file-size cap, K7); the
// facts' computation stays there.

import type { ResultCheckFacts } from '../../shared/teamTasks'

export const FACTS_MAX_BYTES = 64 * 1024

/** The most paths any one list carries before shrinking starts. */
export const MAX_LISTED_PATHS = 20

/** Keep at most `keep` names; the count covers the whole list. */
const shrink = (names: string[], more: number, keep: number): { names: string[]; more: number } => {
  const kept = Math.min(names.length, Math.max(keep, 0))
  return { names: names.slice(0, kept), more: names.length + more - kept }
}

export function serializeFacts(facts: ResultCheckFacts): string {
  let json = JSON.stringify(facts)
  if (Buffer.byteLength(json) <= FACTS_MAX_BYTES) return json
  for (const keep of [MAX_LISTED_PATHS, 10, 5, 2, 1]) {
    const clean = facts.clean === null ? null : (() => {
      const shrunk = shrink(facts.clean.paths, facts.clean.more, keep)
      return { ...facts.clean, paths: shrunk.names, more: shrunk.more }
    })()
    const baseConflicts = shrink(facts.base.conflicts, facts.base.moreConflicts, keep)
    const comparedCount = Math.max(1, Math.min(facts.branches.compared.length, keep))
    const clamped: ResultCheckFacts = {
      ...facts,
      clean,
      base: { ...facts.base, conflicts: baseConflicts.names, moreConflicts: baseConflicts.more },
      branches: {
        ...facts.branches,
        compared: facts.branches.compared.slice(0, comparedCount).map(entry => {
          const conflicts = shrink(entry.conflicts, entry.moreConflicts, keep)
          const overlap = shrink(entry.overlap, entry.moreOverlap, keep)
          return { ...entry, conflicts: conflicts.names, moreConflicts: conflicts.more, overlap: overlap.names, moreOverlap: overlap.more }
        }),
        skipped: facts.branches.skipped + Math.max(0, facts.branches.compared.length - comparedCount),
      },
    }
    json = JSON.stringify(clamped)
    if (Buffer.byteLength(json) <= FACTS_MAX_BYTES) return json
  }
  // A facts object still over the cap with single-item lists cannot happen
  // through computeResultFacts; the coverage outcomes go before that: they
  // join the map positionally (D5), so a cut array would silently misalign
  // every later clause — they are dropped whole or kept whole.
  const withoutCoverage = JSON.stringify({ ...facts, coverage: undefined })
  if (Buffer.byteLength(withoutCoverage) <= FACTS_MAX_BYTES) return withoutCoverage
  return JSON.stringify({
    ...facts,
    coverage: undefined,
    clean: facts.clean === null ? null : { ...facts.clean, paths: [], more: facts.clean.paths.length + facts.clean.more },
    base: { ...facts.base, conflicts: [], moreConflicts: facts.base.conflicts.length + facts.base.moreConflicts },
    branches: { ...facts.branches, compared: [], skipped: facts.branches.skipped + facts.branches.comparedCount },
  })
}
