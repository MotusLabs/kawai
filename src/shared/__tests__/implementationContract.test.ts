// Oracle table G1–G20 and properties P1–P3 (implementation-contract design,
// "Acceptance oracles"): the contract grammar's parser, the fence-aware
// section locator, the renderer, and the canonical hash input.
import { describe, expect, test } from 'bun:test'
import {
  clauseIdentity, contractHashInput, parseContract, renderContract, revisionIdentity,
  type ImplementationContract,
} from '../implementationContract'

const H = '## Implementation contract'

interface Row {
  id: string
  text: string
  contract: boolean
  /** Each expected problem: its line and a substring of its message. */
  problems?: Array<[number, string]>
  check?: (contract: ImplementationContract) => void
}

const base = (over: Partial<Record<'a' | 'i' | 's' | 'v' | 'x', string[]>> = {}) => [
  H,
  '### Acceptance', ...(over.a ?? ['- A1: Lists tasks']),
  '### Invariants', ...(over.i ?? ['- I1: Never twice']),
  '### Scope', ...(over.s ?? ['- src/server/**']),
  '### Verification', ...(over.v ?? ['- V1: bun run check passes']),
  '### Excluded', ...(over.x ?? []),
].join('\n')

const many = (letter: string, n: number) => Array.from({ length: n }, (_, k) => `- ${letter}${k + 1}: clause ${k + 1}`)

const ROWS: Row[] = [
  { id: 'G1', text: base(), contract: true, check: c => {
    expect(c.acceptance).toEqual([{ id: 'A1', text: 'Lists tasks' }])
    expect(c.invariants).toEqual([{ id: 'I1', text: 'Never twice' }])
    expect(c.scope).toEqual(['src/server/**'])
    expect(c.verification).toEqual([{ id: 'V1', text: 'bun run check passes' }])
    expect(c.excluded).toEqual([])
  } },
  { id: 'G2', text: base({ s: [] }), contract: false, problems: [[6, 'Scope needs at least one glob']] },
  { id: 'G3a', text: base({ a: [] }), contract: false, problems: [[2, 'Acceptance needs at least one clause']] },
  { id: 'G3b', text: base({ v: [] }), contract: false, problems: [[8, 'Verification needs at least one clause']] },
  { id: 'G4', text: base({ i: [], x: [] }), contract: true, check: c => { expect(c.invariants).toEqual([]); expect(c.excluded).toEqual([]) } },
  { id: 'G5', text: base({ a: ['- A1: one', '- A2: two', '- A2: again'] }), contract: false, problems: [[5, 'Duplicate clause id A2']] },
  { id: 'G6', text: base({ i: ['- A3: misplaced'] }), contract: false, problems: [[5, 'A3 is not an Invariants id']] },
  { id: 'G7', text: [H, '### Acceptance', '- A1: x', '### Scope', '- a/**', '### Invariants', '### Verification', '- V1: y', '### Excluded'].join('\n'),
    contract: false, problems: [[6, 'Invariants heading is out of order']] },
  { id: 'G8', text: [H, '### Acceptance', '- A1: x', '### Invariants', '### Scope', '- a/**', '### Excluded'].join('\n'),
    contract: false, problems: [[1, 'Missing `### Verification` heading']] },
  { id: 'G9', text: base({ i: ['These hold always.'] }), contract: false, problems: [[5, 'Only part headings and bullets']] },
  { id: 'G10', text: base({ i: ['- I1: Never twice', '  and never thrice'] }), contract: true,
    check: c => expect(c.invariants[0].text).toBe('Never twice and never thrice') },
  { id: 'G11', text: base({ a: ['- A0: x', '- A01: y', '- A1:'] }), contract: false,
    problems: [[3, '`A0` is not a clause id'], [4, '`A01` is not a clause id'], [5, 'A1 has no text']] },
  { id: 'G12', text: base({ s: ['- ../x', '- /etc/**', '- a\\b', '- ./a', '- !a', '- a[0]', '- {a,b}'] }), contract: false,
    problems: [[6, 'Scope needs at least one glob'], [7, '`../x` has a `..` segment'], [8, '`/etc/**` is an absolute path'], [9, 'contains a backslash'],
      [10, '`./a` has a `.` segment'], [11, 'contains `!`'], [12, 'contains `[`'], [13, 'contains `{`']] },
  { id: 'G13', text: base({ s: ['- `src/server/**`'] }), contract: true, check: c => expect(c.scope).toEqual(['src/server/**']) },
  { id: 'G14a', text: base({ a: many('A', 51) }), contract: false, problems: [[2, 'Acceptance has 51 clauses; the limit is 50']] },
  { id: 'G14b', text: base({ s: Array.from({ length: 41 }, (_, k) => `- d${k}/**`) }), contract: false, problems: [[6, 'Scope has 41 globs; the limit is 40']] },
  { id: 'G14c', text: base({ a: [`- A1: ${'x'.repeat(1_001)}`] }), contract: false, problems: [[3, 'A1 is 1001 characters; the limit is 1000']] },
  { id: 'G14d', text: base({ a: Array.from({ length: 20 }, (_, k) => `- A${k + 1}: ${'y'.repeat(900)}`) }), contract: false,
    problems: [[1, 'the limit is 16384']] },
  { id: 'G15', text: ['# Design', '```', base(), '```', '~~~md', H, '~~~'].join('\n'), contract: false, problems: [[1, 'No Implementation contract section']] },
  { id: 'G16', text: ['# Design', '```markdown', base({ a: ['- A1: example'] }), '```', '', base({ a: ['- A1: real'] })].join('\n'), contract: true,
    check: c => expect(c.acceptance[0].text).toBe('real') },
  { id: 'G17', text: [base(), '', H].join('\n'), contract: false, problems: [[12, 'A second Implementation contract section']] },
  { id: 'G18', text: [base(), '## Risks', 'Prose here.', '- A9: not a clause'].join('\n'), contract: true,
    check: c => expect(c.acceptance.map(clause => clause.id)).toEqual(['A1']) },
  { id: 'G19', text: [H, '### Acceptance', '- no id here', '### Invariants', 'stray', '### Scope', '- a/**'].join('\n'), contract: false,
    problems: [[1, 'Missing `### Verification`'], [1, 'Missing `### Excluded`'], [2, 'Acceptance needs at least one clause'], [3, 'clause is written'], [5, 'Only part headings']] },
  { id: 'G20', text: base({ i: ['- I1: Never twice', 'stray'] }).replace(/\n/g, '\r\n'), contract: false, problems: [[6, 'Only part headings']] },
]

describe('contract grammar (G1–G20)', () => {
  for (const row of ROWS) {
    // @covers: implementation-contract › A contract has five parts with clause ids › Complete contract
    // @covers: implementation-contract › A contract has five parts with clause ids › Missing scope
    // @covers: implementation-contract › A contract has five parts with clause ids › Duplicate clause id
    // @covers: implementation-contract › A contract has five parts with clause ids › Id with the wrong part letter
    // @covers: implementation-contract › Contracts are written in one Markdown grammar › Parse a section
    // @covers: implementation-contract › Contracts are written in one Markdown grammar › Several problems at once
    // @covers: implementation-contract › Contracts are written in one Markdown grammar › Continued clause
    // @covers: implementation-contract › Contracts are written in one Markdown grammar › Prose inside a part
    // @covers: implementation-contract › Contracts are written in one Markdown grammar › Heading out of order
    // @covers: implementation-contract › Contracts are bounded › Too many clauses
    // @covers: implementation-contract › Contracts are bounded › Escaping glob
    // @covers: implementation-contract › Contracts are bounded › Brace pattern
    test(`${row.id}: ${row.contract ? 'parses' : 'is refused with its problems'}`, () => {
      const parsed = parseContract(row.text)
      if (row.contract) {
        expect(parsed.problems).toEqual([])
        expect(parsed.contract).not.toBeNull()
        if (parsed.contract) row.check?.(parsed.contract)
        return
      }
      expect(parsed.contract).toBeNull()
      const got = parsed.problems.map(problem => [problem.line, problem.message] as const)
      expect(got.length).toBe(row.problems?.length ?? 0)
      row.problems?.forEach(([line, fragment], index) => {
        expect(got[index][0]).toBe(line)
        expect(got[index][1]).toContain(fragment)
      })
    })
  }

  test('G19: problems are sorted by line', () => {
    const lines = parseContract(ROWS.find(row => row.id === 'G19')!.text).problems.map(problem => problem.line)
    expect(lines).toEqual([...lines].sort((a, b) => a - b))
  })

  test('G20: CRLF input parses like LF', () => {
    expect(parseContract(base().replace(/\n/g, '\r\n'))).toEqual(parseContract(base()))
  })
})

// @covers: implementation-contract › A contract has a canonical hash and an identity › Clause identity
test('clause identity is the revision identity, " › ", and the clause id', () => {
  const identity = revisionIdentity(3, '4f1c09ab22de99887766')
  expect(identity).toBe('r3#4f1c09ab22de')
  expect(clauseIdentity(identity, 'I2')).toBe('r3#4f1c09ab22de › I2')
})

test('P2: the canonical rendering is exact (headings, one bullet per clause, globs in backticks)', () => {
  const parsed = parseContract(base({ i: ['- I1: Never twice', '  and never thrice'] }))
  expect(renderContract(parsed.contract!)).toBe([
    H, '', '### Acceptance', '- A1: Lists tasks', '', '### Invariants', '- I1: Never twice and never thrice',
    '', '### Scope', '- `src/server/**`', '', '### Verification', '- V1: bun run check passes', '', '### Excluded', '',
  ].join('\n'))
})

// --- properties (seed 0x1C0A7AC7, 500 cases) ---------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const SEED = 0x1c0a7ac7
const CASES = 500
const WORDS = ['tasks', 'never', 'the', 'result', 'is', 'pinned', 'to', 'revision', 'twice', 'scope', 'a', 'büro', 'ok']

function generate(rand: () => number): ImplementationContract {
  const pick = <T>(list: readonly T[]) => list[Math.floor(rand() * list.length)]
  const text = () => Array.from({ length: 1 + Math.floor(rand() * 8) }, () => pick(WORDS)).join(rand() < 0.1 ? '  ' : ' ')
  const clauses = (letter: string, min: number) =>
    Array.from({ length: min + Math.floor(rand() * 4) }, (_, k) => ({ id: `${letter}${k + 1 + (rand() < 0.2 ? 10 : 0)}`, text: text() }))
      .filter((clause, index, all) => all.findIndex(other => other.id === clause.id) === index)
  const segments = ['src', 'server', 'team', '**', '*.ts', 'docs', 'a?c']
  return {
    version: 1,
    acceptance: clauses('A', 1),
    invariants: clauses('I', 0),
    scope: [...new Set(Array.from({ length: 1 + Math.floor(rand() * 3) }, () => Array.from({ length: 1 + Math.floor(rand() * 3) }, () => pick(segments)).join('/')))],
    verification: clauses('V', 1),
    excluded: clauses('X', 0),
  }
}

/** A formatting variant of the canonical rendering (P1): CRLF, trailing spaces, blank lines, bare globs, continuation splits. */
function variant(contract: ImplementationContract, rand: () => number): string {
  const out: string[] = []
  for (const line of renderContract(contract).split('\n')) {
    let next = [line]
    const bullet = /^- ([AIVX][0-9]+): (.*)$/.exec(line)
    if (bullet && rand() < 0.5) {
      const words = bullet[2].split(' ')
      const cut = 1 + Math.floor(rand() * Math.max(1, words.length - 1))
      if (cut < words.length && words.slice(0, cut).join(' ').trim() !== '' && words.slice(cut).join(' ').trim() !== ''
        && !bullet[2].includes('  ')) {
        next = [`- ${bullet[1]}: ${words.slice(0, cut).join(' ')}`, `   ${words.slice(cut).join(' ')}`]
      }
    }
    if (/^- `.*`$/.test(line) && rand() < 0.5) next = [line.replace(/`/g, '')]
    next = next.map(entry => (rand() < 0.3 ? `${entry}  ` : entry))
    out.push(...next)
    if (rand() < 0.2) out.push('')
  }
  return out.join(rand() < 0.5 ? '\r\n' : '\n')
}

describe('contract properties (seed 0x1C0A7AC7, 500 cases)', () => {
  test('P1: formatting variants hash the same as the canonical form', () => {
    const rand = mulberry32(SEED)
    for (let k = 0; k < CASES; k += 1) {
      const contract = generate(rand)
      const parsed = parseContract(variant(contract, rand))
      expect(parsed.problems).toEqual([])
      expect(contractHashInput(parsed.contract!)).toBe(contractHashInput(contract))
    }
  })

  test('P2: render then parse round-trips', () => {
    const rand = mulberry32(SEED + 1)
    for (let k = 0; k < CASES; k += 1) {
      const contract = generate(rand)
      const parsed = parseContract(renderContract(contract))
      expect(parsed.problems).toEqual([])
      expect(parsed.contract).toEqual(contract)
    }
  })

  test('P3: one content edit changes the hash input', () => {
    const rand = mulberry32(SEED + 2)
    for (let k = 0; k < CASES; k += 1) {
      const contract = generate(rand)
      const edited: ImplementationContract = structuredClone(contract)
      const kind = Math.floor(rand() * 4)
      if (kind === 0) edited.acceptance[0].text = `${edited.acceptance[0].text}!`
      else if (kind === 1) edited.verification[0].id = `V${99}`
      else if (kind === 2 && edited.acceptance.length > 1) [edited.acceptance[0], edited.acceptance[1]] = [edited.acceptance[1], edited.acceptance[0]]
      else edited.scope[0] = `${edited.scope[0]}x`
      if (JSON.stringify(edited) === JSON.stringify(contract)) continue
      expect(contractHashInput(edited)).not.toBe(contractHashInput(contract))
    }
  })
})
