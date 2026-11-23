// @reads: docs/change-lead-pilot.md
// The Change Lead pilot protocol (change-coordination): the role files that
// apply it are user-level configuration (`~/.kawai/groups/`), so the rules
// this repository can check are the ones the protocol doc itself states.
import { expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'

const DOC = fs.readFileSync(path.resolve(import.meta.dir, '../../../docs/change-lead-pilot.md'), 'utf8')

/** One `## ` section of the doc, whitespace collapsed. */
function section(heading: string): string {
  const start = DOC.indexOf(`\n## ${heading}`)
  expect(start).toBeGreaterThan(-1)
  const end = DOC.indexOf('\n## ', start + 1)
  return DOC.slice(start, end === -1 ? undefined : end).replace(/\s+/g, ' ')
}

// @covers: change-coordination › Coordinator recovery respects durable ownership › Coordinator lost
test('an unavailable coordinator gets one escalation to lead and no duplicate dispatch while recovery is recorded', () => {
  const recovery = section('7. Recovery: unavailable coordinator and replacement')
  expect(recovery).toContain('exactly one escalation goes to the `lead` group with a journal note naming the wait')
  expect(recovery).toContain('nobody dispatches a second implementation or review while recovery is recorded')
})
