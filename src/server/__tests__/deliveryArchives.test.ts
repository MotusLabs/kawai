// C1-C5 over real, owned Git history. C6 and production reader/argv behavior
// belong to the separately held1.2 phase, not this pure parse checkpoint.
import { expect, test } from 'bun:test'
import { changeLandings, landingPositions } from '../metrics/delivery/landing'
import { DeliveryRepo, FIXTURE_EPOCH } from './fixtures/deliveryRepo'
import { TABLE_C } from './fixtures/deliveryOracleRows'

function archiveHistory() {
  const repo = new DeliveryRepo()
  const root = repo.commit('Fixture root', 0)
  repo.git('switch', '-q', '-c', 'archive-feature')
  repo.write('openspec/changes/archive/2026-10-02-merged/proposal.md')
  repo.commit('Fixture archive feature', 13 * 3600)
  repo.git('switch', '-q', 'main')
  repo.merge('archive-feature', 14 * 3600)
  repo.write('openspec/changes/archive/2026-10-02-direct/proposal.md')
  repo.write('openspec/changes/archive/2026-10-02-repeated/proposal.md')
  repo.commit('Fixture direct archive', 15 * 3600)
  repo.write('openspec/changes/archive/2026-11-02-repeated/proposal.md')
  repo.commit('Fixture rearchive under another date', 16 * 3600)
  const deletedPath = 'openspec/changes/archive/2026-10-02-deleted/proposal.md'
  repo.write(deletedPath)
  repo.commit('Fixture archive before deletion', 17 * 3600)
  repo.git('rm', '--', deletedPath)
  const head = repo.commit('Fixture delete archive', 18 * 3600)
  repo.git('switch', '-q', '-c', 'unmerged-archive', root)
  repo.write('openspec/changes/archive/2026-10-02-unmerged/proposal.md')
  const unmerged = repo.commit('Fixture unmerged archive', 20 * 3600)
  repo.git('switch', '-q', 'main')
  return { repo, head, unmerged }
}

// @covers: delivery-outcomes › A change lands when its archive directory reaches the default branch › Archive merged
// @covers: delivery-outcomes › A change lands when its archive directory reaches the default branch › Archive on a branch only
test('Table C1-C5: real Git archives land at their first arrival even after rearchive or deletion', () => {
  const fixture = archiveHistory()
  try {
    const { graph, archives } = fixture.repo.snapshot(fixture.head)
    const positions = landingPositions(graph, fixture.head)
    const parsed = changeLandings(archives, positions, 'sha1')
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) throw new Error(parsed.reason)
    const cases = {
      C1: { name: 'merged', position: 2, seconds: 14 * 3600 },
      C2: { name: 'direct', position: 3, seconds: 15 * 3600 },
      C3: { name: 'repeated', position: 3, seconds: 15 * 3600 },
      C4: { name: 'unmerged', position: 0, seconds: 0 },
      C5: { name: 'deleted', position: 5, seconds: 17 * 3600 },
    }
    expect(TABLE_C.map(row => row[0])).toEqual(['C1', 'C2', 'C3', 'C4', 'C5'])
    for (const row of TABLE_C) {
      const { name, position, seconds } = cases[row[0] as keyof typeof cases]
      const at = FIXTURE_EPOCH + seconds * 1000
      expect(parsed.changes.get(name), row.join(' | ')).toEqual(position === 0 ? undefined : { position, at, bound: at })
    }
    expect(parsed.changes.size).toBe(4)
    expect(graph.has(fixture.unmerged)).toBe(false)
    expect(fixture.repo.git('ls-tree', '-r', '--name-only', fixture.head)).not.toContain('/deleted/')
    expect(archives.indexOf('2026-11-02-repeated')).toBeLessThan(archives.indexOf('2026-10-02-repeated'))
    // Reordering complete real log records must not change the first arrival.
    const records = archives.split(/(?=^@)/m).filter(record => record !== '')
    expect(changeLandings([...records].reverse().join(''), positions, 'sha1')).toEqual(parsed)
  } finally { fixture.repo.dispose() }
})

test('archive grammar is one date-name segment and every malformed record fails the whole parse', () => {
  const fixture = archiveHistory()
  try {
    const { graph, archives } = fixture.repo.snapshot(fixture.head)
    const positions = landingPositions(graph, fixture.head)
    for (const path of [
      'openspec/changes/archive/2026-10-02-example/nested/proposal.md',
      'openspec/changes/archive/2026-10-02-/proposal.md',
      'openspec/changes/archive/2026-10-02-Capital/proposal.md',
      'openspec/changes/archive/2026-10-02-under_score/proposal.md',
      'openspec/changes/archive/2026-10-02-example/design.md', 'stray/proposal.md',
      'openspec/changes/archive/2026-10-02-example/proposal.md\u2028',
    ]) expect(changeLandings(`${archives}@${fixture.head}\n${path}\n`, positions, 'sha1'))
      .toEqual({ ok: false, reason: 'archive-malformed' })
    expect(changeLandings(`${archives}@${fixture.head}\nopenspec/changes/archive/2026-10-02-example/proposal.md\r`, positions, 'sha1'))
      .toEqual({ ok: false, reason: 'archive-malformed' })
    expect(changeLandings(`@${fixture.unmerged}\n`, positions, 'sha1')).toEqual({ ok: false, reason: 'archive-malformed' })
    expect(changeLandings('openspec/changes/archive/2026-10-02-orphan/proposal.md\n', positions, 'sha1'))
      .toEqual({ ok: false, reason: 'archive-malformed' })
    const crlf = changeLandings(archives.replace(/\n/g, '\r\n'), positions, 'sha1')
    expect(crlf.ok).toBe(true)
    if (crlf.ok) {
      expect(crlf.changes.size).toBe(4)
      expect(crlf.changes.get('repeated')).toEqual({ position: 3,
        at: FIXTURE_EPOCH + 15 * 3600_000, bound: FIXTURE_EPOCH + 15 * 3600_000 })
    }
    // Calendar validity is not arrival evidence: the binding grammar is text.
    expect(changeLandings(`@${fixture.head}\nopenspec/changes/archive/9999-99-99-text-only/proposal.md\n`, positions, 'sha1'))
      .toEqual({ ok: true, changes: new Map([['text-only', { position: 6,
        at: FIXTURE_EPOCH + 18 * 3600_000, bound: FIXTURE_EPOCH + 18 * 3600_000 }]]) })
  } finally { fixture.repo.dispose() }
})
