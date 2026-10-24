// junitReports.ts - JUnit report naming and the test-list merge
// (independent-verification D7). For a full check the runner writes one
// JUnit report per `bun test` invocation into a per-run directory; after
// the pass, the check pipeline merges them into the record's test list.
//
// The per-test reader here is new (C1 advisor point 7): per-result-suite's
// `parseJUnitExecutedFiles` extracts only the executed files from suite
// attributes, and neither hot file — affected-tests.ts, test-runner.ts —
// grows to host this one. The two readers share one convention by comment:
// an executed file is repo-relative with any leading `./` stripped.
//
// All-or-nothing (C1 advisor point 2): the merge returns entries only when
// every report in the directory parses completely. A missing, empty, or
// malformed report — or one carrying a failure, which a full pass cannot
// produce — yields no list at all, never a partial one: a partial merge
// would turn unreported tests into fabricated `not-in-run` answers.

import fs from 'node:fs'
import path from 'node:path'
import {
  compareTestListEntries,
  isTestListEntry,
  type TestListEntry,
} from '../../src/server/checks/testLists'

export const REPORT_SUFFIX = '.junit.xml'

/** The unique report path of one `bun test` invocation (K3): unique within
 * the run by batch index, unique across runs by time and pid, so a stale
 * report can never supply a later list even when callers share a
 * directory. The parallel main batch names its own like every other. */
export function junitReportPath(dir: string, index: number, kind: string): string {
  const stamp = `${Date.now()}-${process.pid}`
  return path.join(dir, `${index}-${kind}-${stamp}${REPORT_SUFFIX}`)
}

/** The reporter arguments a batch needs to write its report. */
export function junitReporterArgs(reportPath: string): string[] {
  return ['--reporter=junit', `--reporter-outfile=${reportPath}`]
}

// --- XML scanning ---

// A tag: name, attributes, and whether it closes or self-closes. The
// pattern tolerates quoted '>' inside attribute values; Bun escapes them
// as &gt; anyway, so the tolerant form is defense, not dependency.
const TAG = /<(\/?)([A-Za-z_][\w.:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g
const ATTRIBUTE = /([\w.:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g

function unescapeXml(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => safeCodePoint(hex, 16))
    .replace(/&#(\d+);/g, (_, dec: string) => safeCodePoint(dec, 10))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

function safeCodePoint(digits: string, radix: number): string {
  const code = Number.parseInt(digits, radix)
  return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ''
}

function parseAttributes(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  let match: RegExpExecArray | null
  ATTRIBUTE.lastIndex = 0
  while ((match = ATTRIBUTE.exec(raw)) !== null) {
    attrs[match[1]!] = unescapeXml(match[2] ?? match[3] ?? '')
  }
  return attrs
}

interface SuiteFrame {
  /** The executed file this suite contributes to childless testcases —
   * Bun repeats the file at every level, so the nearest is the right one
   * (D7 Open Question answer). */
  file: string | null
  /** The enclosing describe chain in source order; the file-level suite
   * (no `line` attribute) does not contribute a name. */
  describe: string[]
}

/** Convert one JUnit document into list entries, fail-closed: no
 * `<testsuites>` root, a stray close tag, a testcase without a name or
 * without any file source, or a failure/error child — none of which a
 * full pass produces — makes the whole report unusable (null). A skip is
 * `<skipped />`; a todo is `<skipped message="TODO" />` (4.1 spike). The
 * `name` attribute is the bare title `testTitles` extracts, not
 * describe-qualified (spike: describe-qualification rides `classname`,
 * which is reversed and unused). */
export function parseJUnitTestEntries(xml: string): TestListEntry[] | null {
  let sawRoot = false
  const suites: SuiteFrame[] = [{ file: null, describe: [] }]
  // Nesting depth of elements opened inside the current testcase, so a
  // nested </testcase>-looking construct cannot end it early.
  let testcase: { name: string; skipMessage: string | null; failed: boolean; depth: number } | null = null
  const entries: TestListEntry[] = []
  TAG.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = TAG.exec(xml)) !== null) {
    const [, closing, name, rawAttrs, selfClosing] = match as unknown as [string, string, string, string, string]
    const attrs = parseAttributes(rawAttrs)
    if (closing) {
      if (name === 'testsuites') continue
      if (name === 'testsuite') {
        if (suites.length <= 1) return null
        suites.pop()
        continue
      }
      if (testcase !== null) {
        if (name === 'testcase' && testcase.depth === 0) {
          if (testcase.failed) return null
          const file = suiteFile(suites)
          if (file === null) return null
          entries.push({
            file,
            path: suites[suites.length - 1]!.describe.join(' > '),
            name: testcase.name,
            status: testcase.skipMessage === 'TODO' ? 'todo' : 'skipped',
          })
          testcase = null
          continue
        }
        if (testcase.depth > 0) testcase.depth -= 1
        continue
      }
      continue
    }
    if (name === 'testsuites') {
      sawRoot = true
      continue
    }
    if (name === 'testsuite') {
      suites.push({
        file: attrs.file !== undefined ? attrs.file.replace(/^\.\//, '') : suites[suites.length - 1]!.file,
        describe:
          attrs.line !== undefined && attrs.name !== undefined
            ? [...suites[suites.length - 1]!.describe, attrs.name]
            : suites[suites.length - 1]!.describe,
      })
      continue
    }
    if (name === 'testcase') {
      if (testcase !== null) return null
      if (attrs.name === undefined) return null
      testcase = { name: attrs.name, skipMessage: null, failed: false, depth: 0 }
      if (selfClosing) {
        const file = suiteFile(suites)
        if (file === null) return null
        entries.push({ file, path: suites[suites.length - 1]!.describe.join(' > '), name: testcase.name, status: 'passed' })
        testcase = null
      }
      continue
    }
    if (testcase !== null) {
      if (name === 'skipped') testcase.skipMessage = attrs.message ?? ''
      else if (name === 'failure' || name === 'error') testcase.failed = true
      else if (!selfClosing) testcase.depth += 1
      continue
    }
    // Elements outside any testcase (properties, system-out) are skipped;
    // only their tags matter for nesting, and none nest a testcase.
  }
  if (!sawRoot) return null
  if (testcase !== null || suites.length !== 1) return null
  return entries
}

function suiteFile(suites: SuiteFrame[]): string | null {
  for (let index = suites.length - 1; index >= 0; index--) {
    const file = suites[index]!.file
    if (file !== null) return file
  }
  return null
}

/** Merge every report in the run's directory into the sorted entry list,
 * all-or-nothing: the directory must hold at least one report, every one of
 * them must parse (see parseJUnitTestEntries), and the union must be
 * non-empty. Anything less — a vanished report, a truncated one, a report
 * from a failed child, a run whose reports all kept only their root — is
 * `null`, and the caller records the pass without a list (K1: a partial or
 * empty list would fabricate `not-in-run` for the tests it drops; `null`
 * reads as run unknown instead). */
export function mergeJUnitReports(dir: string): TestListEntry[] | null {
  let names: string[]
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith(REPORT_SUFFIX)).sort()
  } catch {
    return null
  }
  if (names.length === 0) return null
  const entries: TestListEntry[] = []
  for (const name of names) {
    let xml: string
    try {
      xml = fs.readFileSync(path.join(dir, name), 'utf8')
    } catch {
      return null
    }
    const parsed = parseJUnitTestEntries(xml)
    if (parsed === null) return null
    entries.push(...parsed)
  }
  if (entries.length === 0) return null
  return entries.sort(compareTestListEntries)
}

/** Guard the merged list against a walker regression: revalidate every
 * entry through the shared validator, so a parser bug can never write a
 * list the reader would reject — it would write none instead (the two
 * sides agree by construction, C1 advisor point 3). */
export function trustworthyEntries(entries: TestListEntry[] | null): TestListEntry[] | null {
  if (entries === null) return null
  for (const entry of entries) {
    if (!isTestListEntry(entry)) return null
  }
  return entries
}


