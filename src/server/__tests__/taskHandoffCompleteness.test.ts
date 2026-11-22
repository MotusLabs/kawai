// The H completeness test (owner-publication-handoff task 7.3, design
// "Completeness claim"): every partition's full declared axis product, no
// tuple prefiltered — an empty reason set matches exactly one H row, a
// nonempty one matches none and is kept whole as one excluded
// classification. Also: H-PUB's 140 tuples (32 healthy, 108 excluded) with
// their row multiplicities, the paired witnesses of H-PUB and H-RESTART,
// H29's tolerated (stale, current) tuple reported apart, the DF fixtures'
// reason sets, and the U fact-to-observation table (each claim reads only
// its partition's declared observations). H-DRAFT's rows join with the
// draft wave (tasks 4.1's H-DRAFT half), which has not landed yet.
import { describe, expect, test } from 'bun:test'
import { schemaCopy } from './schemaDb'
import {
  H_PUB, H_RESTART, PARTITIONS, classify, observePublish, product, type Reason, type Tuple,
} from './helpers/handoffClassifier'
import { preparedKey } from '../../shared/taskHandoffs'

const restart = (associationPresent: boolean, orphan: boolean, status: 'open' | 'closed', base: 'current' | 'behind', state: 'open' | 'stale'): Tuple =>
  ({ associationPresent: String(associationPresent), unassociatedReservedKeyPresent: String(orphan), status, base, state })

describe('every partition', () => {
  for (const partition of PARTITIONS) {
    test(`${partition.name}: each tuple of the full product is exactly one row or one excluded classification`, () => {
      const tuples = product(partition)
      expect(tuples.length).toBe(Object.values(partition.axes).reduce((count, values) => count * values.length, 1))
      const bad = tuples.map(tuple => ({ tuple, result: classify(partition, tuple) })).filter(({ result }) => result.kind === 'gap' || result.kind === 'overlap')
      expect(bad).toEqual([])
      // Every row is reachable.
      const used = new Set(tuples.map(tuple => classify(partition, tuple)).flatMap(result => (result.kind === 'healthy' ? [result.row] : [])))
      expect([...used].sort()).toEqual(partition.rows.map(row => row.id).sort())
    })
  }

  test('the U fact-to-observation table: each claim is computed only from the observations it declares', () => {
    for (const partition of PARTITIONS) {
      for (const claim of partition.claims) {
        for (const tuple of product(partition)) {
          for (const [axis, values] of Object.entries(partition.axes)) {
            if (claim.reads.includes(axis)) continue
            for (const value of values) expect([partition.name, claim.id, axis, claim.holds({ ...tuple, [axis]: value })]).toEqual([partition.name, claim.id, axis, claim.holds(tuple)])
          }
        }
      }
    }
  })
})

describe('H-PUB', () => {
  test('140 tuples: 32 healthy, 108 excluded; H13 16, H35 8, H14 1, H12 1, H15 5, H16b 1', () => {
    const results = product(H_PUB).map(tuple => classify(H_PUB, tuple))
    expect(results).toHaveLength(140)
    const healthy = results.flatMap(result => (result.kind === 'healthy' ? [result.row] : []))
    expect(healthy).toHaveLength(32)
    expect(results.filter(result => result.kind === 'excluded')).toHaveLength(108)
    const counts = Object.fromEntries(H_PUB.rows.map(row => [row.id, healthy.filter(id => id === row.id).length]))
    expect(counts).toEqual({ H13: 16, H35: 8, H14: 1, H12: 1, H15: 5, H16b: 1 })
  })

  test('paired witnesses: R3/R0 published, R2 published, R0 open, R1 open, R4 published, R3 and R4 open', () => {
    const caller = { right: 'ok', extras: 'none' }
    expect(classify(H_PUB, { revisionFacts: 'R3', ...caller, state: 'published' })).toEqual({ kind: 'healthy', row: 'H16b' })
    expect(classify(H_PUB, { revisionFacts: 'R0', ...caller, state: 'published' })).toEqual({ kind: 'excluded', reasons: ['U1'] })
    expect(classify(H_PUB, { revisionFacts: 'R2', ...caller, state: 'published' })).toEqual({ kind: 'healthy', row: 'H14' })
    expect(classify(H_PUB, { revisionFacts: 'R0', ...caller, state: 'open' })).toEqual({ kind: 'healthy', row: 'H12' })
    expect(classify(H_PUB, { revisionFacts: 'R1', ...caller, state: 'open' })).toEqual({ kind: 'excluded', reasons: ['U6'] })
    expect(classify(H_PUB, { revisionFacts: 'R4', ...caller, state: 'published' })).toEqual({ kind: 'excluded', reasons: ['U6'] })
    expect(classify(H_PUB, { revisionFacts: 'R3', ...caller, state: 'open' })).toEqual({ kind: 'excluded', reasons: ['U1'] })
    expect(classify(H_PUB, { revisionFacts: 'R4', ...caller, state: 'open' })).toEqual({ kind: 'excluded', reasons: ['U1', 'U6'] })
  })

  test('the observation reads the task-scoped association, not the prepared-key row: R3 and R0 published stay apart', () => {
    const db = schemaCopy()
    try {
      const seed = (task: string, handoff: string, revisions: Array<[number, string | null, string | null]>) => {
        db.prepare("INSERT INTO team_tasks (id, team_id, title, status, creator_kind, revision, created_at, updated_at) VALUES (?, 't', 'x', 'open', 'human', ?, 'now', 'now')").run(task, revisions.length)
        for (const [revision, key, link] of revisions) {
          db.prepare("INSERT INTO team_task_revisions (task_id, revision, direction, author_kind, created_at, request_key, handoff_id) VALUES (?, ?, 'd', 'human', 'now', ?, ?)").run(task, revision, key, link)
        }
        db.prepare(`INSERT INTO team_task_handoffs (id, team_id, task_id, base_revision, rationale, notify, payload_hash, evidence_refs, requester_session, request_key, state, created_at, updated_at)
          VALUES (?, 't', ?, 1, 'r', 0, 'h', '[]', 'lead', 'k', 'published', 'now', 'now')`).run(handoff, task)
      }
      seed('task-r3', 'handoff-r3', [[1, null, null], [2, 'ordinary', 'handoff-r3']])
      seed('task-r0', 'handoff-r0', [[1, null, null], [2, 'ordinary', null]])
      seed('task-r4', 'handoff-r4', [[1, null, null], [2, 'ordinary', 'handoff-r4'], [3, preparedKey('handoff-r4'), null]])
      const caller = { right: 'ok' as const, extras: 'none' as const }
      expect(classify(H_PUB, observePublish(db, 'handoff-r3', caller))).toEqual({ kind: 'healthy', row: 'H16b' })
      expect(classify(H_PUB, observePublish(db, 'handoff-r0', caller))).toEqual({ kind: 'excluded', reasons: ['U1'] })
      expect(classify(H_PUB, observePublish(db, 'handoff-r4', caller))).toEqual({ kind: 'excluded', reasons: ['U6'] })
    } finally {
      db.close()
    }
  })
})

describe('H-RESTART', () => {
  test("H29 holds three tuples; the tolerated (stale, current) one is reported apart", () => {
    const healthy = product(H_RESTART).map(tuple => ({ tuple, result: classify(H_RESTART, tuple) })).filter(({ result }) => result.kind === 'healthy')
    expect(healthy.map(({ tuple, result }) => [tuple.state, tuple.base, result.kind === 'healthy' && result.tolerated === true])).toEqual([
      ['open', 'current', false], ['stale', 'current', true], ['stale', 'behind', false],
    ])
  })

  test('paired witnesses (1) and (2): both revision facts false is exactly H29; the orphan alone is {U6} with no row', () => {
    expect(classify(H_RESTART, restart(false, false, 'open', 'current', 'open'))).toEqual({ kind: 'healthy', row: 'H29' })
    expect(classify(H_RESTART, restart(false, true, 'open', 'current', 'open'))).toEqual({ kind: 'excluded', reasons: ['U6'] })
  })

  test('the DF fixtures classify excluded with their complete reason sets', () => {
    const cases: Array<[string, Tuple, string[]]> = [
      ['DF1', restart(true, false, 'open', 'current', 'open'), ['U1']],
      ['DF2', restart(false, false, 'closed', 'current', 'open'), ['U5']],
      ['DF3', restart(false, false, 'open', 'behind', 'open'), ['U3']],
      ['DF4a', restart(false, true, 'open', 'current', 'open'), ['U6']],
      ['DF4b', restart(false, true, 'open', 'behind', 'open'), ['U3', 'U6']],
      ['DF4b after its first restart', restart(false, true, 'open', 'behind', 'stale'), ['U6']],
      ['DF5', restart(true, false, 'closed', 'behind', 'open'), ['U1', 'U3', 'U5']],
      ['DF5o', restart(true, true, 'closed', 'behind', 'open'), ['U1', 'U3', 'U5', 'U6']],
    ]
    for (const [id, tuple, reasons] of cases) expect({ id, result: classify(H_RESTART, tuple) }).toEqual({ id, result: { kind: 'excluded', reasons: reasons as Reason[] } })
  })
})
