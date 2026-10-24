// The dependency workspace's pure layout (plan-workspace 5.2, design D2):
// depth columns from the dependency graph with plan-order rows, and the
// deterministic diagnostic fallback when dependency data cannot resolve.
import { describe, expect, test } from 'bun:test'
import { changeMatchesFilter, filterClassOf, wbsLayout } from '../utils/planWorkspaceMap'
import { normalizePlanContent } from '@shared/plans'

const content = (changes: Array<{ change: string; dependsOn?: string[] }>) =>
  normalizePlanContent({
    changes: changes.map(entry => ({ change: entry.change, dependsOn: entry.dependsOn ?? [] })),
  })

describe('wbsLayout', () => {
  test('parallel A and B join at C: both roots at depth 0, C one deeper with both edges', () => {
    const layout = wbsLayout(content([
      { change: 'a' }, { change: 'b' }, { change: 'c', dependsOn: ['a', 'b'] },
    ]))
    expect(layout.kind).toBe('map')
    if (layout.kind !== 'map') return
    expect(layout.maxDepth).toBe(1)
    expect(layout.rows.map(row => [row.change, row.depth])).toEqual([['a', 0], ['b', 0], ['c', 1]])
    expect(layout.rows[2]!.dependsOn).toEqual(['a', 'b'])
    expect(layout.rows[0]!.dependents).toEqual(['c'])
    expect(layout.rows[1]!.dependents).toEqual(['c'])
  })

  test('a chain deepens one column per dependency; plan order breaks ties', () => {
    const layout = wbsLayout(content([
      { change: 'late', dependsOn: ['mid'] }, { change: 'mid', dependsOn: ['early'] }, { change: 'early' },
    ]))
    expect(layout.kind).toBe('map')
    if (layout.kind !== 'map') return
    expect(layout.rows.map(row => [row.change, row.depth])).toEqual([['late', 2], ['mid', 1], ['early', 0]])
    // The deepest parent wins: two parents at depths 0 and 2 put the child at 3.
    const mixed = wbsLayout(content([
      { change: 'a' }, { change: 'b', dependsOn: ['a'] }, { change: 'c', dependsOn: ['b'] },
      { change: 'd', dependsOn: ['a', 'c'] },
    ]))
    expect(mixed.kind).toBe('map')
    if (mixed.kind !== 'map') return
    expect(mixed.rows.find(row => row.change === 'd')!.depth).toBe(3)
  })

  test('a cycle falls back to a flat list naming the unresolved changes and the cycle path', () => {
    const layout = wbsLayout(content([
      { change: 'a', dependsOn: ['b'] }, { change: 'b', dependsOn: ['a'] }, { change: 'c' },
    ]))
    expect(layout.kind).toBe('fallback')
    if (layout.kind !== 'fallback') return
    expect(layout.unresolved).toEqual(['a', 'b'])
    expect(layout.cyclePath).toEqual(['a', 'b'])
    // Every change stays listed, flat, in plan order — never dropped, never looped.
    expect(layout.rows.map(row => [row.change, row.depth])).toEqual([['a', 0], ['b', 0], ['c', 0]])
  })

  test('a dependency naming no change of the plan blocks its row without a cycle', () => {
    const layout = wbsLayout(content([
      { change: 'a', dependsOn: ['ghost'] }, { change: 'b', dependsOn: ['a'] }, { change: 'c' },
    ]))
    expect(layout.kind).toBe('fallback')
    if (layout.kind !== 'fallback') return
    expect(layout.unresolved).toEqual(['a', 'b'])
    expect(layout.cyclePath).toBeNull()
  })

  test('a self-dependency falls back with a one-node cycle', () => {
    const layout = wbsLayout(content([{ change: 'a', dependsOn: ['a'] }]))
    expect(layout.kind).toBe('fallback')
    if (layout.kind !== 'fallback') return
    expect(layout.cyclePath).toEqual(['a'])
  })
})

describe('changeMatchesFilter', () => {
  test('active work in flight, blocked waits, everything else only under all', () => {
    expect(filterClassOf({ kind: 'implementing' })).toBe('active')
    expect(filterClassOf({ kind: 'in-review' })).toBe('active')
    expect(filterClassOf({ kind: 'stalled' })).toBe('active')
    expect(filterClassOf({ kind: 'waiting' })).toBe('blocked')
    expect(filterClassOf({ kind: 'landed' })).toBe('other')
    expect(filterClassOf({ kind: 'not-started' })).toBe('other')
    expect(filterClassOf(null)).toBe('other')
    expect(changeMatchesFilter({ kind: 'waiting' }, 'all')).toBe(true)
    expect(changeMatchesFilter({ kind: 'waiting' }, 'blocked')).toBe(true)
    expect(changeMatchesFilter({ kind: 'waiting' }, 'active')).toBe(false)
    expect(changeMatchesFilter({ kind: 'implementing' }, 'blocked')).toBe(false)
    expect(changeMatchesFilter({ kind: 'landed' }, 'active')).toBe(false)
  })
})
