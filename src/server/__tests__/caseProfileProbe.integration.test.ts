// caseProfileProbe.integration.test.ts - The case-profile wiring of
// check-time-optimization D4 (task 4.3, A3) through the production
// composition: the real `runCheck` pipeline whose test step is the real unit
// runner, in a temporary git repository holding the probe fixture
// (scripts/__tests__/fixtures/caseProfile/caseCount.test.ts) and a copy of
// the propertyCases helper. The probe declares 300 cases and writes the
// seeds it executed. Default: 75, the first 75 seeds, recorded `reduced`;
// CI=true: 300, `full`; --full-properties: 300, `full`.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { readRecord, recordsDir } from '../checks/checkRecords'
import { runGit } from '../git/gitCommand'
import { runCheck } from '../../../scripts/lib/checkRun'

const REPO_ROOT = path.resolve(import.meta.dir, '..', '..', '..')
const RUNNER = path.join(REPO_ROOT, 'scripts', 'test-runner.ts')
const PROBE = path.join(REPO_ROOT, 'scripts', '__tests__', 'fixtures', 'caseProfile', 'caseCount.test.ts')
const HELPER = path.join(import.meta.dir, 'helpers', 'propertyCases.ts')
const COMMIT_ENV = {
  GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.com',
}
// Beneath the driving repository (ignored): the runner's bare --preload path
// resolves at the nearest enclosing package.json (treeTestList's pattern).
const FIXTURES_PARENT = path.join(REPO_ROOT, '.kawai-fixture-probes')
const SEED = 0x7e57

let repo: string
let probeOut: string

function git(...args: string[]): string {
  const result = runGit(args, { cwd: repo, timeoutMs: 10_000, env: COMMIT_ENV })
  if (!result.ok) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
  return result.stdout.trim()
}

function copy(from: string, to: string): void {
  fs.mkdirSync(path.dirname(path.join(repo, to)), { recursive: true })
  fs.copyFileSync(from, path.join(repo, to))
}

beforeEach(() => {
  fs.mkdirSync(FIXTURES_PARENT, { recursive: true })
  repo = fs.realpathSync(fs.mkdtempSync(path.join(FIXTURES_PARENT, 'case-profile-')))
  git('init', '-q', '--initial-branch=master')
  for (const tree of ['src/client/__tests__', 'src/shared/__tests__', 'scripts/__tests__']) {
    fs.mkdirSync(path.join(repo, tree), { recursive: true })
  }
  copy(path.join(REPO_ROOT, 'scripts', 'test-preload.ts'), 'scripts/test-preload.ts')
  copy(PROBE, 'src/server/__tests__/caseCount.test.ts')
  copy(HELPER, 'src/server/__tests__/helpers/propertyCases.ts')
  git('add', '.')
  git('commit', '-q', '-m', 'probe')
  // Outside the repository: a probe output inside it would change the tree.
  probeOut = path.join(fs.mkdtempSync(path.join(FIXTURES_PARENT, 'case-profile-out-')), 'seeds.json')
})

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true })
  fs.rmSync(path.dirname(probeOut), { recursive: true, force: true })
  try {
    fs.rmdirSync(FIXTURES_PARENT)
  } catch {
    // a concurrent probe run still holds the parent
  }
})

async function check(env: Record<string, string>, fullProperties: boolean): Promise<{ seeds: number[]; profile: unknown }> {
  const outcome = await runCheck({
    cwd: repo,
    steps: [{ name: 'test', command: [process.execPath, RUNNER, '--skip-real-tmux'] }],
    // No CI or full flag inherited from the driving run.
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', KAWAI_PROBE_OUT: probeOut, ...env },
    fullProperties,
  })
  if (outcome.kind !== 'passed' || !outcome.recorded) throw new Error(`the check did not record a pass: ${JSON.stringify(outcome)}`)
  return {
    seeds: JSON.parse(fs.readFileSync(probeOut, 'utf8')) as number[],
    profile: readRecord(recordsDir(repo), outcome.key)?.caseProfile,
  }
}

const prefix = (count: number) => Array.from({ length: count }, (_, index) => SEED + index)

// @covers: dev-checks › Local runs execute a reduced case profile › Local run
test('default: a declared-300 probe executes the first 75 seeds and the record says reduced', async () => {
  const { seeds, profile } = await check({}, false)
  expect(seeds).toEqual(prefix(75))
  expect(profile).toBe('reduced')
}, 120_000)

// @covers: dev-checks › Local runs execute a reduced case profile › CI run
test('CI=true: the probe executes all 300 seeds and the record says full', async () => {
  const { seeds, profile } = await check({ CI: 'true' }, false)
  expect(seeds).toEqual(prefix(300))
  expect(profile).toBe('full')
}, 120_000)

// @covers: dev-checks › Local runs execute a reduced case profile › Full properties on request
test('--full-properties: the probe executes all 300 seeds and the record says full', async () => {
  const { seeds, profile } = await check({}, true)
  expect(seeds).toEqual(prefix(300))
  expect(profile).toBe('full')
}, 120_000)
