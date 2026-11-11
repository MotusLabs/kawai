// junitReruns.test.ts - A retried real-tmux file in the test list
// (check-time-optimization D2/D3, task 3.3): the rerun's report joins the
// planned-report manifest before the rerun starts and stands for the file
// in the merge, replacing the first attempt's failing report; the failing
// tests a report names, for the retry message and the record.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  PLANNED_REPORTS_NAME,
  appendPlannedRerun,
  mergeJUnitReports,
  readJUnitFailures,
  readPlan,
  writePlannedReports,
} from '../lib/junitReports'
import { planBatches, rerunBatch } from '../planBatches'

let dir: string

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-junit-reruns-')))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

const MAIN = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="1">
  <testsuite name="src/main.test.ts" file="./src/main.test.ts">
    <testcase name="main passes" time="0.001"/>
  </testsuite>
</testsuites>`

const FIRST_ATTEMPT = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="2">
  <testsuite name="src/tmux.integration.test.ts" file="./src/tmux.integration.test.ts">
    <testsuite name="attach" line="3">
      <testcase name="orders output" time="10.0"><failure type="AssertionError" message="timed out"/></testcase>
      <testcase name="reconnects" time="1.0"/>
    </testsuite>
  </testsuite>
</testsuites>`

const RERUN = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="2">
  <testsuite name="src/tmux.integration.test.ts" file="./src/tmux.integration.test.ts">
    <testsuite name="attach" line="3">
      <testcase name="orders output" time="2.0"/>
      <testcase name="reconnects" time="1.0"/>
    </testsuite>
  </testsuite>
</testsuites>`

function report(name: string, xml: string): void {
  fs.writeFileSync(path.join(dir, name), xml)
}

describe('a retried file in the merge', () => {
  test('the rerun report replaces the failed first report: the pass, once, no duplicate entries', () => {
    writePlannedReports(dir, ['0-parallel-a.junit.xml', '1-real-tmux-a.junit.xml'])
    report('0-parallel-a.junit.xml', MAIN)
    report('1-real-tmux-a.junit.xml', FIRST_ATTEMPT)
    appendPlannedRerun(dir, { report: '2-real-tmux-rerun-a.junit.xml', replaces: '1-real-tmux-a.junit.xml' })
    report('2-real-tmux-rerun-a.junit.xml', RERUN)
    const entries = mergeJUnitReports(dir)
    expect(entries?.map((entry) => [entry.file, entry.path, entry.name, entry.status])).toEqual([
      ['src/main.test.ts', '', 'main passes', 'passed'],
      ['src/tmux.integration.test.ts', 'attach', 'orders output', 'passed'],
      ['src/tmux.integration.test.ts', 'attach', 'reconnects', 'passed'],
    ])
  })

  test('without the rerun in the plan, the failing first report leaves no list', () => {
    writePlannedReports(dir, ['0-parallel-a.junit.xml', '1-real-tmux-a.junit.xml'])
    report('0-parallel-a.junit.xml', MAIN)
    report('1-real-tmux-a.junit.xml', FIRST_ATTEMPT)
    expect(mergeJUnitReports(dir)).toBeNull()
  })

  test('a planned rerun whose report never landed leaves no list', () => {
    writePlannedReports(dir, ['0-parallel-a.junit.xml', '1-real-tmux-a.junit.xml'])
    report('0-parallel-a.junit.xml', MAIN)
    report('1-real-tmux-a.junit.xml', FIRST_ATTEMPT)
    appendPlannedRerun(dir, { report: '2-real-tmux-rerun-a.junit.xml', replaces: '1-real-tmux-a.junit.xml' })
    expect(mergeJUnitReports(dir)).toBeNull()
  })

  test('the plan fails closed on a rerun that replaces an unplanned, a reused, or its own report', () => {
    const write = (reruns: unknown) =>
      fs.writeFileSync(
        path.join(dir, PLANNED_REPORTS_NAME),
        JSON.stringify({ reports: ['1-a.junit.xml', '2-b.junit.xml', '3-c.junit.xml'], reruns })
      )
    write([{ report: '2-b.junit.xml', replaces: '9-x.junit.xml' }])
    expect(readPlan(dir)).toBeNull()
    write([{ report: '2-b.junit.xml', replaces: '2-b.junit.xml' }])
    expect(readPlan(dir)).toBeNull()
    write([
      { report: '2-b.junit.xml', replaces: '1-a.junit.xml' },
      { report: '3-c.junit.xml', replaces: '1-a.junit.xml' },
    ])
    expect(readPlan(dir)).toBeNull()
    write('not a list')
    expect(readPlan(dir)).toBeNull()
    write([{ report: '2-b.junit.xml', replaces: '1-a.junit.xml' }])
    expect(readPlan(dir)).toEqual({
      reports: ['1-a.junit.xml', '2-b.junit.xml', '3-c.junit.xml'],
      reruns: [{ report: '2-b.junit.xml', replaces: '1-a.junit.xml' }],
    })
  })

  test('appending to an unreadable plan leaves it unreadable', () => {
    appendPlannedRerun(dir, { report: '2-b.junit.xml', replaces: '1-a.junit.xml' })
    expect(fs.existsSync(path.join(dir, PLANNED_REPORTS_NAME))).toBe(false)
  })
})

describe('readJUnitFailures', () => {
  test('names each failing test with its describe chain; a passing report names none', () => {
    report('first.junit.xml', FIRST_ATTEMPT)
    report('rerun.junit.xml', RERUN)
    expect(readJUnitFailures(path.join(dir, 'first.junit.xml'))).toEqual(['attach > orders output'])
    expect(readJUnitFailures(path.join(dir, 'rerun.junit.xml'))).toEqual([])
  })

  test('an error child counts, a missing report is null', () => {
    report(
      'error.junit.xml',
      '<testsuites><testsuite name="f" file="f.test.ts"><testcase name="boom"><error message="x"/></testcase></testsuite></testsuites>'
    )
    expect(readJUnitFailures(path.join(dir, 'error.junit.xml'))).toEqual(['boom'])
    expect(readJUnitFailures(path.join(dir, 'absent.junit.xml'))).toBeNull()
  })
})

describe('rerunBatch', () => {
  test('keeps the command, swaps the first report for its own, and plans it only when asked', () => {
    const [main, tmux] = planBatches({
      workers: 2,
      mainFiles: ['src/a.test.ts'],
      serialFiles: ['src/server/__tests__/integration.test.ts'],
      passthrough: [],
      skipRealTmux: false,
      junitReportDir: dir,
    })
    expect(main!.kind).toBe('parallel')
    const rerun = rerunBatch(tmux!, path.join(dir, '5-real-tmux-rerun-x.junit.xml'), true)
    expect(rerun.label).toBe('real-tmux rerun: src/server/__tests__/integration.test.ts')
    expect(rerun.cmd.filter((arg) => arg.startsWith('--reporter-outfile='))).toEqual([
      `--reporter-outfile=${path.join(dir, '5-real-tmux-rerun-x.junit.xml')}`,
    ])
    expect(rerun.cmd.filter((arg) => !arg.startsWith('--reporter'))).toEqual(
      tmux!.cmd.filter((arg) => !arg.startsWith('--reporter'))
    )
    expect(rerun.report).toBe('5-real-tmux-rerun-x.junit.xml')
    expect(rerunBatch(tmux!, path.join(dir, 'p.junit.xml'), false).report).toBeUndefined()
  })

  test('outside a check, real-tmux batches report privately and stay off the manifest', () => {
    const batches = planBatches({
      workers: 2,
      mainFiles: ['src/a.test.ts'],
      serialFiles: ['src/server/__tests__/integration.test.ts'],
      passthrough: [],
      skipRealTmux: false,
      privateReportDir: dir,
    })
    expect(batches[0]!.reportPath).toBeUndefined()
    expect(batches[1]!.report).toBeUndefined()
    expect(path.dirname(batches[1]!.reportPath!)).toBe(dir)
    // A caller's own reporter wins: no private report either.
    const own = planBatches({
      workers: 2,
      mainFiles: [],
      serialFiles: ['src/server/__tests__/integration.test.ts'],
      passthrough: ['--reporter=junit', '--reporter-outfile=/elsewhere.xml'],
      skipRealTmux: false,
      privateReportDir: dir,
    })
    expect(own[0]!.reportPath).toBeUndefined()
  })
})
