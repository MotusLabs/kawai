// Independent brute-force delivery oracles. Each Fk gets a fresh DFS closure;
// this oracle never calls the production BFS or shares its visited/stamp state.
import { expect, test } from 'bun:test'
import { containedBy, intervalMembership, landingPositions } from '../metrics/delivery/landing'
import type { CommitGraph, Landing } from '../metrics/delivery/types'
import { id, mulberry32, randomDag } from './fixtures/deliveryCases'

function ancestors(start: string, graph: CommitGraph): Set<string> {
  const visited = new Set<string>()
  const stack = [start]
  while (stack.length > 0) {
    const next = stack.pop()!
    if (visited.has(next)) continue
    visited.add(next)
    for (const parent of graph.get(next)!.parents) stack.push(parent)
  }
  return visited
}

function bruteForce(graph: CommitGraph, head: string): { chain: string[]; landings: Map<string, Landing> } {
  const chain: string[] = []
  for (let cursor: string | undefined = head; cursor !== undefined; cursor = graph.get(cursor)!.parents[0]) chain.unshift(cursor)
  const closures = chain.map(sha => ancestors(sha, graph))
  const landings = new Map<string, Landing>()
  for (const sha of graph.keys()) {
    const index = closures.findIndex(closure => closure.has(sha))
    if (index < 0) continue
    landings.set(sha, {
      position: index + 1,
      at: graph.get(chain[index]!)!.committedAt,
      bound: Math.max(...chain.slice(0, index + 1).map(id => graph.get(id)!.committedAt)),
    })
  }
  return { chain, landings }
}

// @covers: delivery-outcomes › A result commit lands at its first containing position › First position, not earliest time
test('P1 seed 0xDE11: 500 DAGs match independent per-position ancestor closures', () => {
  const random = mulberry32(0xDE11)
  for (let caseNo = 0; caseNo < 500; caseNo++) {
    const { graph, head } = randomDag(random)
    expect(graph.size).toBeGreaterThanOrEqual(30)
    expect(graph.size).toBeLessThanOrEqual(200)
    for (const commit of graph.values()) if (commit.parents.length > 0) {
      expect(commit.parents.length).toBeLessThanOrEqual(3)
    }
    const expected = bruteForce(graph, head)
    const actual = landingPositions(graph, head)
    expect(actual.chain.map(commit => commit.sha), `P1 case ${caseNo}`).toEqual(expected.chain)
    expect([...actual.commits.entries()].sort(), `P1 case ${caseNo}`).toEqual([...expected.landings.entries()].sort())
    // The generator guarantees these nonvacuous witnesses in EVERY case.
    expect(graph.get(id(1))!.committedAt).toBe(graph.get(id(2))!.committedAt)
    expect(expected.chain).not.toContain(id(3))
    expect(actual.commits.get(id(3))).toEqual({ position: 3, at: 50_000, bound: 100_000 })
    expect(ancestors(id(2), graph).has(id(1))).toBe(true)
    expect(ancestors(id(4), graph).has(id(1))).toBe(true)
  }
})

test('P6 seed 0x1A1F: 500 DAGs cannot double-count adjacent intervals', () => {
  const random = mulberry32(0x1A1F)
  let inCount = 0
  let unknownCount = 0
  for (let caseNo = 0; caseNo < 500; caseNo++) {
    const { graph, head } = randomDag(random)
    const oracle = bruteForce(graph, head).landings
    const actual = landingPositions(graph, head).commits
    const selected = [...oracle.values()][Math.floor(random() * oracle.size)]!
    const span = (1 + Math.floor(random() * 1000)) * 1000
    // Random exact-boundary witnesses accompany arbitrary random ends.
    const end = caseNo % 2 === 0 ? selected.at + span : Math.floor(random() * 2000) * 1000
    for (const [sha, truth] of oracle) {
      const landing = actual.get(sha)!
      const current = intervalMembership(landing, end - span, end)
      const baseline = intervalMembership(landing, end - 2 * span, end - span)
      expect(current === 'in' && baseline === 'in', `P6 case ${caseNo} ${sha}`).toBe(false)
      for (const [from, until, membership] of [[end - span, end, current],
        [end - 2 * span, end - span, baseline]] as const) {
        // Classify the uncertainty SET by its two endpoints, using only
        // numbers from the independently computed position oracle.
        const endpointsInside = [truth.at, truth.bound].map(t => from <= t && t < until)
        const disjoint = truth.bound < from || until <= truth.at
        const expected = endpointsInside.every(Boolean) ? 'in' : disjoint ? 'out' : 'unknown'
        expect(membership, `P6 case ${caseNo} ${sha}`).toBe(expected)
        if (membership === 'in') {
          inCount++
          expect(truth.bound <= end).toBe(true)
          expect(containedBy(landing, end)).toBe('yes')
        }
        if (membership === 'unknown') unknownCount++
      }
    }
  }
  expect(inCount).toBeGreaterThan(0)
  expect(unknownCount).toBeGreaterThan(0)
})
