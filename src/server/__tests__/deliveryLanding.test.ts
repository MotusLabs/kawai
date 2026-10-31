// First1.1 observable checkpoint; full L/I/C and seeded property expansion
// follows the named adviser checkpoint. No production Git reader is activated.
import { expect, test } from 'bun:test'
import {
  changeLandings, containedBy, intervalMembership, landingPositions, resolveResultCommit,
} from '../metrics/delivery/landing'
import { FIXTURE_EPOCH, mergeArchiveFixture } from './fixtures/deliveryRepo'

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
