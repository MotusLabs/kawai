// specCoverage.ts — the `@covers` annotation grammar and the scenario index
// (independent-verification D8, tasks 5.1–5.2).
//
// A test names the spec scenario it covers with a comment line
//
//   // @covers: <capability> › <requirement> › <scenario>
//
// directly above its `test`/`it` call (blank lines, comments, and stacked
// annotations aside). The guard's unit test (scripts/__tests__/
// specCoverageGuard.test.ts) fails the suite when an annotation names no
// scenario of the main specs or of an active change's delta specs, is not
// directly above a test, when a spec name itself contains the ` › `
// separator, or when a scenario of a newly archived change (an archive
// dated on or after coverage.json's `since`, not exempt, still present in
// the main specs under its current names) has no annotation. Archived
// deltas are index sources for nothing: an old name they still hold fails
// as stale. Fix a failing annotation in place; never loosen this grammar.

import fs from 'node:fs'
import path from 'node:path'

export const COVERAGE_CONFIG_PATH = 'openspec/coverage.json'

// The corpus the guard scans for annotations: every unit and e2e test file
// (D8). Sorted glob output keeps failure order deterministic.
export const SCAN_GLOBS = [
  'src/**/*.test.ts',
  'src/**/*.test.tsx',
  'scripts/**/*.test.ts',
  'tests/e2e/**/*.spec.ts',
] as const

export type CoverageFailureKind =
  | 'config' // coverage.json missing, unreadable, or malformed
  | 'separator-in-name' // a spec name itself contains the ` › ` separator
  | 'annotation-unresolved' // names no scenario of the index
  | 'annotation-not-above-test' // not directly above a test call
  | 'stale-exemption' // an exempt entry names no existing change
  | 'uncovered-scenario' // a required scenario no annotation covers

export interface CoverageFailure {
  kind: CoverageFailureKind
  file: string // repository-relative, or the annotation's own file
  line: number // 1-based; 0 when the failure has no line of its own
  message: string
}

export interface ScenarioKey {
  capability: string
  requirement: string
  scenario: string
}

export function scenarioName(key: ScenarioKey): string {
  return `${key.capability} › ${key.requirement} › ${key.scenario}`
}

export interface CoverageConfig {
  since: string // YYYY-MM-DD; archives dated on or after it are required
  exempt: string[] // change names whose scenarios are not required
}

// An annotation line and the name it carries. One name per line; several
// annotations may stack above one test.
export interface Annotation {
  file: string
  line: number
  name: string
}

const ANNOTATION_RE = /^\s*\/\/\s*@covers:\s*(\S.*?)\s*$/
// The next non-blank, non-comment line after an annotation must open a
// `test(` or `it(` call, modifiers included: `test.skip(`, `it.each(…)(`.
// A bare-word suffix (`testx(`) does not match; the generic arguments of
// `test<T>(` may not contain parentheses.
const TEST_OPENER_RE = /^(?:test|it)\s*(?:\.[A-Za-z_$][\w$]*)*\s*(?:<[^()]*>)?\s*\(/

// --- spec parsing ---

const SECTION_RE = /^##\s+(.+?)\s*$/
const REQUIREMENT_RE = /^### Requirement:\s*(.+?)\s*$/
const SCENARIO_RE = /^#### Scenario:\s*(.+?)\s*$/

// One requirement/scenario pair of a spec file, with the `## <section>`
// header it sits under (`null` in a main spec, which has no delta
// sections). Sections matter to the required set: only ADDED and MODIFIED
// count.
export interface SpecPair {
  key: ScenarioKey
  line: number
  section: string | null
}

// Parses the requirement/scenario pairs of one spec source. Names that
// themselves contain ` › ` cannot be annotated, so they are collected as
// failures naming the spec file and line; the caller decides whether its
// source counts (main specs and active deltas do, archives do not).
export function parseSpecSource(
  file: string,
  capability: string,
  source: string
): { pairs: SpecPair[]; separatorErrors: CoverageFailure[] } {
  const pairs: SpecPair[] = []
  const separatorErrors: CoverageFailure[] = []
  let section: string | null = null
  let requirement: { name: string; line: number } | null = null
  const lines = source.split('\n')
  const checkName = (name: string, line: number): boolean => {
    if (!name.includes(' › ')) return true
    separatorErrors.push({
      kind: 'separator-in-name',
      file,
      line,
      message: `${file}:${line} names "${name}", which contains the " › " separator and can never be annotated`,
    })
    return false
  }
  for (let index = 0; index < lines.length; index++) {
    const heading = REQUIREMENT_RE.exec(lines[index]!)
    if (heading !== null) {
      const name = heading[1]!
      checkName(name, index + 1)
      requirement = { name, line: index + 1 }
      continue
    }
    const scenario = SCENARIO_RE.exec(lines[index]!)
    if (scenario !== null) {
      const name = scenario[1]!
      if (requirement === null || !checkName(name, index + 1)) continue
      pairs.push({
        key: { capability, requirement: requirement.name, scenario: name },
        line: index + 1,
        section,
      })
      continue
    }
    const sectionHeading = SECTION_RE.exec(lines[index]!)
    if (sectionHeading !== null) {
      section = sectionHeading[1]!
      requirement = null
    }
  }
  return { pairs, separatorErrors }
}

// --- annotation parsing ---

function isBlankOrComment(trimmed: string): boolean {
  return (
    trimmed === '' || trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')
  )
}

// Parses one test file's annotations and checks their position: the next
// line that is neither blank nor a comment must open a `test(`/`it(` call
// (E4). A failure names the annotation's file and line (E2).
export function parseAnnotations(
  file: string,
  source: string
): { annotations: Annotation[]; positionFailures: CoverageFailure[] } {
  const annotations: Annotation[] = []
  const positionFailures: CoverageFailure[] = []
  const lines = source.split('\n')
  for (let index = 0; index < lines.length; index++) {
    const match = ANNOTATION_RE.exec(lines[index]!)
    if (match === null) continue
    const annotation: Annotation = { file, line: index + 1, name: match[1]! }
    annotations.push(annotation)
    let cursor = index + 1
    while (cursor < lines.length && isBlankOrComment(lines[cursor]!.trim())) cursor += 1
    if (cursor >= lines.length || !TEST_OPENER_RE.test(lines[cursor]!.trim())) {
      positionFailures.push({
        kind: 'annotation-not-above-test',
        file,
        line: annotation.line,
        message: `${file}:${annotation.line} is not directly above a test call`,
      })
    }
  }
  return { annotations, positionFailures }
}

// --- configuration ---

// Parses coverage.json's text (null when the file is missing). The guard
// fails closed: a missing, unreadable, or malformed file is one `config`
// failure, never an empty required set.
export function parseCoverageConfig(source: string | null): {
  config: CoverageConfig | null
  failures: CoverageFailure[]
} {
  if (source === null) {
    return {
      config: null,
      failures: [
        {
          kind: 'config',
          file: COVERAGE_CONFIG_PATH,
          line: 0,
          message: `${COVERAGE_CONFIG_PATH} is missing; the guard cannot know the required scenarios`,
        },
      ],
    }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  } catch {
    parsed = undefined
  }
  const candidate = parsed as Partial<CoverageConfig> | undefined
  if (
    candidate === undefined ||
    candidate === null ||
    typeof candidate !== 'object' ||
    typeof candidate.since !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(candidate.since) ||
    !Array.isArray(candidate.exempt) ||
    candidate.exempt.some((entry) => typeof entry !== 'string')
  ) {
    return {
      config: null,
      failures: [
        {
          kind: 'config',
          file: COVERAGE_CONFIG_PATH,
          line: 0,
          message: `${COVERAGE_CONFIG_PATH} must hold {"since": "YYYY-MM-DD", "exempt": [<change names>]}`,
        },
      ],
    }
  }
  return { config: { since: candidate.since, exempt: candidate.exempt as string[] }, failures: [] }
}

// --- the scenario index and the required set ---

function listFiles(root: string, globs: readonly string[]): string[] {
  const found = new Set<string>()
  for (const glob of globs) {
    for (const file of new Bun.Glob(glob).scanSync({ cwd: root, onlyFiles: true })) {
      found.add(file)
    }
  }
  return [...found].sort()
}

function specDirs(root: string, base: string): { capability: string; file: string }[] {
  const absolute = path.join(root, base)
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(absolute, { withFileTypes: true })
  } catch {
    return []
  }
  const found: { capability: string; file: string }[] = []
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (!entry.isDirectory()) continue
    const file = path.posix.join(base, entry.name, 'spec.md')
    if (fs.existsSync(path.join(root, file))) found.push({ capability: entry.name, file })
  }
  return found
}

export interface ScenarioIndex {
  names: Set<string> // `capability › requirement › scenario`
  mainNames: Set<string> // the same, main specs only
  failures: CoverageFailure[]
}

// The names an annotation may resolve against: every scenario of the main
// specs plus every section of every active change's delta specs (E1).
// Archived deltas are index sources for nothing.
export function buildScenarioIndex(root: string): ScenarioIndex {
  const names = new Set<string>()
  const mainNames = new Set<string>()
  const failures: CoverageFailure[] = []
  const add = (file: string, capability: string, main: boolean): void => {
    const source = fs.readFileSync(path.join(root, file), 'utf8')
    const { pairs, separatorErrors } = parseSpecSource(file, capability, source)
    failures.push(...separatorErrors)
    for (const pair of pairs) {
      const name = scenarioName(pair.key)
      names.add(name)
      if (main) mainNames.add(name)
    }
  }
  for (const spec of specDirs(root, 'openspec/specs')) add(spec.file, spec.capability, true)
  const changes = path.join(root, 'openspec/changes')
  let active: fs.Dirent[] = []
  try {
    active = fs.readdirSync(changes, { withFileTypes: true })
  } catch {
    return { names, mainNames, failures }
  }
  for (const change of active.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (!change.isDirectory() || change.name === 'archive') continue
    for (const spec of specDirs(root, path.posix.join('openspec/changes', change.name, 'specs'))) {
      add(spec.file, spec.capability, false)
    }
  }
  return { names, mainNames, failures }
}

// True when `name` is an active change directory or an archived change
// (`<date>-<name>`, matched on the exact name after the date prefix), so an
// exempt entry naming neither fails (E2).
export function changeExists(root: string, name: string): boolean {
  if (fs.existsSync(path.join(root, 'openspec/changes', name))) return true
  const archive = path.join(root, 'openspec/changes/archive')
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(archive, { withFileTypes: true })
  } catch {
    return false
  }
  return entries.some((entry) => {
    const match = ARCHIVE_RE.exec(entry.name)
    return entry.isDirectory() && match !== null && match[2] === name
  })
}

const ARCHIVE_RE = /^(\d{4}-\d{2}-\d{2})-(.+)$/

// The required set (E3): every scenario of an ADDED or MODIFIED requirement
// of a non-exempt archive dated on or after `since` that still exists in the
// main specs under its current names, attributed to its change.
export function requiredScenarios(
  root: string,
  config: CoverageConfig,
  mainNames: Set<string>
): Map<string, ScenarioKey[]> {
  const required = new Map<string, ScenarioKey[]>()
  const archive = path.join(root, 'openspec/changes/archive')
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(archive, { withFileTypes: true })
  } catch {
    return required
  }
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (!entry.isDirectory()) continue
    const match = ARCHIVE_RE.exec(entry.name)
    if (match === null) continue
    const [, date, change] = match
    if (date! < config.since || config.exempt.includes(change!)) continue
    for (const spec of specDirs(root, path.posix.join('openspec/changes/archive', entry.name, 'specs'))) {
      const source = fs.readFileSync(path.join(root, spec.file), 'utf8')
      const { pairs } = parseSpecSource(spec.file, spec.capability, source)
      for (const pair of pairs) {
        if (pair.section === null) continue
        if (!pair.section.startsWith('ADDED') && !pair.section.startsWith('MODIFIED')) continue
        const name = scenarioName(pair.key)
        if (!mainNames.has(name)) continue
        const list = required.get(change!) ?? []
        if (!list.some((key) => scenarioName(key) === name)) list.push(pair.key)
        required.set(change!, list)
      }
    }
  }
  return required
}

// --- the guard ---

const KIND_ORDER: CoverageFailureKind[] = [
  'config',
  'separator-in-name',
  'annotation-unresolved',
  'annotation-not-above-test',
  'stale-exemption',
  'uncovered-scenario',
]

export interface GuardResult {
  failures: CoverageFailure[]
  filesScanned: number
}

function readOrNull(root: string, relative: string): string | null {
  try {
    return fs.readFileSync(path.join(root, relative), 'utf8')
  } catch {
    return null
  }
}

// Runs the whole guard over the repository (or fixture tree) at `root`:
// annotation resolution and placement over the scanned test files, the
// separator check over the index sources, exemption existence, and the
// required set's coverage. Failures come back sorted, so tests and CI see
// one order.
export function runSpecCoverageGuard(root: string): GuardResult {
  const failures: CoverageFailure[] = []
  const index = buildScenarioIndex(root)
  failures.push(...index.failures)
  let filesScanned = 0
  const covered = new Set<string>()
  for (const file of listFiles(root, SCAN_GLOBS)) {
    filesScanned += 1
    const { annotations, positionFailures } = parseAnnotations(file, readOrNull(root, file) ?? '')
    failures.push(...positionFailures)
    for (const annotation of annotations) {
      const parts = annotation.name.split(' › ')
      if (parts.length === 3 && index.names.has(annotation.name)) {
        covered.add(annotation.name)
        continue
      }
      failures.push({
        kind: 'annotation-unresolved',
        file: annotation.file,
        line: annotation.line,
        message: `${annotation.file}:${annotation.line} names "${annotation.name}", which is no scenario of the main specs or an active change's delta specs`,
      })
    }
  }
  const { config, failures: configFailures } = parseCoverageConfig(
    readOrNull(root, COVERAGE_CONFIG_PATH)
  )
  failures.push(...configFailures)
  if (config !== null) {
    for (const entry of config.exempt) {
      if (!changeExists(root, entry)) {
        failures.push({
          kind: 'stale-exemption',
          file: COVERAGE_CONFIG_PATH,
          line: 0,
          message: `exempt entry "${entry}" names no active or archived change`,
        })
      }
    }
    const required = requiredScenarios(root, config, index.mainNames)
    for (const change of [...required.keys()].sort()) {
      for (const key of required.get(change)!) {
        if (covered.has(scenarioName(key))) continue
        failures.push({
          kind: 'uncovered-scenario',
          file: COVERAGE_CONFIG_PATH,
          line: 0,
          message: `${scenarioName(key)} of archived change "${change}" has no @covers annotation`,
        })
      }
    }
  }
  failures.sort(
    (a, b) =>
      KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) ||
      (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) ||
      a.line - b.line ||
      (a.message < b.message ? -1 : 1)
  )
  return { failures, filesScanned }
}
