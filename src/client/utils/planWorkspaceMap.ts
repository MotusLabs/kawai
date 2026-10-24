// The dependency workspace's deterministic layout (plan-workspace 5.2,
// design D2): dependency depth decides the column — `0` for roots, otherwise
// `1 + max(parent depth)` — and plan order decides the rows and breaks ties.
// Position and size never imply dates or duration. Invalid dependency data
// (a cycle, or a dependency naming no change of the plan) never loops: the
// fixpoint simply stops resolving, and the map falls back to a flat
// diagnostic list in plan order that names the unresolved changes and one
// cycle's path. Pure and SDK-free, so the map component and its tests share
// one grammar.
import type { PlanContent } from '@shared/plans'

/** One visible row: the change, its column, and its resolved edges. */
export interface WbsRow {
  change: string
  /** The depth column (0-based); 0 on the fallback list. */
  depth: number
  /** This change's prerequisites, in `dependsOn` order. */
  dependsOn: string[]
  /** The changes that depend on this one, in plan order. */
  dependents: string[]
}

export type WbsLayout =
  | { kind: 'map'; rows: WbsRow[]; maxDepth: number }
  | {
      kind: 'fallback'
      /** Every change, flat, in plan order (depth 0). */
      rows: WbsRow[]
      /** The changes whose depth never resolved (cycle members and their dependents), in plan order. */
      unresolved: string[]
      /** One cycle's path, first-repeated node first; null when the blockage is a missing dependency. */
      cyclePath: string[] | null
    }

export function wbsLayout(content: Pick<PlanContent, 'changes'>): WbsLayout {
  const names = content.changes.map(entry => entry.change)
  const depsOf = new Map<string, string[]>(
    content.changes.map(entry => [entry.change, entry.dependsOn]),
  )
  const inPlan = new Set(names)
  // The dependents' edges resolve only over known changes; an unknown
  // dependency name leaves its dependent unresolvable (diagnostic fallback).
  const dependentsOf = new Map<string, string[]>(names.map(name => [name, []]))
  for (const name of names) {
    for (const dependency of depsOf.get(name) ?? []) {
      if (inPlan.has(dependency)) dependentsOf.get(dependency)!.push(name)
    }
  }
  const depthOf = new Map<string, number>()
  let progressed = true
  while (progressed && depthOf.size < names.length) {
    progressed = false
    for (const name of names) {
      if (depthOf.has(name)) continue
      const deps = depsOf.get(name) ?? []
      // A dependency outside the plan never resolves; neither does this row.
      if (!deps.every(dependency => inPlan.has(dependency))) continue
      let depth = 0
      let ready = true
      for (const dependency of deps) {
        const resolved = depthOf.get(dependency)
        if (resolved === undefined) { ready = false; break }
        depth = Math.max(depth, resolved + 1)
      }
      if (ready) {
        depthOf.set(name, depth)
        progressed = true
      }
    }
  }
  const rowOf = (name: string, depth: number): WbsRow => ({
    change: name, depth, dependsOn: depsOf.get(name) ?? [], dependents: dependentsOf.get(name) ?? [],
  })
  const unresolved = names.filter(name => !depthOf.has(name))
  if (unresolved.length === 0) {
    const rows = names.map(name => rowOf(name, depthOf.get(name)!))
    return { kind: 'map', rows, maxDepth: rows.reduce((max, row) => Math.max(max, row.depth), 0) }
  }
  return {
    kind: 'fallback',
    rows: names.map(name => rowOf(name, 0)),
    unresolved,
    cyclePath: findCycle(unresolved, depsOf),
  }
}

/** One cycle's path among the unresolved nodes, deterministic from plan order. */
function findCycle(unresolved: readonly string[], depsOf: ReadonlyMap<string, string[]>): string[] | null {
  const unresolvedSet = new Set(unresolved)
  for (const start of unresolved) {
    const seen = new Map<string, number>()
    const path: string[] = []
    let current: string | undefined = start
    while (current !== undefined && unresolvedSet.has(current)) {
      const at = seen.get(current)
      if (at !== undefined) return path.slice(at)
      seen.set(current, path.length)
      path.push(current)
      current = (depsOf.get(current) ?? []).find(dependency => unresolvedSet.has(dependency))
    }
  }
  return null
}

/** Which map filter shows a row (design D2's active/blocked split). */
export type MapFilterClass = 'active' | 'blocked' | 'other'

/** A runtime row's filter class: work in flight is active, waiting work is blocked, the rest is other. */
export function filterClassOf(state: { kind: string } | null): MapFilterClass {
  if (state === null) return 'other'
  if (state.kind === 'waiting') return 'blocked'
  if (state.kind === 'implementing' || state.kind === 'in-review' || state.kind === 'ready-for-qa'
    || state.kind === 'fixes-requested' || state.kind === 'stalled') return 'active'
  return 'other'
}

export function changeMatchesFilter(state: { kind: string } | null, filter: 'all' | 'active' | 'blocked'): boolean {
  if (filter === 'all') return true
  return filterClassOf(state) === filter
}
