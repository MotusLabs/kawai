// The H completeness test (owner-publication-handoff task 7.3, design
// "Completeness claim"): every partition's full declared axis product, no
// tuple prefiltered — an empty reason set matches exactly one H row, a
// nonempty one matches none and is kept whole as one excluded
// classification. Also: H-PUB's 140 tuples (32 healthy, 108 excluded) with
// their row multiplicities, the paired witnesses of H-PUB and H-RESTART,
// H29's tolerated (stale, current) tuple reported apart, the DF fixtures'
// reason sets, and the U fact-to-observation table (each claim reads only
// its partition's declared observations), and H-DRAFT's load, save and
// rebase, and publish products with U7 kept whole over the stored linked
// draft and the publish command's submitted base observed apart from it
// (the WS row tests in taskHandoffDrafts.test.ts drive each row; the paired
// submitted-base witnesses are taskHandoffDraftBase.test.ts).
import { describe, expect, test } from 'bun:test'
import { schemaCopy } from './schemaDb'
import {
  H_DRAFT_LOAD, H_DRAFT_PUBLISH, H_DRAFT_SAVE, H_PUB, H_RESTART, PARTITIONS, classify, observeDraft, observePublish, product, type Partition, type Reason, type Tuple,
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

const tally = (partition: Partition) => product(partition).map(tuple => classify(partition, tuple)).reduce<Record<string, number>>((counts, result) => {
  const key = result.kind === 'healthy' ? result.row : result.kind === 'excluded' ? `excluded ${result.reasons.join('+')}` : result.kind
  return { ...counts, [key]: (counts[key] ?? 0) + 1 }
}, {})

describe('H-DRAFT', () => {
  test('load: 56 tuples, all healthy; H36 28, H37 24, H18 1, H19 3', () => {
    expect(tally(H_DRAFT_LOAD)).toEqual({ H36: 28, H37: 24, H18: 1, H19: 3 })
  })

  test('save and rebase: 336 tuples, 144 healthy and 192 excluded {U7}; H43 96, H42 24, H41 24', () => {
    expect(tally(H_DRAFT_SAVE)).toEqual({ H43: 96, H42: 24, H41: 24, 'excluded U7': 192 })
  })

  test('publish: 24192 tuples, 10368 healthy and 13824 excluded {U7}, the submitted base apart from the stored one, every row in check order', () => {
    expect(product(H_DRAFT_PUBLISH)).toHaveLength(24192)
    expect(tally(H_DRAFT_PUBLISH)).toEqual({
      H33d: 2592, H33: 2592, 'T-rationale': 2592, 'T-right': 1296, H17r: 216, 'T-replay': 216, H17m: 216, 'T-mismatch': 216,
      H43: 144, H38m: 48, H38s: 14, H17: 2, H38: 8, 'T-stale': 144, H44: 72, 'excluded U7': 13824,
    })
  })

  test('the submitted base against the stored one: an ordinary write compares it with the task, a linked write with the stored draft, then the stored draft with the task', () => {
    const write = { key: 'ordinary', raw: 'bare', rationale: 'given', right: 'ok', replay: 'new', observed: 'stored', draftBase: 'same', state: 'stale' }
    // The paired snapshot: H stale, its linked draft at r1, the task at r2 — the same stored facts under every submitted base.
    const at = (intent: string, submitted: string) => classify(H_DRAFT_PUBLISH, { ...write, draftRevision: 'behind', intent, submitted })
    expect(['r1', 'r2', 'r3'].map(submitted => [submitted, at('ordinary', submitted), at('draft', submitted)])).toEqual([
      ['r1', { kind: 'healthy', row: 'T-stale' }, { kind: 'healthy', row: 'H38s' }],
      ['r2', { kind: 'healthy', row: 'H44' }, { kind: 'healthy', row: 'H38m' }],
      ['r3', { kind: 'healthy', row: 'T-stale' }, { kind: 'healthy', row: 'H38m' }],
    ])
    // A current linked draft: matching both bases reaches the linked state; any other base is the stored-base mismatch.
    const current = (submitted: string, state: string) => classify(H_DRAFT_PUBLISH, { ...write, draftRevision: 'current', intent: 'draft', submitted, state })
    expect([current('r2', 'open'), current('r2', 'declined'), current('r1', 'open'), current('r3', 'declined')]).toEqual([
      { kind: 'healthy', row: 'H17' }, { kind: 'healthy', row: 'H38' }, { kind: 'healthy', row: 'H38m' }, { kind: 'healthy', row: 'H38m' },
    ])
    // U7 reads the stored facts alone: no submitted base makes an excluded tuple a row.
    for (const submitted of ['r1', 'r2', 'r3']) expect(current(submitted, 'stale')).toEqual({ kind: 'excluded', reasons: ['U7'] })
  })

  test('U7 witnesses: a linked draft off its handoff\'s base, or current while H is stale or published, is excluded under every command; the legal neighbours are rows', () => {
    const save = { command: 'save', observed: 'stored', base: 'unchanged' }
    const publish = { key: 'ordinary', raw: 'bare', intent: 'draft', rationale: 'given', right: 'ok', replay: 'new', observed: 'stored', submitted: 'r2' }
    for (const link of [
      { draftBase: 'differs', draftRevision: 'current', state: 'open' }, { draftBase: 'same', draftRevision: 'current', state: 'stale' },
      { draftBase: 'same', draftRevision: 'current', state: 'published' }, { draftBase: 'differs', draftRevision: 'behind', state: 'published' },
    ]) {
      expect([link, classify(H_DRAFT_SAVE, { ...save, ...link })]).toEqual([link, { kind: 'excluded', reasons: ['U7'] }])
      // Even the reserved prefix, checked first, is not a row for an excluded tuple: the reason is kept, never shadowed.
      for (const key of ['ordinary', 'reserved']) expect([link, key, classify(H_DRAFT_PUBLISH, { ...publish, ...link, key })]).toEqual([link, key, { kind: 'excluded', reasons: ['U7'] }])
    }
    expect(classify(H_DRAFT_SAVE, { ...save, draftBase: 'same', draftRevision: 'behind', state: 'stale' })).toEqual({ kind: 'healthy', row: 'H41' })
    expect(classify(H_DRAFT_PUBLISH, { ...publish, draftBase: 'same', draftRevision: 'current', state: 'open' })).toEqual({ kind: 'healthy', row: 'H17' })
    expect(classify(H_DRAFT_PUBLISH, { ...publish, draftBase: 'same', draftRevision: 'behind', state: 'published', submitted: 'r1' })).toEqual({ kind: 'healthy', row: 'H38s' })
    expect(classify(H_DRAFT_PUBLISH, { ...publish, draftBase: 'same', draftRevision: 'current', state: 'declined' })).toEqual({ kind: 'healthy', row: 'H38' })
  })

  test('precedence: the reserved prefix before the rationale and right checks, the replay before the identity, the identity before the base', () => {
    const legal = { raw: 'padded', draftBase: 'same', draftRevision: 'behind', state: 'stale', submitted: 'r1' }
    const at = (axes: Tuple) => classify(H_DRAFT_PUBLISH, { ...legal, key: 'ordinary', intent: 'draft', rationale: 'given', right: 'ok', replay: 'new', observed: 'stored', ...axes })
    expect(at({ key: 'reserved', rationale: 'missing', right: 'missing', observed: 'other' })).toEqual({ kind: 'healthy', row: 'H33d' })
    expect(at({ rationale: 'missing', right: 'missing' })).toEqual({ kind: 'healthy', row: 'T-rationale' })
    expect(at({ replay: 'same', observed: 'none' })).toEqual({ kind: 'healthy', row: 'H17r' })
    expect(at({ replay: 'different', observed: 'other' })).toEqual({ kind: 'healthy', row: 'H17m' })
    expect(at({ observed: 'other' })).toEqual({ kind: 'healthy', row: 'H43' })
    expect(at({ observed: 'other', submitted: 'r2' })).toEqual({ kind: 'healthy', row: 'H43' })
    expect(at({ submitted: 'r2' })).toEqual({ kind: 'healthy', row: 'H38m' })
    expect(at({})).toEqual({ kind: 'healthy', row: 'H38s' })
    expect(at({ intent: 'ordinary', observed: 'other' })).toEqual({ kind: 'healthy', row: 'T-stale' })
    expect(classify(H_DRAFT_SAVE, { command: 'rebase', observed: 'none', base: 'moved', ...legal })).toEqual({ kind: 'healthy', row: 'H43' })
  })

  test('the observation reads the stored linked draft, its handoff and the task revision from one snapshot', () => {
    const db = schemaCopy()
    try {
      const seed = (task: string, revision: number, handoff: { base: number; state: string } | null, draft: { base: number; link: boolean } | null) => {
        db.prepare("INSERT INTO team_tasks (id, team_id, title, status, creator_kind, revision, created_at, updated_at) VALUES (?, 't', 'x', 'open', 'human', ?, 'now', 'now')").run(task, revision)
        if (handoff) {
          db.prepare(`INSERT INTO team_task_handoffs (id, team_id, task_id, base_revision, rationale, notify, payload_hash, evidence_refs, requester_session, request_key, state, created_at, updated_at)
            VALUES (?, 't', ?, ?, 'r', 0, 'h', '[]', 'lead', 'k', ?, 'now', 'now')`).run(`h-${task}`, task, handoff.base, handoff.state)
        }
        if (draft) {
          db.prepare("INSERT INTO team_task_drafts (task_id, base_revision, direction, updated_at, handoff_id, lineage_id) VALUES (?, ?, 'd', 'now', ?, ?)")
            .run(task, draft.base, draft.link ? `h-${task}` : null, draft.link ? 'lineage' : null)
        }
      }
      seed('loaded', 1, { base: 1, state: 'open' }, { base: 1, link: true })
      seed('overtaken', 2, { base: 1, state: 'stale' }, { base: 1, link: true })
      seed('fulfilled', 2, { base: 1, state: 'published' }, { base: 1, link: true })
      seed('plain', 1, { base: 1, state: 'open' }, { base: 1, link: false })
      seed('off-base', 2, { base: 1, state: 'open' }, { base: 2, link: true })
      seed('current-stale', 2, { base: 2, state: 'stale' }, { base: 2, link: true })
      const save = { command: 'save', observed: 'stored', base: 'unchanged' }
      const of = (task: string) => { const observed = observeDraft(db, task); return observed && classify(H_DRAFT_SAVE, { ...save, ...observed }) }
      expect(['loaded', 'overtaken', 'fulfilled', 'plain', 'off-base', 'current-stale'].map(of)).toEqual([
        { kind: 'healthy', row: 'H41' }, { kind: 'healthy', row: 'H41' }, { kind: 'healthy', row: 'H41' }, null,
        { kind: 'excluded', reasons: ['U7'] }, { kind: 'excluded', reasons: ['U7'] },
      ])
    } finally {
      db.close()
    }
  })
})
