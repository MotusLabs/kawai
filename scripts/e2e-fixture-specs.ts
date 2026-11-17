// e2e-fixture-specs.ts - The fixture step's spec lister (ci-fixture-specs D1):
// lists the suite twice (`--list --reporter=json`, fixture off and on) and
// prints the files whose tests flip from skipped to runnable, sorted, one per
// line, echoing them on stderr for the job log (A9): the step captures stdout
// into $specs and CI's dot reporter names no files. The step's `run` assigns
// this output to Playwright (ci.yml D3). A listing that fails, reports an
// error, is not the shape read here, or flips nothing refuses with exit 1
// (I4). The guard checks run over the real tree too (D2); `status` is never read (I1).
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

export const FIXTURE_VAR = 'AGENTBOARD_CHAT_FIXTURE'

export type ListerResult =
  | { kind: 'files'; files: string[] }
  | { kind: 'refusal'; reason: string }

export type Violation = { subject: string; problem: string }

type JsonRecord = Record<string, unknown>

// ---------- The pure listing rule (D1) ----------
// A file is listed exactly when one of its tests has an expectedStatus other
// than "skipped" with the fixture on and is "skipped" or absent without it.
// Tests match by project name and title path; one-listing-only = absent.
type ListingEntries = { rootDir: string; entries: Map<string, string> }

function readListing(side: string, listing: unknown, repoRoot: string): ListingEntries | string {
  if (typeof listing !== 'object' || listing === null || Array.isArray(listing)) {
    return `${side} listing is not a JSON object`
  }
  const record = listing as JsonRecord
  if (record.errors !== undefined) {
    if (!Array.isArray(record.errors)) return `${side} listing: errors is not an array`
    if (record.errors.length > 0) {
      const first = record.errors[0]
      const message =
        typeof (first as JsonRecord | null)?.message === 'string'
          ? (first as JsonRecord).message
          : JSON.stringify(first)
      return `${side} listing reported an error: ${message}`
    }
  }
  const config = record.config
  const rootDir = typeof config === 'object' && config !== null ? (config as JsonRecord).rootDir : undefined
  if (typeof rootDir !== 'string' || rootDir === '') {
    return `${side} listing: config.rootDir is missing`
  }
  if (!Array.isArray(record.suites)) {
    return `${side} listing: suites is missing or not an array`
  }
  const entries = new Map<string, string>()
  for (const suite of record.suites) {
    const error = collectSuite(side, suite, [], null, rootDir, repoRoot, entries)
    if (error !== null) return error
  }
  return { rootDir, entries }
}

function collectSuite(
  side: string,
  suite: unknown,
  describes: string[],
  file: string | null,
  rootDir: string,
  repoRoot: string,
  entries: Map<string, string>,
): string | null {
  if (typeof suite !== 'object' || suite === null || Array.isArray(suite)) {
    return `${side} listing: a suite is not an object`
  }
  const record = suite as JsonRecord
  let suiteFile = file
  if (suiteFile === null) {
    // The top-level suites are the files; their `file` is relative to rootDir.
    if (typeof record.file !== 'string' || record.file === '') {
      return `${side} listing: a suite is missing its file`
    }
    suiteFile = path.relative(repoRoot, path.join(rootDir, record.file))
  } else if (typeof record.title !== 'string') {
    return `${side} listing: a describe suite is missing its title`
  }
  const nextDescribes = file === null ? describes : [...describes, record.title as string]
  if (Array.isArray(record.suites)) {
    for (const nested of record.suites) {
      const error = collectSuite(side, nested, nextDescribes, suiteFile, rootDir, repoRoot, entries)
      if (error !== null) return error
    }
  }
  if (Array.isArray(record.specs)) {
    for (const spec of record.specs) {
      const error = collectSpec(side, spec, nextDescribes, suiteFile, entries)
      if (error !== null) return error
    }
  }
  return null
}

function collectSpec(
  side: string,
  spec: unknown,
  describes: string[],
  repoFile: string,
  entries: Map<string, string>,
): string | null {
  if (typeof spec !== 'object' || spec === null || Array.isArray(spec)) {
    return `${side} listing: a spec is not an object`
  }
  const record = spec as JsonRecord
  if (typeof record.title !== 'string') return `${side} listing: a spec is missing its title`
  if (!Array.isArray(record.tests)) return `${side} listing: spec "${record.title}" has no tests array`
  const titlePath = [...describes, record.title].join('\u0000')
  for (const test of record.tests) {
    if (typeof test !== 'object' || test === null || Array.isArray(test)) {
      return `${side} listing: spec "${record.title}" has a test that is not an object`
    }
    const testRecord = test as JsonRecord
    if (typeof testRecord.projectName !== 'string') {
      return `${side} listing: test "${record.title}" carries no project name`
    }
    if (typeof testRecord.expectedStatus !== 'string') {
      return `${side} listing: test "${record.title}" carries no expectedStatus`
    }
    const key = `${repoFile}\u0000${testRecord.projectName}\u0000${titlePath}`
    entries.set(key, testRecord.expectedStatus)
  }
  return null
}

/** Decide the fixture-gated files from the two parsed listings (A1/A2/A3).
 * Returns the sorted repository-relative paths, or a refusal naming its
 * cause. `status` is never read. */
export function pickFixtureSpecs(repoRoot: string, off: unknown, on: unknown): ListerResult {
  const refuse = (reason: string): ListerResult => ({ kind: 'refusal', reason })
  const readOff = readListing('fixture-off', off, repoRoot)
  if (typeof readOff === 'string') return refuse(readOff)
  const readOn = readListing('fixture-on', on, repoRoot)
  if (typeof readOn === 'string') return refuse(readOn)
  const files = new Set<string>()
  for (const [key, expectedOn] of readOn.entries) {
    if (expectedOn === 'skipped') continue
    const expectedOff = readOff.entries.get(key)
    if (expectedOff === undefined || expectedOff === 'skipped') files.add(key.split('\u0000')[0])
  }
  if (files.size === 0) {
    return refuse('no spec file has a test Playwright runs only with the fixture on')
  }
  return { kind: 'files', files: [...files].sort() }
}

// ---------- The runner and the CLI (D1) ----------
// Each listing runs `bunx playwright test --list --reporter=json` from
// repoRoot in its own new E2E_TMUX_TMPDIR dir, removed before it settles (I5).

type ListingSide = 'fixture-off' | 'fixture-on'

type ListingOutcome = { side: ListingSide; code: number; stdout: string; stderr: string }

function runListing(repoRoot: string, side: ListingSide, withFixture: boolean): Promise<ListingOutcome> {
  const tmpDir = mkdtempSync(path.join(tmpdir(), 'e2e-fixture-specs-'))
  const childTmp = path.join(tmpDir, 'tmp') // Playwright's transform cache
  mkdirSync(childTmp)
  const outcome: ListingOutcome = { side, code: -1, stdout: '', stderr: '' }
  const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: childTmp, TMP: childTmp, TEMP: childTmp, E2E_TMUX_TMPDIR: tmpDir }
  // Playwright refuses to run under Jest (JEST_WORKER_ID, which bun test
  // --parallel workers set); this child is not a Jest worker.
  delete env.JEST_WORKER_ID
  if (withFixture) env[FIXTURE_VAR] = '1'
  else delete env[FIXTURE_VAR]
  return new Promise<ListingOutcome>((resolve) => {
    const child = spawn('bunx', ['playwright', 'test', '--list', '--reporter=json'], {
      cwd: repoRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.on('data', (chunk: Buffer) => {
      outcome.stdout += String(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      outcome.stderr += String(chunk)
    })
    child.on('error', (error: Error) => {
      outcome.stderr += error.message
      resolve(outcome)
    })
    child.on('close', (code: number | null) => {
      outcome.code = code ?? -1
      resolve(outcome)
    })
  }).finally(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })
}

const UNPARSED = Symbol('unparsed')

function outcomeRefusal(outcome: ListingOutcome, parsed: unknown): string | null {
  const detail = outcome.stderr.trim()
  if (parsed === UNPARSED) {
    return `${outcome.side} listing printed no valid JSON${detail === '' ? '' : `: ${detail}`}`
  }
  const record = parsed as JsonRecord
  const errors = Array.isArray(record.errors) ? (record.errors as unknown[]) : []
  if (errors.length > 0) {
    const first = errors[0] as JsonRecord | null
    const message = typeof first?.message === 'string' ? first.message : JSON.stringify(first)
    return `${outcome.side} listing reported an error: ${message}`
  }
  if (outcome.code !== 0) {
    return `${outcome.side} listing exited with code ${outcome.code}${detail === '' ? '' : `: ${detail}`}`
  }
  return null
}

/** List the fixture-gated files; exit 1 on a refusal (A3); echo the list on
 * stderr so the job log names the files (A9). */
export async function runCli(
  repoRoot: string,
  out: { log: (line: string) => void; error: (line: string) => void },
): Promise<number> {
  const [off, on] = await Promise.all([runListing(repoRoot, 'fixture-off', false), runListing(repoRoot, 'fixture-on', true)])
  const parsed = [off, on].map((outcome) => {
    try {
      return JSON.parse(outcome.stdout) as unknown
    } catch {
      return UNPARSED
    }
  })
  for (let index = 0; index < parsed.length; index += 1) {
    const refusal = outcomeRefusal([off, on][index], parsed[index])
    if (refusal !== null) {
      out.error(`scripts/e2e-fixture-specs: ${refusal}`)
      return 1
    }
  }
  const picked = pickFixtureSpecs(repoRoot, parsed[0], parsed[1])
  if (picked.kind === 'refusal') {
    out.error(`scripts/e2e-fixture-specs: ${picked.reason}`)
    return 1
  }
  for (const file of picked.files) out.log(file)
  out.error(`scripts/e2e-fixture-specs: ${picked.files.length} fixture specs: ${picked.files.join(' ')}`)
  return 0
}

if (import.meta.main) {
  process.exitCode = await runCli(process.cwd(), { log: console.log, error: console.error })
}

// ---------- The guard checks (D2) ----------
// Pure functions; proven over fixture inputs by the unit test, then run once
// over the real tree (V3): every file under tests/ referring to the variable
// other than to set it to '0' must be listed, and the step runs exactly those.

const ASSIGN_ALLOWLIST = [FIXTURE_VAR, 'NODE_ENV', 'E2E_PORT']
const OPTION_ALLOWLIST = ['workers']
const STEP_KEYS_ALLOWLIST = ['name', 'run']

/** Join continued shell lines (a trailing backslash), drop blanks and
 * comment lines, and return the remaining lines as the run's commands. */
export function shellCommands(run: string): string[] {
  const commands: string[] = []
  let pending: string | null = null
  const flush = () => {
    if (pending === null) return
    const trimmed = pending.trim()
    if (trimmed !== '' && !trimmed.startsWith('#')) commands.push(trimmed)
    pending = null
  }
  for (const rawLine of run.split('\n')) {
    const line = rawLine.trimEnd()
    const continues = line.endsWith('\\')
    const body = continues ? line.slice(0, -1).trimEnd() : line
    pending = pending === null ? body : `${pending} ${body.trimStart()}`
    if (!continues) flush()
  }
  flush()
  return commands
}

type WorkflowStep = { job: string; index: number; step: JsonRecord }

function jobSteps(workflow: JsonRecord): WorkflowStep[] {
  const found: WorkflowStep[] = []
  const jobs = workflow.jobs
  if (typeof jobs !== 'object' || jobs === null || Array.isArray(jobs)) return found
  for (const [jobName, job] of Object.entries(jobs as JsonRecord)) {
    if (typeof job !== 'object' || job === null || Array.isArray(job)) continue
    const steps = (job as JsonRecord).steps
    if (!Array.isArray(steps)) continue
    steps.forEach((step, index) => {
      if (typeof step === 'object' && step !== null && !Array.isArray(step)) {
        found.push({ job: jobName, index, step: step as JsonRecord })
      }
    })
  }
  return found
}

function stepSubject(step: WorkflowStep): string {
  const name = typeof step.step.name === 'string' ? step.step.name : `#${step.index}`
  return `step '${name}' of job ${step.job}`
}

/** Check the parsed ci.yml (D2): the fixture variable appears only in the
 * fixture step's run; that step holds only name and run; its job has no
 * continue-on-error; and its run is exactly the lister assignment plus the
 * allowed environment assignments and Playwright invocation. Returns the
 * violations, each naming its subject; an empty list passes. */
export function checkFixtureStep(workflow: unknown): Violation[] {
  if (typeof workflow !== 'object' || workflow === null || Array.isArray(workflow)) {
    return [{ subject: 'workflow', problem: 'is not an object' }]
  }
  const violations: Violation[] = []
  const doc = workflow as JsonRecord
  const steps = jobSteps(doc)
  // The fixture step is the one whose run assigns the lister's output; the
  // variable alone would miss a run whose assignments dropped it.
  const withVar = steps.filter(
    (step) =>
      typeof step.step.run === 'string' &&
      ((step.step.run as string).includes(FIXTURE_VAR) || (step.step.run as string).includes('scripts/e2e-fixture-specs.ts')),
  )
  if (withVar.length === 0) {
    return [{ subject: 'workflow', problem: `no step's run assigns the fixture spec list or mentions ${FIXTURE_VAR}` }]
  }
  const fixtureStep = withVar[0]
  const subject = stepSubject(fixtureStep)
  for (const extra of withVar.slice(1)) {
    violations.push({
      subject: stepSubject(extra),
      problem: `${FIXTURE_VAR} appears in more than one step's run`,
    })
  }
  const job = (doc.jobs as JsonRecord)[fixtureStep.job] as JsonRecord
  if ('continue-on-error' in job) {
    violations.push({ subject: `job ${fixtureStep.job}`, problem: 'gains continue-on-error' })
  }
  for (const key of Object.keys(fixtureStep.step)) {
    if (!STEP_KEYS_ALLOWLIST.includes(key)) {
      violations.push({ subject, problem: `holds key "${key}" beyond name and run` })
    }
  }
  const run = fixtureStep.step.run as string
  const commands = shellCommands(run)
  if (commands.length !== 2) {
    violations.push({ subject, problem: `run must be exactly two commands, found ${commands.length}` })
  } else {
    violations.push(...checkRunCommands(commands, subject))
  }
  violations.push(...variableElsewhere(doc, fixtureStep, run))
  return violations
}

/** Check the two commands: the lister assignment, then the env assignments
 * and the Playwright invocation with exactly one $<name>. */
function checkRunCommands(commands: string[], subject: string): Violation[] {
  const violations: Violation[] = []
  const assigned = /^([A-Za-z_][A-Za-z0-9_]*)=\$\(bun scripts\/e2e-fixture-specs\.ts\)$/.exec(commands[0])
  if (assigned === null) {
    violations.push({
      subject,
      problem: `first command must assign "$(bun scripts/e2e-fixture-specs.ts)", found "${commands[0]}"`,
    })
    return violations
  }
  const variable = assigned[1]
  const tokens = commands[1].split(/\s+/)
  const assignments = new Map<string, string>()
  let cursor = 0
  for (; cursor < tokens.length; cursor += 1) {
    const pair = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(tokens[cursor])
    if (pair === null) break
    if (!ASSIGN_ALLOWLIST.includes(pair[1])) {
      violations.push({ subject, problem: `assignment "${pair[1]}" is outside the allowlist` })
    }
    assignments.set(pair[1], pair[2])
  }
  const rest = tokens.slice(cursor)
  if (assignments.get(FIXTURE_VAR) !== '1') {
    violations.push({ subject, problem: `${FIXTURE_VAR}=1 is missing from the assignments` })
  }
  if (rest[0] !== 'bunx' || rest[1] !== 'playwright' || rest[2] !== 'test') {
    violations.push({
      subject,
      problem: `must invoke "bunx playwright test", found "${rest.slice(0, 3).join(' ')}"`,
    })
    return violations
  }
  let passedVariable = false
  for (const token of rest.slice(3)) {
    if (token === `$${variable}`) {
      if (passedVariable) {
        violations.push({ subject, problem: `passes $${variable} more than once` })
      }
      passedVariable = true
      continue
    }
    const option = /^--([A-Za-z][A-Za-z0-9-]*)=(.+)$/.exec(token)
    if (option !== null && OPTION_ALLOWLIST.includes(option[1])) continue
    violations.push({ subject, problem: `unexpected Playwright argument "${token}"` })
  }
  if (!passedVariable) {
    violations.push({ subject, problem: `passes Playwright no $${variable} at all` })
  }
  return violations
}

/** Flag every other place the variable appears: another step's run or env,
 * a job's or the workflow's env, any other string or key. */
function variableElsewhere(doc: JsonRecord, fixtureStep: WorkflowStep, fixtureRun: string): Violation[] {
  const violations: Violation[] = []
  const runLocation = `workflow › jobs › ${fixtureStep.job} › steps[${fixtureStep.index}] › run`
  const walk = (value: unknown, location: string): void => {
    if (typeof value === 'string') {
      if (value === fixtureRun && location === runLocation) return
      if (value.includes(FIXTURE_VAR)) {
        violations.push({
          subject: location,
          problem: `${FIXTURE_VAR} appears outside the fixture step's run`,
        })
      }
      return
    }
    if (Array.isArray(value)) {
      value.forEach((entry, index) => walk(entry, `${location}[${index}]`))
      return
    }
    if (typeof value === 'object' && value !== null) {
      for (const [key, entry] of Object.entries(value as JsonRecord)) {
        if (key.includes(FIXTURE_VAR)) {
          violations.push({
            subject: `${location} › key "${key}"`,
            problem: `${FIXTURE_VAR} appears outside the fixture step's run`,
          })
        }
        walk(entry, `${location} › ${key}`)
      }
    }
  }
  walk(doc, 'workflow')
  return violations
}

// ---------- The readers check (D2) ----------
// Neither listing sees a skip inside a hook or a test body, and a file the
// configuration stops collecting is absent from both listings. So every file
// under tests/ the lister does not list may refer to the fixture variable
// only to set it to '0' — the name, then ':' or '=', then a quoted zero,
// with whitespace and one closing quote or bracket allowed between. Any
// other occurrence fails, naming the file and line; listed files pass
// whatever they read. The check reads text and parses nothing.

const ZERO_SETTING = /^\s*['"\]]*\s*[:=]\s*(['"])0\1/

export function checkUnlistedReaders(
  files: readonly { path: string; content: string }[],
  listed: readonly string[],
): Violation[] {
  const listedSet = new Set(listed)
  const violations: Violation[] = []
  for (const file of files) {
    if (listedSet.has(file.path)) continue
    let index = file.content.indexOf(FIXTURE_VAR)
    while (index !== -1) {
      if (!ZERO_SETTING.test(file.content.slice(index + FIXTURE_VAR.length))) {
        const line = file.content.slice(0, index).split('\n').length
        violations.push({
          subject: `${file.path}:${line}`,
          problem: `refers to ${FIXTURE_VAR} without setting it to '0', and the lister does not list the file`,
        })
      }
      index = file.content.indexOf(FIXTURE_VAR, index + FIXTURE_VAR.length)
    }
  }
  return violations
}

/** Every file under `dir`, repo-relative with forward slashes, with content. */
export function readTestsTree(repoRoot: string, dir = 'tests'): { path: string; content: string }[] {
  const files: { path: string; content: string }[] = []
  const stack = [path.join(repoRoot, dir)]
  while (stack.length > 0) {
    const current = stack.pop() as string
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else if (entry.isFile()) {
        files.push({
          path: path.relative(repoRoot, full).split(path.sep).join('/'),
          content: readFileSync(full, 'utf8'),
        })
      }
    }
  }
  return files
}
