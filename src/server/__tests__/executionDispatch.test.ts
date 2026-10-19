// Kawai's dispatch of an execution's stages (plan-execution D7/D8, §11.4).
// This file starts with the boundary the review deferred from 2.1: the
// system TaskCaller is minted only inside src/server/plans/execution — and,
// for the override and promotion origins, in plans/decisions/fixTasks.ts
// (plan-supervision D7) — no tool handler, WebSocket connection path, or other
// source constructs one.
// The exemption is the TaskCaller type definition itself (its `kind:
// 'system';` member), never a whole file; the dispatch (task creation,
// manifest, request keys) lands with the rest of 11.4 in PR B.
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'

/** A value-position construct of a system TaskCaller. */
const MINT = /kind: 'system',\s*team\b|executionId: [^,}]+[,}][^\n]*kind: 'system'/
/** The TaskCaller type's own union member — `kind: 'system';` with type separators. */
const TYPE_DEFINITION = /\{\s*kind: 'system';/

const FIX_TASKS = path.join('src', 'server', 'plans', 'decisions', 'fixTasks.ts')
const EXECUTION = path.join('src', 'server', 'plans', 'execution')
const DECISION_ORIGIN = /origin: \{ kind: '(override|promotion)'/

/** Every value-position system caller construct outside the tests, as `file:line` with the line. */
function mints(): Array<{ file: string; at: string; line: string }> {
  const found: Array<{ file: string; at: string; line: string }> = []
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name !== '__tests__') walk(file)
      } else if (/\.tsx?$/.test(entry.name)) {
        fs.readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
          if ((MINT.test(line) || DECISION_ORIGIN.test(line)) && !TYPE_DEFINITION.test(line)) found.push({ file, at: `${file}:${index + 1}`, line })
        })
      }
    }
  }
  ;['src/server', 'src/client', 'src/shared'].forEach(walk)
  return found
}

describe('only the execution module mints a system caller (deferred from 2.1, §11.4)', () => {
  test('no source outside src/server/plans/execution and the fix-task module builds a system TaskCaller', () => {
    // plan-supervision D7: fixTasks.ts mints the override and promotion
    // origins; no tool handler or connection path builds any system caller.
    expect(mints().filter(mint => !mint.file.startsWith(EXECUTION + path.sep) && mint.file !== FIX_TASKS).map(mint => mint.at)).toEqual([])
  })

  test('the execution module mints only the execution origin, the fix-task module only the decision origins', () => {
    const all = mints()
    expect(all.filter(mint => mint.file.startsWith(EXECUTION + path.sep) && DECISION_ORIGIN.test(mint.line)).map(mint => mint.at)).toEqual([])
    expect(all.filter(mint => mint.file === FIX_TASKS && !DECISION_ORIGIN.test(mint.line)).map(mint => mint.at)).toEqual([])
  })
})
