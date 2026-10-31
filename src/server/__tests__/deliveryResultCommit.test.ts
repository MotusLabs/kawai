// D1 literal identity and field-by-field corroboration, including the actual
// ResultCheckStore producer. No checker runs and no result is accepted here.
import { expect, test } from 'bun:test'
import { resolveResultCommit } from '../metrics/delivery/landing'
import { isFullLiteral, parseObjectFormat } from '../metrics/delivery/objectFormat'
import type { ResultCommit } from '../metrics/delivery/types'
import { ResultCheckStore } from '../verification/resultCheckStore'
import { schemaCopy } from './schemaDb'
import { FINISHED_AT, id, passingCheck, RESULT_CONTEXT } from './fixtures/deliveryCases'
import { TABLE_L } from './fixtures/deliveryOracleRows'

const D = id(40)
const landing = { position: 2, at: 100, bound: 100 }
const input = { ...RESULT_CONTEXT, commitRef: D, objectFormat: 'sha1' as const,
  landings: new Map([[id(1), landing]]) }
const unknown = { kind: 'unresolvable', reason: 'no-corroboration' } as const

// @covers: delivery-outcomes › A result commit lands at its first containing position › Unmerged result
// @covers: delivery-outcomes › A result commit lands at its first containing position › Unmerged result without a passing check
// @covers: delivery-outcomes › Result commits are identified by full literal ids only › Off-history literal with a check
test('Table L4, L4b and L8b: an offgraph full literal needs a strict same-result passing check', () => {
  for (const row of TABLE_L.filter(row => ['L4', 'L4b', 'L8b'].includes(row[0]))) {
    const checks = row[0] === 'L4b' ? [{ ...passingCheck(D), status: 'pending' }] : [passingCheck(D)]
    const expected: ResultCommit = row[0] === 'L4b' ? unknown : {
      kind: 'not-landed', sha: D, evidence: { id: 'fixture-check', seq: 1, finishedAt: FINISHED_AT },
    }
    expect(resolveResultCommit({ ...input, checks }), row.join(' | ')).toEqual(expected)
  }
  expect(resolveResultCommit({ ...input, checks: [] })).toEqual(unknown)
})

// @covers: delivery-outcomes › Result commits are identified by full literal ids only › Abbreviation stays unresolvable
test('Table L7 and L8e: abbreviations stay unresolvable even with a later prefix-given full-sha check', () => {
  const C = 'abcdef01' + '1'.repeat(32)
  const unmerged = 'abcdef0f' + '2'.repeat(32)
  expect(C.slice(0, 7)).toBe(unmerged.slice(0, 7))
  const landings = new Map([[C, landing]])
  expect(landings.has(unmerged)).toBe(false)
  for (const row of TABLE_L.filter(row => row[0] === 'L7' || row[0] === 'L8e')) {
    const refs = row[0] === 'L8e' ? [C.slice(0, 7)] : [C.slice(0, 7), C.slice(0, 12), 'HEAD', 'feature',
      'a'.repeat(39), 'a'.repeat(41), 'a'.repeat(64), C.toUpperCase(), ` ${C}`, `${C}\n`, null, 123]
    for (const commitRef of refs) {
      const later = { ...passingCheck(C), facts: { version: 1, commit: { status: 'pass', given: commitRef, sha: C } } }
      expect(resolveResultCommit({ ...input, commitRef, landings, checks: [later] }), row.join(' | '))
        .toEqual({ kind: 'unresolvable', reason: 'not-full-literal' })
    }
  }
})

test('L8e: uniqueness in the default graph cannot resolve a shared repository prefix', () => {
  const C = 'abcdef01' + '1'.repeat(32)
  const unmerged = 'abcdef0f' + '2'.repeat(32)
  const prefix = C.slice(0, 7)
  const landings = new Map([[C, landing]])
  expect(unmerged.startsWith(prefix)).toBe(true)
  expect([...landings.keys()].filter(sha => sha.startsWith(prefix))).toEqual([C])
  expect(resolveResultCommit({ ...input, commitRef: prefix, landings, checks: [] }))
    .toEqual({ kind: 'unresolvable', reason: 'not-full-literal' })
})

test('L7: a final line terminator cannot stand in for the last hexadecimal digit', () => {
  for (const format of ['sha1', 'sha256'] as const) {
    const length = format === 'sha1' ? 40 : 64
    for (const ending of ['\n', '\r', '\u2028', '\u2029']) {
      const literal = 'a'.repeat(length - 1) + ending
      expect(literal.length).toBe(length)
      expect(isFullLiteral(literal, format)).toBe(false)
      expect(resolveResultCommit({ ...input, objectFormat: format, commitRef: literal,
        checks: [passingCheck(literal)] })).toEqual({ kind: 'unresolvable', reason: 'not-full-literal' })
    }
  }
})

test('Table L8c: every consumed corroboration field is validated independently', () => {
  const cases: Array<[string, unknown]> = [
    ['null row', null], ['array row', []], ['string row', JSON.stringify(passingCheck(D))],
    ['missing facts', { ...passingCheck(D), facts: undefined }],
  ]
  const changed = (field: string, value: unknown) => ({ ...passingCheck(D), [field]: value })
  for (const [field, values] of Object.entries({
    teamId: [undefined, 'another-team'], taskId: [undefined, 'another-task'], resultId: [undefined, 'another-result'],
    status: [undefined, 'pending', 'unavailable', 'failed', true], id: [undefined, '', ' ', 1],
    seq: [undefined, 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1'],
    finishedAt: [undefined, null, '', ' ', 'bad-time', '2026-10-03', 1790985600000],
    facts: [null, [], 'json', {}, { version: '1' }, { version: 2 }, { version: 1 },
      { version: 1, commit: null }, { version: 1, commit: [] }],
  })) for (const value of values) cases.push([`${field}=${String(value)}`, changed(field, value)])
  for (const [field, values] of Object.entries({
    status: [undefined, 'fail', 'warn', 'unknown', true], given: [undefined, null, id(99), D.slice(0, 7)],
    sha: [undefined, null, D.slice(0, 39), 'A'.repeat(40), 'a'.repeat(64), 123],
  })) for (const value of values) cases.push([`commit.${field}=${String(value)}`, {
    ...passingCheck(D), facts: { version: 1, commit: { ...passingCheck(D).facts.commit, [field]: value } },
  }])
  const row = TABLE_L.find(row => row[0] === 'L8c')!
  for (const [label, check] of cases) {
    expect(resolveResultCommit({ ...input, checks: [check] }), `${row.join(' | ')}: ${label}`).toEqual(unknown)
    // Malformed/unrelated/non-pass rows also cannot poison valid evidence.
    expect(resolveResultCommit({ ...input, checks: [check, passingCheck(D)] }).kind, label).toBe('not-landed')
  }
})

test('L8c: commit.given and commit.sha are independently required', () => {
  const badGiven = { ...passingCheck(D), facts: { version: 1, commit: { status: 'pass', given: id(99), sha: D } } }
  expect(resolveResultCommit({ ...input, checks: [badGiven] })).toEqual(unknown)
  const badSha = { ...passingCheck(D), facts: { version: 1, commit: { status: 'pass', given: D, sha: id(99) } } }
  expect(resolveResultCommit({ ...input, checks: [badSha] })).toEqual({ kind: 'unresolvable', reason: 'contradictory-check' })
  expect(resolveResultCommit({ ...input, checks: [passingCheck(D)] }).kind).toBe('not-landed')
})

test('Table L8d: lone and paired contradictory passes disqualify offgraph evidence in either order', () => {
  const row = TABLE_L.find(row => row[0] === 'L8d')!
  const good = passingCheck(D)
  const conflicting = { ...passingCheck(D, 2), facts: { version: 1, commit: { status: 'pass', given: D, sha: id(99) } } }
  for (const checks of [[conflicting], [good, conflicting], [conflicting, good]]) {
    expect(resolveResultCommit({ ...input, checks }), row.join(' | ')).toEqual({ kind: 'unresolvable', reason: 'contradictory-check' })
  }
  const notFound = { ...passingCheck(D, 2), facts: { version: 1, commit: { status: 'fail', given: D, sha: null } } }
  expect(resolveResultCommit({ ...input, checks: [notFound, good] }).kind).toBe('not-landed')
  expect(resolveResultCommit({ ...input, landings: new Map([[D, landing]]), checks: [conflicting] }))
    .toEqual({ kind: 'landed', sha: D, landing })
})

test('agreeing check evidence selects the lowest seq then lexicographic id regardless of row order', () => {
  const rows = [passingCheck(D, 5, '0'), passingCheck(D, 1, 'b'), passingCheck(D, 1, 'a')]
  for (const checks of [rows, [...rows].reverse(), [rows[1], rows[0], rows[2]]]) {
    expect(resolveResultCommit({ ...input, checks })).toEqual({ kind: 'not-landed', sha: D,
      evidence: { id: 'a', seq: 1, finishedAt: FINISHED_AT } })
  }
})

test('Table L8f: config text determines sha256 identity length instead of a fixed forty digits', () => {
  const format = parseObjectFormat('[core]\nrepositoryformatversion = 1\n[extensions]\nobjectformat = sha256\n')
  expect(format).toBe('sha256')
  if (format === null) throw new Error('expected a supported fixture format')
  const C = 'ab'.repeat(32)
  const row = TABLE_L.find(row => row[0] === 'L8f')!
  expect(resolveResultCommit({ ...input, objectFormat: format, commitRef: C, landings: new Map([[C, landing]]), checks: [] }), row.join(' | '))
    .toEqual({ kind: 'landed', sha: C, landing })
  expect(resolveResultCommit({ ...input, objectFormat: format, commitRef: id(1), checks: [passingCheck(id(1))] }).kind).toBe('unresolvable')
})

test('object format parsing accepts case, quotes and comments and refuses ambiguous format text', () => {
  for (const [text, expected] of [
    ['', 'sha1'], ['[core]\nrepositoryformatversion=0\n', 'sha1'],
    ['[extensions]\nobjectformat=sha1 # plain\n', 'sha1'],
    ['[EXTENSIONS] ; comment\r\n OBJECTFORMAT = "SHA256" # comment\r\n', 'sha256'],
    ['# comment backslash does not fold \\\n[extensions]\nobjectformat=sha256\n', 'sha256'],
    ['[extensions]\nobjectformat=sha\\\n256\n', 'sha256'],
    ['[extensions]\nobjectformat="sha\\\n256"\n', 'sha256'],
    ['[other "extensions"]\nobjectformat=sha256\n', 'sha1'],
    ['[extensions]\nobjectformat=sha256\n[extensions]\nobjectformat=sha256\n', 'sha256'],
    ['[extensions]\nobjectformat=sha256\n[extensions]\nobjectformat=sha1\n', null],
    ['[extensions]\nobjectformat=sha512\n', null], ['[extensions]\nobjectformat\n', null],
    ['[extensions]\nobjectformat="sha256\n', null], ['[extensions]\nobjectformat="sha#256"\n', null],
    ['[extensions]\nobjectformat=" sha256 "\n', null],
    ['[extensions]\nobjectformat="sha\\x256"\n', null], ['[extensions broken\nobjectformat=sha256\n', null],
  ] as const) expect(parseObjectFormat(text), text).toBe(expected)
  expect(isFullLiteral('A'.repeat(40), 'sha1')).toBe(false)
  expect(isFullLiteral('a'.repeat(64), 'sha256')).toBe(true)
})

// @covers: delivery-outcomes › Result commits are identified by full literal ids only › Off-history literal with a check
test('K1: actual ResultCheckStore rows corroborate only their same-result literal', () => {
  const db = schemaCopy()
  try {
    const store = new ResultCheckStore(db)
    const { check } = store.insertPending({ ...RESULT_CONTEXT, trigger: 'submit', requestedBy: { kind: 'human', sessionId: null } })
    expect(resolveResultCommit({ ...input, checks: store.allForResult(RESULT_CONTEXT.resultId) })).toEqual(unknown)
    expect(store.settle(check.id, 'done', JSON.stringify(passingCheck(D).facts), null, FINISHED_AT)).toBe(true)
    const rows = store.allForResult(RESULT_CONTEXT.resultId)
    expect(rows).toHaveLength(1)
    expect(resolveResultCommit({ ...input, checks: rows })).toEqual({ kind: 'not-landed', sha: D,
      evidence: { id: check.id, seq: 1, finishedAt: FINISHED_AT } })
    expect(resolveResultCommit({ ...input, resultId: 'another-result', checks: rows })).toEqual(unknown)
    // parseFacts accepts version1 with a partial commit object. The consumer
    // must still reject it, even when it came through the actual store.
    const partial = store.insertPending({ ...RESULT_CONTEXT, resultId: 'partial-result', trigger: 'submit',
      requestedBy: { kind: 'human', sessionId: null } }).check
    store.settle(partial.id, 'done', JSON.stringify({ version: 1, commit: { status: 'pass', given: D } }), null, FINISHED_AT)
    expect(resolveResultCommit({ ...input, resultId: 'partial-result', checks: store.allForResult('partial-result') })).toEqual(unknown)
  } finally { db.close() }
})
