// affectedReport.test.ts — the affected-test selection's report (task 2.2):
// the JUnit executed-file parser, the summary wording, and the wiring's
// report handling through scripted runner doubles that write the JUnit file
// at the report path they receive. Git-free: no repository is involved.
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import {
  formatSelectionReport,
  parseJUnitExecutedFiles,
  runAffectedTests,
  type AffectedSelection,
} from '../affected-tests'

// The real Bun 1.4.3 JUnit shape: one outer `<testsuite>` per executed file
// plus one nested `<testsuite>` per describe block, every level repeating
// the file in its `file` attribute.
const junitReport = (...files: string[]): string =>
  [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<testsuites name="bun test">',
    ...files.flatMap((file) => [
      `  <testsuite name="${file}" file="${file}" tests="1" failures="0">`,
      `    <testsuite name="outer" file="${file}" tests="1" failures="0"><testcase name="one" classname="outer" time="0.001"/></testsuite>`,
      '  </testsuite>',
    ]),
    '</testsuites>',
    '',
  ].join('\n')

// Captured from Bun 1.4.3 (`bun test --reporter=junit` over a file with two
// nested describe blocks), with the runner's hostname neutralized: four
// `<testsuite>` elements all carrying the same file attribute.
const CAPTURED_NESTED = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="3" assertions="3" failures="1" skipped="0" time="0.010563187">
  <testsuite name="nested.test.ts" file="nested.test.ts" tests="3" assertions="3" failures="1" skipped="0" time="0.00075327" hostname="runner">
    <testsuite name="outer" file="nested.test.ts" line="3" tests="3" assertions="3" failures="1" skipped="0" time="0" hostname="runner">
      <testsuite name="inner a" file="nested.test.ts" line="4" tests="1" assertions="1" failures="0" skipped="0" time="0" hostname="runner">
        <testcase name="one passes" classname="inner a &gt; outer" time="0.000008" file="nested.test.ts" line="5" assertions="1" />
      </testsuite>
      <testsuite name="inner b" file="nested.test.ts" line="9" tests="2" assertions="2" failures="1" skipped="0" time="0" hostname="runner">
        <testcase name="two passes" classname="inner b &gt; outer" time="0.000003" file="nested.test.ts" line="10" assertions="1" />
        <testcase name="three fails" classname="inner b &gt; outer" time="0.000133" file="nested.test.ts" line="13" assertions="1">
          <failure type="AssertionError" message="expect(received).toBe(expected)&#10;&#10;Expected: 4&#10;Received: 3&#10;">AssertionError: expect(received).toBe(expected)</failure>
        </testcase>
      </testsuite>
    </testsuite>
  </testsuite>
</testsuites>`

function literalSelection(partial: Partial<AffectedSelection>): AffectedSelection {
  return {
    kind: 'source',
    escapePaths: [],
    declarationFiles: [],
    changedPassFiles: [],
    slowTierExcluded: 0,
    workingTreeContributors: [],
    ...partial,
  }
}

interface PassCall {
  reportPath: string
}

// A scripted runner double: exits per call and, on success, writes the
// JUnit report the real child would leave at the report path it was given.
function scriptedPasses(calls: PassCall[], scripts: { exit: number; report?: string }[]) {
  return async (_cmd: string[], reportPath: string): Promise<number> => {
    calls.push({ reportPath })
    const step = scripts[Math.min(calls.length - 1, scripts.length - 1)]
    if (step.exit === 0 && step.report !== undefined) fs.writeFileSync(reportPath, step.report)
    return step.exit
  }
}

describe('parseJUnitExecutedFiles', () => {
  test('the captured Bun 1.4.3 output with nested describes reads as one executed file', () => {
    expect(parseJUnitExecutedFiles(CAPTURED_NESTED)).toEqual(['nested.test.ts'])
  })

  test('one unique entry per file, with ./ prefixes stripped', () => {
    const xml = junitReport('./src/a.test.ts', 'src/b.test.ts')
    expect(parseJUnitExecutedFiles(xml)).toEqual(['src/a.test.ts', 'src/b.test.ts'])
    const repeated = junitReport('src/a.test.ts', 'src/a.test.ts')
    expect(parseJUnitExecutedFiles(repeated)).toEqual(['src/a.test.ts'])
  })

  test('empty testsuites read as zero executed files', () => {
    expect(parseJUnitExecutedFiles('<testsuites name="bun test" tests="0"></testsuites>')).toEqual(
      []
    )
  })

  test('a document without a testsuites root is malformed', () => {
    expect(parseJUnitExecutedFiles('')).toBeNull()
    expect(parseJUnitExecutedFiles('not xml at all')).toBeNull()
    expect(parseJUnitExecutedFiles('<html><body>crash</body></html>')).toBeNull()
  })

  test('a testsuite without a file attribute is malformed', () => {
    const xml =
      '<testsuites name="bun test"><testsuite name="t" tests="1"></testsuite></testsuites>'
    expect(parseJUnitExecutedFiles(xml)).toBeNull()
  })
})

describe('formatSelectionReport', () => {
  test('the summary wording counts the reports, never the candidates', () => {
    expect(
      formatSelectionReport({
        executed: {
          declaration: ['src/a.test.ts', 'src/b.test.ts'],
          changed: ['src/c.test.ts', 'src/d.test.ts', 'src/e.test.ts'],
        },
        slowTierExcluded: 2,
      })
    ).toBe(
      'affected-tests: ran 5 test file(s) (declaration: 2, changed: 3); slow-tier candidates excluded: 2'
    )
  })

  test('a zero-affected run reads as zero of everything', () => {
    expect(
      formatSelectionReport({ executed: { declaration: [], changed: [] }, slowTierExcluded: 0 })
    ).toBe(
      'affected-tests: ran 0 test file(s) (declaration: 0, changed: 0); slow-tier candidates excluded: 0'
    )
  })
})

describe('runAffectedTests reads the passes’ reports', () => {
  test('the summary counts what the report lists, not the candidates', async () => {
    const calls: PassCall[] = []
    const outcome = await runAffectedTests({
      root: os.tmpdir(),
      selection: literalSelection({
        declarationFiles: ['src/declared.test.ts'],
        changedPassFiles: ['src/one.test.ts', 'src/two.test.ts', 'src/three.test.ts'],
        slowTierExcluded: 1,
      }),
      runPass: scriptedPasses(calls, [
        { exit: 0, report: junitReport('./src/declared.test.ts') },
        { exit: 0, report: junitReport('src/one.test.ts') },
      ]),
    })
    expect(outcome.code).toBe(0)
    expect(outcome.failures).toEqual([])
    expect(outcome.executed).toEqual({
      declaration: ['src/declared.test.ts'],
      changed: ['src/one.test.ts'],
    })
    expect(outcome.lines).toEqual([
      'affected-tests: ran 2 test file(s) (declaration: 1, changed: 1); slow-tier candidates excluded: 1',
    ])
  })

  test('a successful zero-affected --changed pass writes no report and counts as zero', async () => {
    const calls: PassCall[] = []
    const outcome = await runAffectedTests({
      root: os.tmpdir(),
      selection: literalSelection({ changedPassFiles: ['src/one.test.ts'] }),
      runPass: scriptedPasses(calls, [{ exit: 0 }]),
    })
    expect(outcome.code).toBe(0)
    expect(outcome.failures).toEqual([])
    expect(outcome.executed).toEqual({ declaration: [], changed: [] })
    expect(outcome.lines).toEqual([
      'affected-tests: ran 0 test file(s) (declaration: 0, changed: 0); slow-tier candidates excluded: 0',
    ])
  })

  test('a malformed report fails the run', async () => {
    const calls: PassCall[] = []
    const outcome = await runAffectedTests({
      root: os.tmpdir(),
      selection: literalSelection({ declarationFiles: ['src/declared.test.ts'] }),
      runPass: scriptedPasses(calls, [{ exit: 0, report: '<html>not junit</html>' }]),
    })
    expect(outcome.code).toBe(1)
    expect(outcome.failures).toEqual([
      `affected-tests: malformed JUnit report at ${calls[0].reportPath}`,
    ])
    expect(outcome.lines).toEqual([])
  })

  test('a declaration pass without a report fails and stops the changed pass', async () => {
    const calls: PassCall[] = []
    const outcome = await runAffectedTests({
      root: os.tmpdir(),
      selection: literalSelection({
        declarationFiles: ['src/declared.test.ts'],
        changedPassFiles: ['src/one.test.ts'],
      }),
      runPass: scriptedPasses(calls, [{ exit: 0 }]),
    })
    expect(outcome.code).toBe(1)
    expect(outcome.failures).toEqual([
      `affected-tests: declaration pass produced no JUnit report at ${calls[0].reportPath}`,
    ])
    expect(calls.length).toBe(1)
  })

  test('a failed child fails without reading a report', async () => {
    const calls: PassCall[] = []
    const outcome = await runAffectedTests({
      root: os.tmpdir(),
      selection: literalSelection({ changedPassFiles: ['src/one.test.ts'] }),
      runPass: scriptedPasses(calls, [{ exit: 3 }]),
    })
    expect(outcome.code).toBe(1)
    expect(outcome.failures).toEqual(['affected-tests: changed pass failed (exit 3)'])
    expect(outcome.lines).toEqual([])
  })

  test('a pass never inherits the earlier pass’s report', async () => {
    const calls: PassCall[] = []
    const outcome = await runAffectedTests({
      root: os.tmpdir(),
      selection: literalSelection({
        declarationFiles: ['src/declared.test.ts'],
        changedPassFiles: ['src/one.test.ts'],
      }),
      runPass: scriptedPasses(calls, [
        { exit: 0, report: junitReport('src/declared.test.ts') },
        { exit: 0 },
      ]),
    })
    expect(outcome.code).toBe(0)
    expect(outcome.executed).toEqual({ declaration: ['src/declared.test.ts'], changed: [] })
    expect(calls.length).toBe(2)
    expect(calls[0].reportPath).not.toBe(calls[1].reportPath)
    expect(outcome.lines).toEqual([
      'affected-tests: ran 1 test file(s) (declaration: 1, changed: 0); slow-tier candidates excluded: 0',
    ])
  })

  test('the escape line names the matched paths and runs no pass', async () => {
    const calls: PassCall[] = []
    const outcome = await runAffectedTests({
      root: os.tmpdir(),
      selection: literalSelection({ kind: 'escape', escapePaths: ['bun.lock', '.bun-version'] }),
      runPass: scriptedPasses(calls, [{ exit: 0, report: junitReport('src/one.test.ts') }]),
      runFullCheck: async () => 0,
    })
    expect(outcome.code).toBe(0)
    expect(calls).toEqual([])
    expect(outcome.lines).toEqual([
      'affected-tests: escape matched bun.lock, .bun-version; running the full check',
    ])
  })

  test('working-tree contributors are reported before the summary', async () => {
    const calls: PassCall[] = []
    const outcome = await runAffectedTests({
      root: os.tmpdir(),
      selection: literalSelection({
        workingTreeContributors: ['notes/manual.md'],
        declarationFiles: ['src/declared.test.ts'],
      }),
      runPass: scriptedPasses(calls, [{ exit: 0, report: junitReport('src/declared.test.ts') }]),
    })
    expect(outcome.code).toBe(0)
    expect(outcome.lines).toEqual([
      'affected-tests: unstaged/untracked paths affected selection: notes/manual.md',
      'affected-tests: ran 1 test file(s) (declaration: 1, changed: 0); slow-tier candidates excluded: 0',
    ])
  })
})
