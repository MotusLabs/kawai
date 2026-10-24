// junitReports.test.ts - The report converter and all-or-nothing merge
// (independent-verification D7, task 4.2). Fixtures mirror Bun 1.4.3's real
// shape from the 4.1 spike: one aggregated `<testsuites>` document per
// invocation, a file-level suite without a `line` attribute, one nested
// `<testsuite>` per describe with `line` + `name`, repo-relative `file`
// repeated at every level, `<skipped/>` = skip, `<skipped message="TODO"/>`
// = todo, `<failure>` = failure.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  PLANNED_REPORTS_NAME,
  REPORT_SUFFIX,
  junitReporterArgs,
  junitReportPath,
  mergeJUnitReports,
  parseJUnitTestEntries,
  plannedReportNames,
  readPlannedReports,
  trustworthyEntries,
  writePlannedReports,
} from '../lib/junitReports'
import { planBatches } from '../planBatches'

let dir: string

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-junit-')))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

function report(name: string, xml: string): string {
  const reportPath = path.join(dir, name.endsWith(REPORT_SUFFIX) ? name : `${name}${REPORT_SUFFIX}`)
  fs.writeFileSync(reportPath, xml)
  return reportPath
}

// A Bun-shaped document: a file-level suite, a nested describe chain, three
// statuses, and an escaped name.
const GOOD_REPORT = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="4">
  <testsuite name="src/a.test.ts" file="./src/a.test.ts">
    <testsuite name="outer" line="4">
      <testsuite name="inner &amp; tight" line="5">
        <testcase name="passes" classname="inner &amp; tight &gt; outer &gt; passes" time="0.001"/>
        <testcase name="skips"><skipped/></testcase>
        <testcase name="a todo"><skipped message="TODO"/></testcase>
      </testsuite>
    </testsuite>
  </testsuite>
</testsuites>`

const SECOND_REPORT = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="1">
  <testsuite name="src/b.test.ts" file="src/b.test.ts">
    <testcase name="top level, no describe" time="0.000"/>
  </testsuite>
</testsuites>`

// @covers: dev-checks › Full-check records list the tests that ran › Pass with its test list
describe('parseJUnitTestEntries converts a real report into list entries', () => {
  test('statuses, describe chain, file source, and entity unescaping', () => {
    const entries = parseJUnitTestEntries(GOOD_REPORT)
    expect(entries).toEqual([
      { file: 'src/a.test.ts', path: 'outer > inner & tight', name: 'passes', status: 'passed' },
      { file: 'src/a.test.ts', path: 'outer > inner & tight', name: 'skips', status: 'skipped' },
      { file: 'src/a.test.ts', path: 'outer > inner & tight', name: 'a todo', status: 'todo' },
    ])
  })

  test('the executed file is the nearest suite frame, ./ stripped', () => {
    const entries = parseJUnitTestEntries(SECOND_REPORT)
    expect(entries).toEqual([
      { file: 'src/b.test.ts', path: '', name: 'top level, no describe', status: 'passed' },
    ])
  })

  test('a report carrying a failure is unusable', () => {
    const xml = GOOD_REPORT.replace(
      '<testcase name="passes" classname="inner &amp; tight &gt; outer &gt; passes" time="0.001"/>',
      '<testcase name="passes"><failure message="boom">nope</failure></testcase>'
    )
    expect(parseJUnitTestEntries(xml)).toBeNull()
  })

  test('malformed shapes fail closed', () => {
    expect(parseJUnitTestEntries('<testcase name="x"/>')).toBeNull() // no root
    expect(parseJUnitTestEntries('')).toBeNull()
    expect(
      parseJUnitTestEntries(
        GOOD_REPORT.replace('<skipped message="TODO"/></testcase>', '<skipped message="TODO"/>')
      )
    ).toBeNull() // unclosed testcase
    expect(
      parseJUnitTestEntries(GOOD_REPORT.replace('<testcase name="skips">', '<testcase>'))
    ).toBeNull() // no name
    // A describe suite without `line` contributes no name: only the inner
    // describe is left on the path.
    expect(
      parseJUnitTestEntries(
        GOOD_REPORT.replace('<testsuite name="outer" line="4">', '<testsuite name="outer">')
      ).map((entry) => entry.path)
    ).toEqual(['inner & tight', 'inner & tight', 'inner & tight'])
    expect(parseJUnitTestEntries('</testsuites>')).toBeNull() // stray close of the root suite
    expect(
      parseJUnitTestEntries(GOOD_REPORT.replace('</testsuites>', '</testsuite></testsuites>'))
    ).toBeNull() // unbalanced suite frames
  })
})

describe('the merge is all-or-nothing against the planned set (C1 point 2, C2 advisor review)', () => {
  /** Write the manifest the runner would: the plan before the reports. */
  function plan(...names: string[]) {
    writePlannedReports(dir, names)
  }

  // @covers: dev-checks › Full-check records list the tests that ran › Pass with its test list
  test('exactly the planned reports, every one parseable, merge into a sorted list', () => {
    plan('1-parallel-x.junit.xml', '2-real-tmux-y.junit.xml')
    report('1-parallel-x', GOOD_REPORT)
    report('2-real-tmux-y', SECOND_REPORT)
    const entries = mergeJUnitReports(dir)
    expect(entries?.map((entry) => [entry.file, entry.name])).toEqual([
      ['src/a.test.ts', 'a todo'],
      ['src/a.test.ts', 'passes'],
      ['src/a.test.ts', 'skips'],
      ['src/b.test.ts', 'top level, no describe'],
    ])
  })

  test('one malformed report among good planned ones yields no list at all', () => {
    plan('1-parallel-x.junit.xml', '2-real-tmux-y.junit.xml')
    report('1-parallel-x', GOOD_REPORT)
    report('2-real-tmux-y', '<testsuites><testsuite name="torn">')
    expect(mergeJUnitReports(dir)).toBeNull()
  })

  test('a planned report that never landed yields no list (vanish among good ones)', () => {
    // The C2 advisor's probe 4: the directory scan alone merges the survivor
    // and every test of the lost batch reads not-in-run — fabricated.
    plan('1-parallel-x.junit.xml', '2-real-tmux-y.junit.xml')
    report('1-parallel-x', GOOD_REPORT)
    expect(mergeJUnitReports(dir)).toBeNull()
  })

  test('a present planned report without testcases yields no list (a fabricated count 0 would read not-in-run)', () => {
    // An empty <testsuites> parses fine to zero entries: a planned report
    // that holds no testcase is an unusable one, not a quiet shrink.
    plan('1-parallel-x.junit.xml', '2-real-tmux-y.junit.xml')
    report('1-parallel-x', GOOD_REPORT)
    report('2-real-tmux-y', '<?xml version="1.0"?>\n<testsuites name="bun test" tests="0"></testsuites>')
    expect(mergeJUnitReports(dir)).toBeNull()
  })

  test('a report on disk beyond the planned set yields no list (a foreign writer sneaks nothing in)', () => {
    plan('1-parallel-x.junit.xml')
    report('1-parallel-x', GOOD_REPORT)
    report('9-nested-writer', SECOND_REPORT)
    expect(mergeJUnitReports(dir)).toBeNull()
  })

  test('no manifest, an unreadable one, or a malformed one yields no list — even with good reports', () => {
    report('1-parallel-x', GOOD_REPORT)
    expect(mergeJUnitReports(dir)).toBeNull() // no manifest at all
    fs.writeFileSync(path.join(dir, PLANNED_REPORTS_NAME), '{not json')
    expect(mergeJUnitReports(dir)).toBeNull()
    fs.writeFileSync(path.join(dir, PLANNED_REPORTS_NAME), '{"reports": "0-parallel-x.junit.xml"}')
    expect(mergeJUnitReports(dir)).toBeNull() // not an array
    fs.writeFileSync(path.join(dir, PLANNED_REPORTS_NAME), '{"reports": [7]}')
    expect(mergeJUnitReports(dir)).toBeNull() // not strings
    fs.writeFileSync(path.join(dir, PLANNED_REPORTS_NAME), '{"reports": ["0-parallel-x.xml"]}')
    expect(mergeJUnitReports(dir)).toBeNull() // not the report suffix
    fs.writeFileSync(path.join(dir, PLANNED_REPORTS_NAME), '{"reports": ["../x.junit.xml"]}')
    expect(mergeJUnitReports(dir)).toBeNull() // not a plain basename
    fs.writeFileSync(
      path.join(dir, PLANNED_REPORTS_NAME),
      '{"reports": ["1-a.junit.xml", "1-a.junit.xml"]}'
    )
    expect(mergeJUnitReports(dir)).toBeNull() // duplicates
  })

  test('an empty directory, a missing one, or reports with no manifest are null', () => {
    expect(mergeJUnitReports(dir)).toBeNull() // nothing written (a crashed run)
    expect(mergeJUnitReports(path.join(dir, 'missing'))).toBeNull()
    report('only', '')
    expect(mergeJUnitReports(dir)).toBeNull() // a lone unparseable report, still no plan
  })

  test('non-report files in the directory are ignored, the manifest still required', () => {
    plan('1-parallel-x.junit.xml')
    report('1-parallel-x', GOOD_REPORT)
    fs.writeFileSync(path.join(dir, 'timings.json'), '{}')
    expect(mergeJUnitReports(dir)?.map((entry) => entry.name)).toEqual(['a todo', 'passes', 'skips'])
  })
})

describe('the planned-report manifest', () => {
  // @covers: dev-checks › Full-check records list the tests that ran › Pass with its test list
  test('plannedReportNames reads the report basenames out of real planBatches output', () => {
    const batches = planBatches({
      workers: 1,
      mainFiles: ['src/a.test.ts'],
      serialFiles: ['integration.test.ts'],
      passthrough: [],
      skipRealTmux: false,
      junitReportDir: '/run/reports',
    })
    const names = plannedReportNames(batches)
    expect(names).toHaveLength(2)
    for (const name of names) {
      expect(name).toMatch(/^\d+-[\w-]+-\d+-\d+\.junit\.xml$/)
      expect(name.includes('/')).toBe(false)
    }
    // A caller carrying its own reporter plans nothing (planBatches drops
    // the directory): the manifest must stay empty, matching the disk.
    const overridden = planBatches({
      workers: 1,
      mainFiles: ['src/a.test.ts'],
      serialFiles: [],
      passthrough: ['--reporter-outfile=/hook/dir/changed.junit.xml'],
      skipRealTmux: true,
      junitReportDir: '/run/reports',
    })
    expect(plannedReportNames(overridden)).toEqual([])
  })

  test('the writer stores the sorted plan; the reader round-trips it', () => {
    writePlannedReports(dir, ['2-b.junit.xml', '1-a.junit.xml'])
    expect(readPlannedReports(dir)).toEqual(['1-a.junit.xml', '2-b.junit.xml'])
    expect(JSON.parse(fs.readFileSync(path.join(dir, PLANNED_REPORTS_NAME), 'utf8'))).toEqual({
      reports: ['1-a.junit.xml', '2-b.junit.xml'],
    })
  })

  test('the reader fails closed on the malformed shapes the merge refuses', () => {
    expect(readPlannedReports(dir)).toBeNull() // absent
    expect(readPlannedReports(path.join(dir, 'missing'))).toBeNull()
    for (const body of ['{not json', '[]', '{"reports": 3}', '{"reports": ["x.xml"]}', '{"reports": ["a.junit.xml", "a.junit.xml"]}']) {
      fs.writeFileSync(path.join(dir, PLANNED_REPORTS_NAME), body)
      expect(readPlannedReports(dir)).toBeNull()
    }
  })
})

describe('report naming is unique per invocation (K3)', () => {
  // @covers: dev-checks › Full-check records list the tests that ran › Interrupted writing
  test('same directory, distinct invocations, distinct paths', () => {
    const first = junitReportPath(dir, 0, 'parallel')
    const second = junitReportPath(dir, 1, 'real-tmux')
    expect(first).not.toBe(second)
    for (const reportPath of [first, second]) {
      expect(path.dirname(reportPath)).toBe(dir)
      expect(path.basename(reportPath)).toMatch(/^\d+-[\w-]+-\d+-\d+\.junit\.xml$/)
    }
    // The name embeds the pid, so two concurrent runs in one directory never
    // share a report even in the same millisecond.
    expect(junitReportPath(dir, 0, 'parallel')).toContain(`-${process.pid}.`)
  })

  test('reporter args are exactly the pair bun test needs', () => {
    expect(junitReporterArgs('/r/0-parallel-1-2.junit.xml')).toEqual([
      '--reporter=junit',
      '--reporter-outfile=/r/0-parallel-1-2.junit.xml',
    ])
  })
})

describe('trustworthyEntries revalidates through the shared validator', () => {
  test('a valid list passes; a shape-invalid entry rejects the whole list', () => {
    const good = [{ file: 'a.test.ts', path: '', name: 'x', status: 'passed' as const }]
    expect(trustworthyEntries(good)).toEqual(good)
    expect(trustworthyEntries(null)).toBeNull()
    expect(
      trustworthyEntries([{ file: 'a.test.ts', path: '', name: 'x', status: 'failed' as never }])
    ).toBeNull()
  })
})
