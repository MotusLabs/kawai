// The recovery matrix's script check (execution-safety-recovery 7.1, D17;
// spec execution-recovery "Every row names a test or a gap"): parses
// docs/recovery-matrix.md's table and fails when a cited test file is
// missing, the file has no `test`/`it`/`describe` with the exact title, or a
// row has neither a citation nor `gap — <reason>`. The checker's own failure
// modes are pinned against synthetic tables, so a broken checker cannot pass
// the real one vacuously.
// @reads: docs/recovery-matrix.md
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { testTitles } from '../checks/testTitles'

const REPO = path.resolve(import.meta.dir, '../../..')
const MATRIX = path.join(REPO, 'docs', 'recovery-matrix.md')
const COLUMNS = ['Fault', 'Mechanism', 'Owning change', 'Contract', 'Test']

const cells = (line: string) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim())

/** The table's rows: the first table whose header is exactly COLUMNS. */
function matrixRows(markdown: string): { rows: string[][]; errors: string[] } {
  const lines = markdown.split('\n')
  const header = lines.findIndex(line => line.trim().startsWith('|') && cells(line).join('|') === COLUMNS.join('|'))
  if (header < 0) return { rows: [], errors: [`no table with the columns ${COLUMNS.join(', ')}`] }
  const rows: string[][] = []
  const errors: string[] = []
  for (const line of lines.slice(header + 2)) {
    if (!line.trim().startsWith('|')) break
    const row = cells(line)
    if (row.length !== COLUMNS.length) errors.push(`${row[0] ?? line}: ${row.length} cells, expected ${COLUMNS.length}`)
    else rows.push(row)
  }
  return { rows, errors }
}

/** Every failure of the matrix against the repository at `root`. */
function checkMatrix(markdown: string, root: string): string[] {
  const { rows, errors } = matrixRows(markdown)
  if (rows.length === 0 && errors.length === 0) errors.push('the table has no rows')
  const sources = new Map<string, Set<string> | null>()
  for (const [fault, mechanism, owner, , cell] of rows) {
    if (!mechanism || !owner) errors.push(`${fault}: mechanism and owning change are required`)
    const entries = cell!.split('<br>').map(entry => entry.trim()).filter(Boolean)
    let cited = 0
    for (const entry of entries) {
      const citation = /^`([^`]+)` › `([^`]+)`$/.exec(entry)
      if (citation) {
        cited++
        const [, file, title] = citation
        if (!sources.has(file!)) {
          const full = path.join(root, file!)
          sources.set(file!, fs.existsSync(full) ? testTitles(fs.readFileSync(full, 'utf8')) : null)
        }
        const titles = sources.get(file!)
        if (titles === null) errors.push(`${fault}: ${file} does not exist`)
        else if (!titles!.has(title!)) errors.push(`${fault}: ${file} has no test titled "${title}"`)
        continue
      }
      const gap = /^gap — (\S.*)$/.exec(entry)
      if (gap) { cited++; continue }
      errors.push(`${fault}: "${entry}" is neither a test citation nor a gap with its reason`)
    }
    if (cited === 0) errors.push(`${fault}: names neither a test nor a gap with its reason`)
  }
  return errors
}

const table = (testCell: string) =>
  `| ${COLUMNS.join(' | ')} |\n| --- | --- | --- | --- | --- |\n| A fault | A mechanism | a-change | C1 | ${testCell} |\n`
const SELF = 'src/server/__tests__/recoveryMatrix.test.ts'

describe('docs/recovery-matrix.md', () => {
  test('every row names an existing test file and exact title, or a gap with its reason', () => {
    expect(checkMatrix(fs.readFileSync(MATRIX, 'utf8'), REPO)).toEqual([])
  })

  test('covers every row source D17 lists', () => {
    const faults = matrixRows(fs.readFileSync(MATRIX, 'utf8')).rows.map(row => row[0]!)
    const required = [
      'Task exists; dispatch absent', 'Publication durable; notification absent', 'Pause sent; acknowledgement absent',
      'Result durable; QA handoff absent', 'Candidate created; promotion record absent', 'Archive interrupted during spec changes',
      'External API outcome unknown', 'R17', 'R18', 'R19', 'Crash between an audit hook and its row', 'Outcome missing across a restart',
      'Torn backup', 'Failed migration', 'Newer database', 'Restore', 'R1 —', 'R2 —', 'R3 —', 'R4 —', 'landing-slot holder', 'promotion holder',
    ]
    expect(required.filter(prefix => !faults.some(fault => fault.includes(prefix)))).toEqual([])
  })
})

describe('the check itself', () => {
  test('a cited title that exists passes', () => {
    expect(checkMatrix(table(`\`${SELF}\` › \`a cited title that exists passes\``), REPO)).toEqual([])
  })

  test('a renamed title fails, naming the file and title', () => {
    expect(checkMatrix(table(`\`${SELF}\` › \`a cited title that was renamed\``), REPO))
      .toEqual([`A fault: ${SELF} has no test titled "a cited title that was renamed"`])
  })

  test('a missing file fails', () => {
    expect(checkMatrix(table('`src/server/__tests__/noSuchFile.test.ts` › `anything`'), REPO))
      .toEqual(['A fault: src/server/__tests__/noSuchFile.test.ts does not exist'])
  })

  test('a row with neither a test nor a gap fails, and so does a gap without its reason', () => {
    expect(checkMatrix(table('—'), REPO)).toEqual([
      'A fault: "—" is neither a test citation nor a gap with its reason',
      'A fault: names neither a test nor a gap with its reason',
    ])
    expect(checkMatrix(table('gap — '), REPO)).toEqual([
      'A fault: "gap —" is neither a test citation nor a gap with its reason',
      'A fault: names neither a test nor a gap with its reason',
    ])
    expect(checkMatrix(table('gap — revision-control not implemented'), REPO)).toEqual([])
  })

  test('titles: escapes are read, modifiers count, and template titles with substitutions never match', () => {
    const source = "test('it\\'s here', () => {})\ndescribe.skip(\"group\", () => {})\ntest(`made ${'x'}`, () => {})\nit(`plain`, () => {})"
    expect([...testTitles(source)].sort()).toEqual(["it's here", 'group', 'plain'].sort())
  })
})
