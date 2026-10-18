// The verdict's isolation (execution-safety-recovery D10, task 4.3): a
// violation is informational — never a stop reason, supervision cause, or
// dispatch, routing, or staffing input. The structural guarantee is that no
// execution, landing, supervision, dispatch, staffing, or routing module
// imports the outbound store or its service: nothing downstream of a verdict
// exists to consult it. The file list is asserted non-empty so the guard
// cannot rot into a vacuous pass.
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'

/** The module roots whose decisions a verdict must never reach. */
const ISOLATED = [
  'src/server/plans/execution',
  'src/server/plans/landing',
  'src/server/team/dispatcher.ts',
  'src/server/team/staffing.ts',
  'src/server/team/routing',
]

const OUTBOUND_IMPORT = /from\s+'[^']*outbound\/(store|service|auditHooks|observer)'/
const OUTBOUND_NAME = /\b(?:OutboundStore|OutboundService|OutboundObserver)\b/

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

describe('outbound isolation (ESR 4.3)', () => {
  test('no execution, supervision, or dispatch module imports the outbound store', () => {
    const files = ISOLATED.flatMap(typescriptFiles)
    // Non-vacuous: the execution, landing, dispatch, staffing, and routing
    // modules exist and were all read.
    expect(files.length).toBeGreaterThan(15)
    const offenders = files.filter(file => {
      const source = fs.readFileSync(file, 'utf8')
      return OUTBOUND_IMPORT.test(source) || OUTBOUND_NAME.test(source)
    })
    expect(offenders).toEqual([])
  })
})
