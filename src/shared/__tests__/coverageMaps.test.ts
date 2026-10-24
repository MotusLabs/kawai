// Coverage map validation (independent-verification D5, task 3.1): D5's
// limits and the `` `path` › `title` `` citation grammar, every refusal
// naming its 1-based clause index, and the normalization the comparison
// matches by (D6). Table-driven over the validator so each limit and each
// malformed shape is one row.
import { describe, expect, test } from 'bun:test'
import { COVERAGE_LIMITS, normalizeCitation, normalizeClause, parseCitation, validateCoverageMap } from '../coverageMaps'

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
})
