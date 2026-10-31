// Pure landing oracles (delivery-outcome-metrics1.1). The original observable
// checkpoint remains intact; no production Git reader is activated.
import { expect, test } from 'bun:test'
import {
  changeLandings, containedBy, intervalMembership, landingPositions, resolveResultCommit,
  commitTimeMs,
} from '../metrics/delivery/landing'
import { DeliveryHistoryError } from '../metrics/delivery/types'
import { FIXTURE_EPOCH, mergeArchiveFixture } from './fixtures/deliveryRepo'
import { graphOf, id } from './fixtures/deliveryCases'
import { TABLE_I, TABLE_L } from './fixtures/deliveryOracleRows'

const context = { teamId: 'fixture-team', taskId: 'fixture-task', resultId: 'fixture-result' }
const finish = '2026-10-03T00:00:00.000Z'
const check = (sha: string, seq = 1, id = 'fixture-check') => ({
  ...context, id, seq, finishedAt: finish, status: 'done',
  facts: { version: 1, commit: { status: 'pass', given: sha, sha } },
})

// @covers: delivery-outcomes › A result commit lands at its first containing position › Result merged through a pull request
// @covers: delivery-outcomes › A result commit lands at its first containing position › Backdated bridge
// @covers: delivery-outcomes › A change lands when its archive directory reaches the default branch › Archive merged
// @covers: delivery-outcomes › A result commit lands at its first containing position › Boundary at the window end
test('checkpoint: merge/archive/result composition preserves position and uncertainty', () => {
  const fixture = mergeArchiveFixture()
  try {
    const { graph, archives } = fixture.repo.snapshot(fixture.head)
    const positions = landingPositions(graph, fixture.head)
    const expected = { position: 2, at: FIXTURE_EPOCH + 50_000, bound: FIXTURE_EPOCH + 100_000 }
    expect(positions.chain.map(row => row.sha)).toEqual([fixture.root, fixture.merge, fixture.head])
    expect(positions.commits.get(fixture.feature)).toEqual(expected)
    expect(positions.commits.has(fixture.offgraph)).toBe(false)
    expect(changeLandings(archives, positions, 'sha1')).toEqual({ ok: true, changes: new Map([['example', expected]]) })
    expect(resolveResultCommit({ ...context, commitRef: fixture.feature, objectFormat: 'sha1',
      landings: positions.commits, checks: [] })).toEqual({ kind: 'landed', sha: fixture.feature, landing: expected })

    expect(containedBy(expected, FIXTURE_EPOCH + 40_000)).toBe('no')
    expect(containedBy(expected, FIXTURE_EPOCH + 75_000)).toBe('unknown')
    expect(containedBy(expected, FIXTURE_EPOCH + 150_000)).toBe('yes')
    expect(intervalMembership(expected, FIXTURE_EPOCH + 100_000, FIXTURE_EPOCH + 150_000)).toBe('unknown')
    expect(intervalMembership(expected, FIXTURE_EPOCH + 40_000, FIXTURE_EPOCH + 150_000)).toBe('in')

    // The real Git %ct of the monotonic tip is exactly the window end in ms.
    const tip = positions.commits.get(fixture.head)!
    const end = FIXTURE_EPOCH + 200_000
    expect(tip).toEqual({ position: 3, at: end, bound: end })
    expect(containedBy(tip, end)).toBe('yes')
    expect(intervalMembership(tip, end - 100_000, end)).toBe('out')
    expect(intervalMembership(tip, end, end + 100_000)).toBe('in')
  } finally { fixture.repo.dispose() }
})

// @covers: delivery-outcomes › Result commits are identified by full literal ids only › Off-history literal with a check
// @covers: delivery-outcomes › A result commit lands at its first containing position › Unmerged result
// @covers: delivery-outcomes › A result commit lands at its first containing position › Unmerged result without a passing check
// @covers: delivery-outcomes › Result commits are identified by full literal ids only › Abbreviation stays unresolvable
test('checkpoint: offgraph identity requires exact evidence and refuses contradictions', () => {
  const fixture = mergeArchiveFixture()
  try {
    const positions = landingPositions(fixture.repo.snapshot(fixture.head).graph, fixture.head)
    const input = { ...context, commitRef: fixture.offgraph, objectFormat: 'sha1' as const, landings: positions.commits }
    expect(resolveResultCommit({ ...input, checks: [] })).toEqual({ kind: 'unresolvable', reason: 'no-corroboration' })
    expect(resolveResultCommit({ ...input, checks: [{ ...check(fixture.offgraph), status: 'pending' }] }).kind).toBe('unresolvable')
    expect(resolveResultCommit({ ...input, checks: [check(fixture.offgraph, 3, 'z'), check(fixture.offgraph, 1, 'b'),
      check(fixture.offgraph, 1, 'a')] })).toEqual({
      kind: 'not-landed', sha: fixture.offgraph, evidence: { id: 'a', seq: 1, finishedAt: finish },
    })
    const conflicting = { ...check(fixture.offgraph, 2), facts: {
      version: 1, commit: { status: 'pass', given: fixture.offgraph, sha: fixture.feature },
    } }
    for (const checks of [[conflicting], [check(fixture.offgraph), conflicting], [conflicting, check(fixture.offgraph)]]) {
      expect(resolveResultCommit({ ...input, checks })).toEqual({ kind: 'unresolvable', reason: 'contradictory-check' })
    }
    expect(resolveResultCommit({ ...input, commitRef: fixture.feature.slice(0, 7), checks: [check(fixture.feature)] }).kind).toBe('unresolvable')
    expect(resolveResultCommit({ ...input, commitRef: fixture.feature.toUpperCase(), checks: [] }).kind).toBe('unresolvable')
    expect(resolveResultCommit({ ...input, commitRef: fixture.feature, checks: [conflicting] }).kind).toBe('landed')
  } finally { fixture.repo.dispose() }
})

test('checkpoint: malformed archive input fails whole instead of returning partial arrivals', () => {
  const fixture = mergeArchiveFixture()
  try {
    const { graph, archives } = fixture.repo.snapshot(fixture.head)
    const positions = landingPositions(graph, fixture.head)
    for (const suffix of ['stray.md\n', 'openspec/changes/archive/2026-10-02-example/nested/proposal.md\n',
      'openspec/changes/archive/not-a-date-example/proposal.md\n', '@not-a-full-id\n']) {
      expect(changeLandings(archives + suffix, positions, 'sha1')).toEqual({ ok: false, reason: 'archive-malformed' })
    }
    expect(changeLandings('', positions, 'sha1')).toEqual({ ok: true, changes: new Map() })
  } finally { fixture.repo.dispose() }
})

// @covers: delivery-outcomes › A result commit lands at its first containing position › First position, not earliest time
test('Table L1-L3: first containing positions follow all parents, never the minimum time', () => {
  const cases = {
    L1: { graph: graphOf([[1, 100], [2, 200, 1]]), target: 2, expected: { position: 2, at: 200, bound: 200 } },
    L2: { graph: graphOf([[1, 100], [2, 200, 1, 3], [3, 150, 1]]), target: 3, expected: { position: 2, at: 200, bound: 200 } },
    L3: { graph: graphOf([[1, 100], [2, 90, 1]]), target: 1, expected: { position: 1, at: 100, bound: 100 } },
  }
  for (const row of TABLE_L.filter(row => row[0] === 'L1' || row[0] === 'L2' || row[0] === 'L3')) {
    const { graph, target, expected } = cases[row[0] as keyof typeof cases]
    expect(landingPositions(graph, id(2)).commits.get(id(target)), row.join(' | ')).toEqual(expected)
  }
})

// @covers: delivery-outcomes › A result commit lands at its first containing position › Backdated bridge
test('Table L5a-L5c: prefix bounds distinguish no, unknown, and yes without inventing membership', () => {
  const graph = graphOf([[1, 100], [2, 50, 1, 4], [3, 200, 2], [4, 40, 1]])
  const landing = landingPositions(graph, id(3)).commits.get(id(4))!
  expect(landing).toEqual({ position: 2, at: 50, bound: 100 })
  const outcomes = { L5a: 'no', L5b: 'unknown', L5c: 'yes' } as const
  for (const row of TABLE_L.filter(row => row[0].startsWith('L5'))) {
    expect(containedBy(landing, Number(row[2])), row.join(' | ')).toBe(outcomes[row[0] as keyof typeof outcomes])
  }
  expect(intervalMembership(landing, 100, 150)).toBe('unknown')
  expect(intervalMembership(landing, 40, 150)).toBe('in')
})

test('Table L6 and L8a: old-dated bridges preserve later arrivals and direct graph identity', () => {
  const graph = graphOf([[1, 1000], [2, 10, 1], [3, 1100, 2, 4], [4, 1050, 1]])
  const positions = landingPositions(graph, id(3))
  const expected = { position: 3, at: 1100, bound: 1100 }
  for (const row of TABLE_L.filter(row => row[0] === 'L6' || row[0] === 'L8a')) {
    expect(resolveResultCommit({ ...context, commitRef: id(4), objectFormat: 'sha1',
      landings: positions.commits, checks: [] }), row.join(' | ')).toEqual({ kind: 'landed', sha: id(4), landing: expected })
    expect(containedBy(expected, 1200)).toBe('yes')
  }
})

// @covers: delivery-outcomes › A result commit lands at its first containing position › Boundary at the window end
// @covers: delivery-outcomes › A result commit lands at its first containing position › Backdated straddle
test('Table I1-I7: inclusive containment and half-open event membership', () => {
  const hour = 3_600_000
  const span = 7 * 24 * hour
  const end = 100 * 24 * hour
  const times = [
    [end - span], [end], [end - 2 * span], [end - 2 * span - 1],
    [end - span + hour, end - 3 * span], [end + hour, end - hour], [end + 1],
  ]
  for (const [index, row] of TABLE_I.entries()) {
    const chain = times[index]!
    const graph = graphOf(chain.map((at, i): [number, number, ...number[]] => i === 0 ? [i + 1, at] : [i + 1, at, i]))
    const landing = landingPositions(graph, id(chain.length)).commits.get(id(chain.length))!
    expect(intervalMembership(landing, end - span, end), row.join(' | ')).toBe(row[3])
    expect(intervalMembership(landing, end - 2 * span, end - span), row.join(' | ')).toBe(row[4])
    const containment = row[5].split(';')[0] as 'yes' | 'no' | 'unknown'
    expect(containedBy(landing, end), row.join(' | ')).toBe(containment)
    if (row[0] === 'I2') expect(intervalMembership(landing, end, end + span)).toBe('in')
  }
})

// @covers: delivery-outcomes › A result commit lands at its first containing position › Backdated straddle
test('I5: a contained backdated straddle has unknown membership in both adjacent windows', () => {
  const hour = 3_600_000
  const span = 7 * 24 * hour
  const end = 100 * 24 * hour
  const graph = graphOf([[1, end - span + hour], [2, end - 3 * span, 1]])
  const landing = landingPositions(graph, id(2)).commits.get(id(2))!
  expect(containedBy(landing, end)).toBe('yes')
  expect(intervalMembership(landing, end - span, end)).toBe('unknown')
  expect(intervalMembership(landing, end - 2 * span, end - span)).toBe('unknown')
})

test('invalid landing intervals and read ends fail closed as unknown', () => {
  for (const interval of [{ position: 1, at: NaN, bound: 1 }, { position: 1, at: 2, bound: 1 },
    { position: 1, at: 1, bound: Infinity }]) {
    expect(containedBy(interval, 3)).toBe('unknown')
    expect(intervalMembership(interval, 0, 3)).toBe('unknown')
  }
  const interval = { position: 1, at: 1, bound: 1 }
  expect(containedBy(interval, NaN)).toBe('unknown')
  for (const [from, end] of [[1, 1], [2, 1], [NaN, 2], [0, Infinity]]) {
    expect(intervalMembership(interval, from!, end!)).toBe('unknown')
  }
})

test('known pure history failures carry typed reasons, never arbitrary message classification', () => {
  for (const [run, reason] of [
    [() => commitTimeMs(0.5), 'history-malformed'],
    [() => commitTimeMs(Number.MAX_SAFE_INTEGER), 'history-malformed'],
    [() => landingPositions(graphOf([[1, 1, 1]]), id(1)), 'history-malformed'],
    [() => landingPositions(graphOf([[1, 1, 2]]), id(1)), 'history-incomplete'],
    [() => landingPositions(graphOf([[1, 1], [2, 2, 1, 3]]), id(2)), 'history-incomplete'],
    [() => landingPositions(graphOf([[1, NaN]]), id(1)), 'history-malformed'],
  ] as const) {
    try { run(); throw new Error('expected a typed history failure') }
    catch (error) {
      expect(error).toBeInstanceOf(DeliveryHistoryError)
      expect((error as DeliveryHistoryError).reason).toBe(reason)
    }
  }
  expect(new Error('history-malformed')).not.toBeInstanceOf(DeliveryHistoryError)
  expect(commitTimeMs(0)).toBe(0)
  expect(commitTimeMs(-1)).toBe(-1000)
})
