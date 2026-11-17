// e2eFixtureSpecs.test.ts - The unit-suite guard for the e2e fixture step
// (ci-fixture-specs D2, tasks 1.1/1.2/2.1): the lister's pure rule (V1), the
// CLI over a temporary repository (V2), the guards over counterexamples (V3),
// and each check once over the real tree.
// @reads: .github/workflows/ci.yml
import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  checkFixtureStep,
  checkUnlistedReaders,
  pickFixtureSpecs,
  readTestsTree,
  runCli,
  type ListerResult,
} from '../e2e-fixture-specs'

const SCRIPT = path.resolve(import.meta.dir, '..', 'e2e-fixture-specs.ts')
const REPO_ROOT = path.resolve(import.meta.dir, '..', '..')
const BUN_BIN = path.dirname(process.execPath)
const FIXTURE_VAR = 'AGENTBOARD_CHAT_FIXTURE'

// ---------- fixture listings for the pure rule ----------

type SpecDef = { title: string; describes?: string[]; project?: string; expected: string; status?: string }

function suiteFor(file: string, tests: SpecDef[]): Record<string, unknown> {
  const root: Record<string, unknown> = { title: file, file, specs: [], suites: [] }
  for (const def of tests) {
    let parent = root
    for (const title of def.describes ?? []) {
      const suites = parent.suites as Record<string, unknown>[]
      let nested = suites.find((suite) => suite.title === title)
      if (!nested) suites.push((nested = { title, suites: [], specs: [] }))
      parent = nested
    }
    ;(parent.specs as Record<string, unknown>[]).push({
      title: def.title,
      tests: [{ projectName: def.project ?? '', expectedStatus: def.expected, status: def.status ?? 'skipped' }],
    })
  }
  return root
}

const listing = (files: Record<string, unknown>[], rootDir = path.join(REPO_ROOT, 'tests/e2e')): Record<string, unknown> => ({
  config: { rootDir },
  suites: files,
  errors: [],
})

function firstTestOf(sideListing: Record<string, unknown>): Record<string, unknown> {
  const specs = (sideListing.suites as Record<string, unknown>[])[0].specs as Record<string, unknown>[]
  return (specs[0].tests as Record<string, unknown>[])[0]
}

function expectFiles(result: ListerResult): string[] {
  expect(result.kind).toBe('files')
  return (result as { kind: 'files'; files: string[] }).files
}

function expectRefusal(result: ListerResult): string {
  expect(result.kind).toBe('refusal')
  return (result as { kind: 'refusal'; reason: string }).reason
}

// ---------- helpers for the CLI runs over temporary repositories ----------

const specSrc = (...lines: string[]) => `import { test } from '@playwright/test'\n${lines.join('\n')}\n`

const GATED_TOP = specSrc(`test.skip(process.env.${FIXTURE_VAR} !== '1', 'fixture')`, `test('top gated', async () => {})`)
const HELPER_SRC =
  `import { test } from '@playwright/test'\nexport function skipWithoutFixture(): void {\n` +
  `  test.skip(process.env.${FIXTURE_VAR} !== '1', 'fixture')\n}\n`
const GATED_THROUGH_HELPER =
  `import { test } from '@playwright/test'\nimport { skipWithoutFixture } from './support/helper'\n` +
  `skipWithoutFixture()\ntest('helper gated', async () => {})\n`
const GATED_DESCRIBE_DEEP =
  `import { test } from '@playwright/test'\ntest.describe('outer', () => {\n` +
  `  test.skip(process.env.${FIXTURE_VAR} !== '1', 'fixture')\n  test('nested gated', async () => {})\n})\n`
const UNGATED = specSrc(`test('always runs', async () => {})`)
const ZERO_SET = specSrc(`process.env.${FIXTURE_VAR} = '0'`, `test('zeroed', async () => {})`)
const SKIPPED_BOTH_WAYS = specSrc(`test.skip(process.env.REAL_MODEL_OPT_IN !== '1', 'real models only')`, `test('real gated', async () => {})`)

function makeTempRepo(specs: Record<string, string>): string {
  const repo = mkdtempSync(path.join(tmpdir(), 'cifs-repo-'))
  symlinkSync(path.join(REPO_ROOT, 'node_modules'), path.join(repo, 'node_modules'), 'dir')
  writeFileSync(
    path.join(repo, 'playwright.config.ts'),
    `import { defineConfig } from '@playwright/test'\nexport default defineConfig({ testDir: 'tests/e2e' })\n`,
  )
  for (const [name, content] of Object.entries(specs)) {
    const full = path.join(repo, 'tests', 'e2e', name)
    mkdirSync(path.dirname(full), { recursive: true })
    writeFileSync(full, content)
  }
  return repo
}

// The runner's --parallel workers set JEST_WORKER_ID; the lister must strip
// it before spawning Playwright (it refuses to run under Jest), so every
// spawned-CLI test here carries the marker as its regression control.
function runLister(repo: string, extraEnv: Record<string, string> = {}) {
  return spawnSync(process.execPath, [SCRIPT], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, JEST_WORKER_ID: '1', PATH: `${BUN_BIN}:${process.env.PATH ?? ''}`, ...extraEnv },
    timeout: 90000,
  })
}

// ---------- the pure listing rule over fixture listings ----------

describe('pickFixtureSpecs', () => {
    // @covers: github-workflows › CI runs every fixture-gated e2e spec › New fixture spec
  test('lists a file whose test flips from skipped to runnable, or only exists with the fixture', () => {
    const off = listing([suiteFor('gated.spec.ts', [{ title: 't', expected: 'skipped' }])])
    const on = listing([suiteFor('gated.spec.ts', [{ title: 't', expected: 'passed' }])])
    expect(expectFiles(pickFixtureSpecs(REPO_ROOT, off, on))).toEqual(['tests/e2e/gated.spec.ts'])
    const absentOff = listing([suiteFor('conditional.spec.ts', [{ title: 'kept', expected: 'passed' }])])
    const presentOn = listing([
      suiteFor('conditional.spec.ts', [
        { title: 'kept', expected: 'passed' },
        { title: 'declared under the fixture only', expected: 'passed' },
      ]),
    ])
    expect(expectFiles(pickFixtureSpecs(REPO_ROOT, absentOff, presentOn))).toEqual(['tests/e2e/conditional.spec.ts'])
    const invertedOff = listing([suiteFor('inverted.spec.ts', [{ title: 'flips', expected: 'skipped' }])])
    const invertedOn = listing([suiteFor('inverted.spec.ts', [{ title: 'flips', expected: 'failed' }])])
    expect(expectFiles(pickFixtureSpecs(REPO_ROOT, invertedOff, invertedOn))).toEqual(['tests/e2e/inverted.spec.ts'])
  })

    // @covers: github-workflows › CI runs every fixture-gated e2e spec › Specs outside the fixture
  test('a file whose tests run both ways is not listed, nor a test skipped both ways', () => {
    for (const expected of ['passed', 'skipped']) {
      const off = listing([
        suiteFor('other.spec.ts', [{ title: 't', expected }]),
        suiteFor('gated.spec.ts', [{ title: 't', expected: 'skipped' }]),
      ])
      const on = listing([
        suiteFor('other.spec.ts', [{ title: 't', expected }]),
        suiteFor('gated.spec.ts', [{ title: 't', expected: 'passed' }]),
      ])
      expect(expectFiles(pickFixtureSpecs(REPO_ROOT, off, on))).toEqual(['tests/e2e/gated.spec.ts'])
    }
  })

  test('project and title-path matching tell same-titled tests apart; one flipping project lists once', () => {
    // The flipping identity comes first: a key-collapse mutant lets the last entry win, losing the flip, and fails below.
    const twin = (describes: string[], expected: string) => ({ title: 'same title', describes, expected })
    const twinOff = listing([suiteFor('twin.spec.ts', [twin(['B'], 'skipped'), twin(['A'], 'passed')])])
    const twinOn = listing([suiteFor('twin.spec.ts', [twin(['B'], 'passed'), twin(['A'], 'passed')])])
    expect(expectFiles(pickFixtureSpecs(REPO_ROOT, twinOff, twinOn))).toEqual(['tests/e2e/twin.spec.ts'])
    const byProject = (project: string, expected: string) => ({ title: 't', project, expected })
    const projOff = listing([suiteFor('two.spec.ts', [byProject('chromium', 'skipped'), byProject('firefox', 'skipped')])])
    const projOn = listing([suiteFor('two.spec.ts', [byProject('chromium', 'passed'), byProject('firefox', 'skipped')])])
    expect(expectFiles(pickFixtureSpecs(REPO_ROOT, projOff, projOn))).toEqual(['tests/e2e/two.spec.ts'])
  })

  test('every test reading status: skipped changes nothing; only expectedStatus is read', () => {
    const off = listing([suiteFor('status.spec.ts', [{ title: 't', expected: 'skipped', status: 'passed' }])])
    const on = listing([suiteFor('status.spec.ts', [{ title: 't', expected: 'passed', status: 'skipped' }])])
    expect(expectFiles(pickFixtureSpecs(REPO_ROOT, off, on))).toEqual(['tests/e2e/status.spec.ts'])
    const idle = listing([suiteFor('idle.spec.ts', [{ title: 't', expected: 'skipped', status: 'passed' }])])
    expect(pickFixtureSpecs(REPO_ROOT, idle, idle).kind).toBe('refusal')
  })

    // @covers: github-workflows › CI runs every fixture-gated e2e spec › Listing fails or finds nothing
  test('refuses a bad listing on either side, naming each cause', () => {
    const good = listing([suiteFor('gated.spec.ts', [{ title: 't', expected: 'skipped' }])])
    const fresh = () => listing([suiteFor('gated.spec.ts', [{ title: 't', expected: 'passed' }])])
    const mutations: [string, (side: Record<string, unknown>) => void][] = [
      ['reported an error: spec load failed', (side) => { side.errors = [{ message: 'spec load failed' }] }],
      ['config.rootDir is missing', (side) => { delete side.config }],
      ['suites is missing', (side) => { delete side.suites }],
      ['carries no expectedStatus', (side) => { delete firstTestOf(side).expectedStatus }],
      ['carries no project name', (side) => { delete firstTestOf(side).projectName }],
    ]
    for (const [cause, mutate] of mutations) {
      const asOn = fresh()
      mutate(asOn)
      expect(expectRefusal(pickFixtureSpecs(REPO_ROOT, good, asOn)), cause).toContain(cause)
      const asOff = fresh()
      mutate(asOff)
      expect(expectRefusal(pickFixtureSpecs(REPO_ROOT, asOff, good)), cause).toContain(cause)
    }
  })

  test('refuses an empty result — nothing flips', () => {
    const both = listing([suiteFor('idle.spec.ts', [{ title: 't', expected: 'passed' }])])
    expect(expectRefusal(pickFixtureSpecs(REPO_ROOT, both, both))).toContain('no spec file has a test')
  })
})

// ---------- the CLI over a temporary repository ----------

describe('the lister CLI', () => {
    // @covers: github-workflows › CI runs every fixture-gated e2e spec › Nested or describe-level gate
  test('prints the gated specs and omits the ungated, zeroed, and both-ways-skipped ones', () => {
    const repo = makeTempRepo({
      'gated-top.spec.ts': GATED_TOP,
      'nested/deep/gated-nested.spec.ts': GATED_DESCRIBE_DEEP,
      'helper-gated.spec.ts': GATED_THROUGH_HELPER,
      'support/helper.ts': HELPER_SRC,
      'ungated.spec.ts': UNGATED,
      'zeroed.spec.ts': ZERO_SET,
      'real-gated.spec.ts': SKIPPED_BOTH_WAYS,
    })
    try {
      const result = runLister(repo, { AGENTBOARD_CHAT_FIXTURE: 'irrelevant-in-parent' })
      expect(result.status, result.stderr).toBe(0)
      const expected = ['tests/e2e/gated-top.spec.ts', 'tests/e2e/helper-gated.spec.ts', 'tests/e2e/nested/deep/gated-nested.spec.ts']
      expect((result.stdout ?? '').trim().split('\n').sort()).toEqual(expected)
      // stdout lands in the workflow's $specs; the job log names the files only through the stderr echo (A9).
      for (const file of expected) expect(result.stderr, file).toContain(file)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  }, 90000)

    // @covers: github-workflows › CI runs every fixture-gated e2e spec › Listing fails or finds nothing
  test('failure paths exit 1: a load error reaches stderr; a tree with no gated spec refuses', () => {
    const broken = makeTempRepo({
      'gated-top.spec.ts': GATED_TOP,
      'broken.spec.ts': `import { test } from '@playwright/test'\nthrow new Error('load probe failure XYZPROBE')\n`,
    })
    const empty = makeTempRepo({ 'ungated.spec.ts': UNGATED, 'zeroed.spec.ts': ZERO_SET })
    try {
      const loadError = runLister(broken)
      expect(loadError.status).toBe(1)
      expect(loadError.stderr).toContain('load probe failure XYZPROBE')
      expect(loadError.stdout).toBe('')
      const noGated = runLister(empty)
      expect(noGated.status).toBe(1)
      expect(noGated.stderr.trim()).not.toBe('')
      expect(noGated.stdout).toBe('')
    } finally {
      rmSync(broken, { recursive: true, force: true })
      rmSync(empty, { recursive: true, force: true })
    }
  }, 120000)

  test('over the real repository the run leaves the system temporary directory as it found it', () => {
    const scratch = mkdtempSync(path.join(tmpdir(), 'cifs-scratch-'))
    try {
      const result = runLister(REPO_ROOT, { TMPDIR: scratch })
      expect(result.status, result.stderr).toBe(0)
      const printed = (result.stdout ?? '').split('\n').filter((line) => line !== '')
      expect(printed.length, 'prints a non-empty list').toBeGreaterThan(0)
      expect(printed).toEqual([...printed].sort())
      expect(new Set(printed).size, 'each file once').toBe(printed.length)
      expect(printed.every((file) => existsSync(path.join(REPO_ROOT, file))), 'listed files exist').toBe(true)
      for (const named of ['chat-activity', 'chat-auto-approve', 'chat-workers']) {
        expect(printed.some((file) => file.endsWith(`${named}.spec.ts`)), named).toBe(true)
      }
      expect(readdirSync(scratch), 'the temporary directory is left empty').toEqual([])
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  }, 120000)
})

// ---------- the step check over fixture workflows ----------

const FIXTURE_RUN =
  'specs=$(bun scripts/e2e-fixture-specs.ts)\nNODE_ENV=development AGENTBOARD_CHAT_FIXTURE=1 E2E_PORT=4174 bunx playwright test $specs --workers=1'
const FIXTURE_STEP_NAME = 'Run chat fixture e2e tests'

function baseWorkflow(): Record<string, unknown> {
  return {
    name: 'check',
    on: { push: { branches: ['master'] }, pull_request: {} },
    env: {},
    jobs: {
      changes: { steps: [{ name: 'Classify', run: 'scripts/docs-only-changes.sh' }] },
      e2e: {
        needs: 'changes',
        if: "${{ !cancelled() && needs.changes.outputs.docs_only != 'true' }}",
        'runs-on': 'ubuntu-24.04',
        steps: [
          { name: 'Checkout', uses: 'actions/checkout@v7' },
          { name: 'Install dependencies', run: 'bun install --frozen-lockfile' },
          { name: 'Build', run: 'bun run build' },
          { name: 'Run e2e tests', run: 'bunx playwright test --workers=1' },
          { name: FIXTURE_STEP_NAME, run: FIXTURE_RUN },
        ],
      },
    },
  }
}

type StepCase = {
  label: string
  subject: string
  run?: string
  stepKeys?: Record<string, unknown>
  jobKeys?: Record<string, unknown>
  mainRun?: string
  buildEnv?: Record<string, unknown>
  jobEnv?: Record<string, unknown>
  workflowEnv?: Record<string, unknown>
}

const withArgs = (args: string) => `${FIXTURE_RUN}${args}`

describe('checkFixtureStep', () => {
  function editedWorkflow(stepCase: StepCase): Record<string, unknown> {
    const workflow = baseWorkflow()
    const e2e = (workflow.jobs as Record<string, unknown>).e2e as Record<string, unknown>
    const steps = e2e.steps as Record<string, unknown>[]
    const named = (name: string) => steps.find((step) => step.name === name) as Record<string, unknown>
    Object.assign(named(FIXTURE_STEP_NAME), {
      ...(stepCase.run !== undefined ? { run: stepCase.run } : {}),
      ...stepCase.stepKeys,
    })
    Object.assign(e2e, { ...stepCase.jobKeys, ...(stepCase.jobEnv !== undefined ? { env: stepCase.jobEnv } : {}) })
    if (stepCase.mainRun !== undefined) named('Run e2e tests').run = stepCase.mainRun
    if (stepCase.buildEnv !== undefined) named('Build').env = stepCase.buildEnv
    if (stepCase.workflowEnv !== undefined) workflow.env = stepCase.workflowEnv
    return workflow
  }

  function expectNamedViolations(stepCase: StepCase): void {
    const violations = checkFixtureStep(editedWorkflow(stepCase))
    expect(violations.length, JSON.stringify(violations)).toBeGreaterThan(0)
    expect(
      violations.some((violation) => violation.subject.includes(stepCase.subject)),
      JSON.stringify(violations),
    ).toBe(true)
  }

  test('passes the exact two-command step and the continued-lines spelling of it', () => {
    expect(checkFixtureStep(baseWorkflow())).toEqual([])
    const continued = baseWorkflow()
    const e2e = (continued.jobs as Record<string, unknown>).e2e as Record<string, unknown>
    const steps = e2e.steps as Record<string, unknown>[]
    steps[steps.length - 1].run =
      'specs=$(bun scripts/e2e-fixture-specs.ts)\nNODE_ENV=development AGENTBOARD_CHAT_FIXTURE=1 \\\nE2E_PORT=4174 bunx playwright test $specs \\\n--workers=1'
    expect(checkFixtureStep(continued)).toEqual([])
  })

  test('fails when the variable appears nowhere, naming the workflow', () => {
    const workflow = baseWorkflow()
    const e2e = (workflow.jobs as Record<string, unknown>).e2e as Record<string, unknown>
    e2e.steps = (e2e.steps as Record<string, unknown>[]).filter((step) => step.name !== FIXTURE_STEP_NAME)
    const violations = checkFixtureStep(workflow)
    expect(violations.length).toBeGreaterThan(0)
    expect(violations[0].subject).toBe('workflow')
  })

  const literalListCases: StepCase[] = [
    { label: 'a tests/e2e/ path', subject: FIXTURE_STEP_NAME, run: withArgs(' tests/e2e/chat.spec.ts') },
    { label: 'a bare spec name', subject: FIXTURE_STEP_NAME, run: withArgs(' chat.spec.ts') },
    { label: 'the tests/e2e directory', subject: FIXTURE_STEP_NAME, run: withArgs(' tests/e2e') },
    { label: './tests/e2e', subject: FIXTURE_STEP_NAME, run: withArgs(' ./tests/e2e') },
    { label: 'a glob', subject: FIXTURE_STEP_NAME, run: withArgs(` 'tests/e2e/*.spec.ts'`) },
    { label: 'an option value as a separate word', subject: FIXTURE_STEP_NAME, run: withArgs(' --workers 1') },
  ]
  for (const stepCase of literalListCases) {
      // @covers: github-workflows › The unit suite guards the fixture list › Literal list in the workflow
    test(`fails on ${stepCase.label}, naming its subject`, () => {
      expectNamedViolations(stepCase)
    })
  }

    // @covers: github-workflows › The unit suite guards the fixture list › Narrowing option
  test('fails on a narrowing option, naming its subject', () => {
    expectNamedViolations({ label: 'grep', subject: FIXTURE_STEP_NAME, run: withArgs(' --grep=chat') })
  })

  const outputCases: StepCase[] = [
    { label: 'a missing lister assignment', subject: FIXTURE_STEP_NAME, run: 'NODE_ENV=development AGENTBOARD_CHAT_FIXTURE=1 E2E_PORT=4174 bunx playwright test --workers=1' },
    { label: 'a third command', subject: FIXTURE_STEP_NAME, run: withArgs('\necho listed') },
    { label: 'a variable other than the one it assigns', subject: FIXTURE_STEP_NAME, run: FIXTURE_RUN.replace('$specs', '$list') },
    { label: 'no $<name> at all', subject: FIXTURE_STEP_NAME, run: FIXTURE_RUN.replace(' $specs', '') },
    { label: 'an assignment outside the allowlist', subject: FIXTURE_STEP_NAME, run: FIXTURE_RUN.replace('NODE_ENV=', 'NO_CACHE=1 NODE_ENV=') },
    { label: 'AGENTBOARD_CHAT_FIXTURE=1 missing', subject: FIXTURE_STEP_NAME, run: FIXTURE_RUN.replace('AGENTBOARD_CHAT_FIXTURE=1 ', '') },
  ]
  for (const stepCase of outputCases) {
      // @covers: github-workflows › The unit suite guards the fixture list › Output not passed to Playwright
    test(`fails on ${stepCase.label}, naming its subject`, () => {
      expectNamedViolations(stepCase)
    })
  }

  const conditionalCases: StepCase[] = [
    { label: 'a step condition', subject: FIXTURE_STEP_NAME, stepKeys: { if: 'false' } },
    { label: 'a failure-tolerant step', subject: FIXTURE_STEP_NAME, stepKeys: { 'continue-on-error': true } },
    { label: 'another shell', subject: FIXTURE_STEP_NAME, stepKeys: { shell: 'bash' } },
    { label: 'a working directory', subject: FIXTURE_STEP_NAME, stepKeys: { 'working-directory': '.' } },
    { label: 'a step env', subject: FIXTURE_STEP_NAME, stepKeys: { env: { FOO: 'bar' } } },
    { label: 'a failure-tolerant job', subject: 'job e2e', jobKeys: { 'continue-on-error': true } },
  ]
  for (const stepCase of conditionalCases) {
      // @covers: github-workflows › The unit suite guards the fixture list › Conditional or failure-tolerant step
    test(`fails on ${stepCase.label}, naming its subject`, () => {
      expectNamedViolations(stepCase)
    })
  }

  const elsewhereCases: StepCase[] = [
    { label: 'the variable in another step run', subject: 'Run e2e tests', mainRun: 'echo AGENTBOARD_CHAT_FIXTURE && bunx playwright test --workers=1' },
    { label: 'the variable in another step env', subject: 'env', buildEnv: { AGENTBOARD_CHAT_FIXTURE: '0' } },
    { label: 'the variable in a job env', subject: 'jobs › e2e › env', jobEnv: { AGENTBOARD_CHAT_FIXTURE: '1' } },
    { label: 'the variable in the workflow env', subject: 'workflow › env', workflowEnv: { AGENTBOARD_CHAT_FIXTURE: '1' } },
  ]
  for (const stepCase of elsewhereCases) {
      // @covers: github-workflows › The unit suite guards the fixture list › Fixture variable elsewhere in the workflow
    test(`fails on ${stepCase.label}, naming its subject`, () => {
      expectNamedViolations(stepCase)
    })
  }
})

// ---------- the readers check over fixture files ----------

describe('checkUnlistedReaders', () => {
  const LISTED = ['tests/e2e/listed.spec.ts']
  const gateCases: { label: string; path: string; content: string }[] = [
    { label: 'a top-level spec gating in beforeEach', path: 'tests/e2e/hook-gated.spec.ts', content: `test.beforeEach(() => { test.skip(process.env.${FIXTURE_VAR} !== '1', 'fixture') })\n` },
    { label: 'a subdirectory spec gating in a test body', path: 'tests/e2e/nested/body-gated.spec.ts', content: `test('t', () => { test.skip(process.env.${FIXTURE_VAR} !== '1', 'fixture') })\n` },
    { label: 'a helper under tests/e2e/support', path: 'tests/e2e/support/gate.ts', content: `export const gate = process.env.${FIXTURE_VAR} !== '1'\n` },
    { label: 'a file under tests/fixtures', path: 'tests/fixtures/env.ts', content: `export const env = { ${FIXTURE_VAR}: '1' }\n` },
    { label: 'a mention in a comment', path: 'tests/e2e/commented.spec.ts', content: `// The server reads ${FIXTURE_VAR} before any test runs.\ntest('t', async () => {})\n` },
    { label: 'a spec the configuration no longer collects', path: 'tests/e2e/orphan.spec.ts', content: `test.skip(process.env.${FIXTURE_VAR} !== '1', 'fixture')\ntest('orphan', async () => {})\n` },
  ]

    // @covers: github-workflows › The unit suite guards the fixture list › Gate the listing cannot see
  test('fails on every gate the listing cannot see, naming the file', () => {
    for (const gateCase of gateCases) {
      const violations = checkUnlistedReaders([{ path: gateCase.path, content: gateCase.content }], LISTED)
      expect(violations.length, gateCase.label).toBeGreaterThan(0)
      expect(violations.every((violation) => violation.subject.startsWith(gateCase.path)), gateCase.label).toBe(true)
    }
  })

    // @covers: github-workflows › The unit suite guards the fixture list › Spec the configuration stops collecting
  test('fails on the uncollected spec, naming it (configuration stops collecting)', () => {
    const violations = checkUnlistedReaders(
      [{ path: 'tests/e2e/dropped.spec.ts', content: `test.skip(process.env.${FIXTURE_VAR} !== '1', 'f')\n` }],
      LISTED,
    )
    expect(violations.length).toBeGreaterThan(0)
    expect(violations[0].subject.startsWith('tests/e2e/dropped.spec.ts')).toBe(true)
  })

  test('passes zero settings in both forms and either quote, and a listed file whatever it reads', () => {
    const zeros = [
      `env: { ${FIXTURE_VAR}: '0' },`,
      `env2: { ${FIXTURE_VAR}: "0" },`,
      `process.env.${FIXTURE_VAR} = '0'`,
      `process.env.${FIXTURE_VAR}="0"`,
      `map['${FIXTURE_VAR}'] = '0'`,
    ].join('\n')
    expect(checkUnlistedReaders([{ path: 'tests/e2e/zeroed.spec.ts', content: zeros }], LISTED)).toEqual([])
    const listedContent = `${zeros}\ntest.skip(process.env.${FIXTURE_VAR} !== '1', 'a gate in a listed file')`
    expect(checkUnlistedReaders([{ path: LISTED[0], content: listedContent }], LISTED)).toEqual([])
  })
})

// ---------- the checks over the real tree ----------

const parseCi = () =>
  Bun.YAML.parse(readFileSync(path.join(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8')) as Record<string, unknown>

function realFixtureStep(workflow: Record<string, unknown>): Record<string, unknown> {
  const e2e = (workflow.jobs as Record<string, unknown>).e2e as Record<string, unknown>
  const steps = e2e.steps as Record<string, unknown>[]
  return steps.find((step) => step.name === FIXTURE_STEP_NAME) as Record<string, unknown>
}

describe('over the real tree', () => {
  test('the step check passes over ci.yml parsed with Bun.YAML.parse', () => {
    expect(checkFixtureStep(parseCi())).toEqual([])
  })

  test('the step check still fails when the hand-written list returns', () => {
    const workflow = parseCi()
    const fixtureStep = realFixtureStep(workflow)
    fixtureStep.run = `${(fixtureStep.run as string).split('\n')[1]} tests/e2e/chat-activity.spec.ts`
    const violations: Violation[] = checkFixtureStep(workflow)
    expect(violations.length).toBeGreaterThan(0)
    expect(violations.some((violation) => violation.subject.includes(FIXTURE_STEP_NAME))).toBe(true)
  })

  test('the readers check passes over tests/ with the real list', async () => {
    const printed: string[] = []
    const errors: string[] = []
    const code = await runCli(REPO_ROOT, { log: (line) => printed.push(line), error: (line) => errors.push(line) })
    expect(code).toBe(0)
    expect(printed.length).toBeGreaterThan(0)
    // The workflow captures stdout into $specs; the e2e job log names the files only through the stderr echo (A9).
    const logged = errors.join('\n')
    for (const file of printed) expect(logged, file).toContain(file)
    expect(checkUnlistedReaders(readTestsTree(REPO_ROOT), printed)).toEqual([])
  }, 120000)
})
