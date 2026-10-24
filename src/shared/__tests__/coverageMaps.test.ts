// Coverage map validation (independent-verification D5, task 3.1): D5's
// limits and the `` `path` › `title` `` citation grammar, every refusal
// naming its 1-based clause index, and the normalization the comparison
// matches by (D6). Table-driven over the validator so each limit and each
// malformed shape is one row.
import { describe, expect, test } from 'bun:test'
import {
  CITATION_OUTCOMES, COVERAGE_LIMITS, clauseStatus, compareCoverageMaps, isSealed, normalizeCitation, normalizeClause,
  parseCitation, validateCoverageMap, withheldCoverage,
} from '../coverageMaps'

const clause = (text: string, tests: string[] = []) => ({ clause: text, tests })

describe('parseCitation', () => {
  test('the grammar: backticked path and title around ` › `', () => {
    expect(parseCitation('`src/a.test.ts` › `covers the thing`')).toEqual({ path: 'src/a.test.ts', title: 'covers the thing' })
    expect(parseCitation('  `a.test.ts` › `it works`  ')).toEqual({ path: 'a.test.ts', title: 'it works' })
  })

  test('malformed forms read null: unquoted sides, other separators, nested backticks, empties', () => {
    for (const malformed of [
      'src/a.test.ts › title',
      '`src/a.test.ts` > `title`',
      '`src/a.test.ts`›`title`',
      '`sr`c`.test.ts` › `title`',
      '`src/a.test.ts` › `ti`tle`',
      '` › `title`',
      '`src/a.test.ts` › ``',
      'just text',
      '',
    ]) {
      expect(parseCitation(malformed)).toBeNull()
    }
  })
})

describe('validateCoverageMap', () => {
  test('a valid map round-trips, notes included', () => {
    const map = [
      clause('task-results › Results carry a coverage map › Citation resolves and ran', ['`src/a.test.ts` › `ran`']),
      { clause: '2.1 Verify', tests: [], note: 'covered by the review instead' },
    ]
    expect(validateCoverageMap(map)).toEqual(map)
  })

  test('input that is not a clause list refuses without a clause index', () => {
    for (const bad of [undefined, null, 'map', 42, { clause: 'x' }]) {
      expect(() => validateCoverageMap(bad)).toThrow(/coverage must be a list of clauses/)
    }
  })

  test('each limit refuses at its boundary, naming the clause', () => {
    const many = Array.from({ length: COVERAGE_LIMITS.maxClauses + 1 }, () => clause('x'))
    expect(() => validateCoverageMap(many)).toThrow(/coverage holds 201 clauses; at most 200 are allowed/)

    const long = clause('x'.repeat(COVERAGE_LIMITS.maxClauseLength + 1))
    expect(() => validateCoverageMap([clause('ok'), long])).toThrow(/coverage clause 2 is 501 characters/)

    const cited = clause('x', Array.from({ length: COVERAGE_LIMITS.maxCitations + 1 }, (_, i) => `\`f${i}.ts\` › \`t\``))
    expect(() => validateCoverageMap([cited])).toThrow(/coverage clause 1 cites 11 tests; at most 10 are allowed/)

    expect(() => validateCoverageMap([{ clause: 'x', tests: [], note: 'n'.repeat(COVERAGE_LIMITS.maxNoteLength + 1) }]))
      .toThrow(/coverage clause 1's note must be a string of at most 500 characters/)
  })

  test('at the exact limits the map is accepted', () => {
    const atLimit = Array.from({ length: COVERAGE_LIMITS.maxClauses }, (_, i) =>
      clause(`c${i}`, Array.from({ length: COVERAGE_LIMITS.maxCitations }, (_, j) => `\`f${i}-${j}.ts\` › \`t\``)))
    expect(validateCoverageMap(atLimit)).toHaveLength(COVERAGE_LIMITS.maxClauses)
  })

  test('a malformed citation refuses naming its clause index', () => {
    expect(() => validateCoverageMap([clause('ok'), clause('bad', ['src/a.test.ts › title'])]))
      .toThrow(/coverage clause 2: "src\/a.test.ts › title" is not a citation/)
    expect(() => validateCoverageMap([{ clause: 'bad', tests: [42] }]))
      .toThrow(/coverage clause 1: 42 is not a citation/)
    expect(() => validateCoverageMap([{ clause: 'x', tests: '`f.ts` › `t`' }]))
      .toThrow(/coverage clause 1 needs a list of citations/)
  })

  test('a clause that is not an object, or has no text, refuses naming the clause', () => {
    expect(() => validateCoverageMap(['clause', clause('ok')])).toThrow(/coverage clause 1 must be an object/)
    expect(() => validateCoverageMap([clause('ok'), { tests: [] }])).toThrow(/coverage clause 2 needs a non-empty clause/)
    expect(() => validateCoverageMap([clause('   ')])).toThrow(/coverage clause 1 needs a non-empty clause/)
    expect(() => validateCoverageMap([{ clause: 'x', tests: [], note: 7 }])).toThrow(/coverage clause 1's note/)
  })
})

describe('normalization (D6)', () => {
  test('clauses match trimmed, whitespace-collapsed, backtick-dropped, case-folded', () => {
    expect(normalizeClause('  Results  carry\tTHE map  ')).toBe('results carry the map')
    expect(normalizeClause('results carry the map')).toBe(normalizeClause('  Results  carry\tTHE map  '))
    expect(normalizeClause('`2.1` Verify')).toBe(normalizeClause('2.1 verify'))
  })

  test('citations match by normalized path and title', () => {
    expect(normalizeCitation({ path: ' Src/A.test.ts ', title: '  It   WORKS ' }))
      .toBe(normalizeCitation({ path: 'src/a.test.ts', title: 'it works' }))
  })

  test('whitespace padding inside the backticks is refused, not stored', () => {
    expect(parseCitation('`path ` › `t`')).toBeNull()
    expect(parseCitation('`path` › ` t`')).toBeNull()
    expect(parseCitation('` p` › `t`')).toBeNull()
    expect(parseCitation('`a b` › `c d`')).toEqual({ path: 'a b', title: 'c d' })
  })
})

describe('clauseStatus (D5 six rows, first match)', () => {
  test('the outcome enum is exactly D5\'s six values', () => {
    const D5_OUTCOMES = ['ran-passed', 'not-found', 'not-run', 'not-in-run', 'run-unknown', 'unresolved'] as const
    expect([...CITATION_OUTCOMES].sort()).toEqual([...D5_OUTCOMES].sort())
  })

  test('the table, row by row', () => {
    // Row 1: cites nothing — declared uncovered whatever else holds.
    expect(clauseStatus(0, null, false)).toBe('declared-uncovered')
    expect(clauseStatus(0, [], false)).toBe('declared-uncovered')
    // Row 2: unresolved reads the cause (no resolved commit), never the outcomes.
    expect(clauseStatus(1, null, false)).toBe(null)
    expect(clauseStatus(1, ['unresolved'], false)).toBe('unresolved')
    expect(clauseStatus(2, ['unresolved', 'unresolved'], false)).toBe('unresolved')
    // Row 3: covered.
    expect(clauseStatus(1, ['ran-passed'], true)).toBe('covered')
    expect(clauseStatus(3, ['ran-passed', 'ran-passed', 'ran-passed'], true)).toBe('covered')
    // Row 4: covered, run unknown — no usable list.
    expect(clauseStatus(1, ['run-unknown'], true)).toBe('covered-run-unknown')
    // Row 5: partly covered.
    expect(clauseStatus(2, ['ran-passed', 'not-found'], true)).toBe('partly-covered')
    expect(clauseStatus(2, ['run-unknown', 'not-in-run'], true)).toBe('partly-covered')
    // Row 6: not covered.
    expect(clauseStatus(1, ['not-found'], true)).toBe('not-covered')
    expect(clauseStatus(2, ['not-run', 'not-in-run'], true)).toBe('not-covered')
  })

  test('no recorded outcomes leaves no status beyond declared-uncovered', () => {
    expect(clauseStatus(2, null, true)).toBe(null)
  })

  test('rows 3 and 4 are exact: a mixed good-good clause is unreachable and falls through to not covered', () => {
    // D5: a tree either has a usable list or has none, so a clause never
    // mixes ran-and-passed with found-run-unknown. The fallthrough reads
    // not-covered — never a covered row on a non-exact match.
    expect(clauseStatus(2, ['ran-passed', 'run-unknown'], true)).toBe('not-covered')
  })
})

describe('isSealed (D6/J3)', () => {
  const review = { handoffKind: 'review', resultId: 'R', targetKind: 'session' as const, targetId: 'S', claimedBy: null }
  const groupReview = { handoffKind: 'review', resultId: 'R', targetKind: 'group' as const, targetId: 'reviewers', claimedBy: 'S' }

  test('sealed: the session target or the claimant of the outstanding review handoff, with no map row for R', () => {
    expect(isSealed(review, 'S', false)).toBe(true)
    expect(isSealed(groupReview, 'S', false)).toBe(true)
  })

  test('not sealed: a third session, a map row already recorded for R, or no assignment', () => {
    expect(isSealed(review, 'other', false)).toBe(false)
    expect(isSealed(review, 'S', true)).toBe(false)
    expect(isSealed(groupReview, 'S', true)).toBe(false)
    expect(isSealed(null, 'S', false)).toBe(false)
  })

  test('not sealed: other handoff kinds, a resultless row, or an unclaimed group handoff', () => {
    expect(isSealed({ ...review, handoffKind: 'qa' }, 'S', false)).toBe(false)
    expect(isSealed({ ...review, handoffKind: 'fix' }, 'S', false)).toBe(false)
    expect(isSealed({ ...review, resultId: null }, 'S', false)).toBe(false)
    expect(isSealed({ ...groupReview, claimedBy: null }, 'S', false)).toBe(false)
  })
})

describe('withheldCoverage', () => {
  test('a mapped result withholds with its clause count; an unmapped one reads null', () => {
    expect(withheldCoverage([clause('a'), clause('b', ['`f.ts` › `t`'])])).toEqual({ withheld: true, clauses: 2 })
    expect(withheldCoverage(null)).toBeNull()
  })
})

describe('compareCoverageMaps (D6)', () => {
  const submitter = [
    clause('Alpha covers the thing', ['`a.test.ts` › `one`', '`a.test.ts` › `two`']),
    clause('Beta only the submitter names', ['`b.test.ts` › `three`']),
    clause('Gamma declared uncovered'),
  ]
  const reviewer = [
    clause('  alpha  covers  THE thing ', ['`a.test.ts` › `one`', '`c.test.ts` › `four`']),
    clause('delta only the reviewer names', ['`d.test.ts` › `five`']),
    clause('gamma declared UNCOVERED', ['`g.test.ts` › `six`']),
  ]

  test('the three kinds of difference, matched by normalized text', () => {
    const comparison = compareCoverageMaps(submitter, reviewer)!
    expect(comparison.onlySubmitter).toEqual(['Beta only the submitter names'])
    expect(comparison.onlyReviewer).toEqual(['delta only the reviewer names'])
    expect(comparison.differingCitations).toEqual([
      { clause: 'Alpha covers the thing', onlySubmitter: ['a.test.ts › two'], onlyReviewer: ['c.test.ts › four'] },
      { clause: 'Gamma declared uncovered', onlySubmitter: [], onlyReviewer: ['g.test.ts › six'] },
    ])
    expect(comparison.uncoveredDisputes).toEqual(['Gamma declared uncovered'])
  })

  test('null while either side has no map', () => {
    expect(compareCoverageMaps(null, reviewer)).toBeNull()
    expect(compareCoverageMaps(submitter, null)).toBeNull()
  })

  test('identical maps compare empty', () => {
    const comparison = compareCoverageMaps(submitter, submitter)!
    expect(comparison).toEqual({ onlySubmitter: [], onlyReviewer: [], differingCitations: [], uncoveredDisputes: [] })
  })

  test('duplicate clause texts union their citations under the first-seen text', () => {
    const withDuplicate = [clause('Same clause', ['`a.test.ts` › `one`']), clause('Same clause', ['`z.test.ts` › `nine`'])]
    const other = [clause('same CLAUSE', ['`a.test.ts` › `one`'])]
    const comparison = compareCoverageMaps(withDuplicate, other)!
    expect(comparison.onlySubmitter).toEqual([])
    expect(comparison.differingCitations).toEqual([
      { clause: 'Same clause', onlySubmitter: ['z.test.ts › nine'], onlyReviewer: [] },
    ])
  })

  test('deterministic order: normalized-key sorted clauses and citations', () => {
    const a = [clause('zeta'), clause('alpha', ['`b.test.ts` › `x`', '`a.test.ts` › `y`'])]
    const b = [clause('ALPHA', ['`b.test.ts` › `x`']), clause('Zeta', ['`q.test.ts` › `z`'])]
    const comparison = compareCoverageMaps(a, b)!
    expect(comparison.onlySubmitter).toEqual([])
    expect(comparison.differingCitations[0]!.onlySubmitter).toEqual(['a.test.ts › y'])
  })
})
