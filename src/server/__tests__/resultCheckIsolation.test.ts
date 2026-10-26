// The checks' isolation (independent-verification D12/I4): a check's verdict
// is informational — never a stop reason, supervision cause, or dispatch,
// routing, or staffing input. The structural guarantee is that no execution,
// landing, supervision, decision, dispatch, staffing, or routing module
// imports the verification modules: nothing downstream of a verdict exists
// to consult it. The file list is asserted non-empty so the guard cannot rot
// into a vacuous pass.
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'

/** The module roots whose decisions a check verdict must never reach. */
const ISOLATED = [
  'src/server/plans/execution',
  'src/server/plans/landing',
  'src/server/plans/supervision',
  'src/server/plans/decisions',
  'src/server/team/dispatcher.ts',
  'src/server/team/staffing.ts',
  'src/server/team/routing',
]

const VERIFICATION_IMPORT = /from\s+'[^']*verification\/(resultChecks|resultCheckService|resultCheckStore)'/
const VERIFICATION_NAME = /\b(?:ResultCheckService|ResultCheckStore|insertPending|coverageMapsFor)\b/

function typescriptFiles(entry: string): string[] {
  const full = path.resolve(import.meta.dir, '../../..', entry)
  if (fs.statSync(full).isFile()) return [full]
  const found: string[] = []
  for (const name of fs.readdirSync(full)) {
    const child = path.join(full, name)
    if (fs.statSync(child).isDirectory()) found.push(...typescriptFiles(path.join(entry, name)))
    else if (/\.tsx?$/.test(name)) found.push(child)
  }
  return found
}

describe('result check isolation (independent-verification I4)', () => {
  test('no execution, supervision, or dispatch module imports the verification modules', () => {
    const files = ISOLATED.flatMap(typescriptFiles)
    // Non-vacuous: the execution, landing, supervision, dispatch, staffing,
    // and routing modules exist and were all read.
    expect(files.length).toBeGreaterThan(15)
    const offenders = files.filter(file => {
      const source = fs.readFileSync(file, 'utf8')
      return VERIFICATION_IMPORT.test(source) || VERIFICATION_NAME.test(source)
    })
    expect(offenders).toEqual([])
  })
})
