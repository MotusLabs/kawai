// realTmuxRetry.integration.test.ts - Rows RT3 and RU4 of
// check-time-optimization design.md (D2/D3, task 3.6, hazard M1) through the
// production composition: the real `runCheck` pipeline whose test step is
// the real unit-suite runner spawning real `bun test` children, in a
// temporary git repository with one ordinary test and the 7 real-tmux file
// names as fixtures. One real-tmux fixture fails its first run and passes
// its second, keyed by a marker file in the run root (shared by every batch
// of one run, fresh for the next). The repository has no `origin/master`,
// so selection runs every real-tmux file (SE2).
import { afterEach, beforeEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { readRecord, recordsDir } from '../checks/checkRecords'
import { readTestList } from '../checks/testLists'
import { runGit } from '../git/gitCommand'
import { runCheck } from '../../../scripts/lib/checkRun'
import { REAL_TMUX_FILES } from '../../../scripts/planBatches'

const REPO_ROOT = path.resolve(import.meta.dir, '..', '..', '..')
const RUNNER = path.join(REPO_ROOT, 'scripts', 'test-runner.ts')
const COMMIT_ENV = {
  GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.com',
}
// Beneath the driving repository (ignored): the runner's bare --preload path
// resolves at the nearest enclosing package.json (treeTestList's pattern).
const FIXTURES_PARENT = path.join(REPO_ROOT, '.kawai-fixture-probes')
const TMUX_FILES = REAL_TMUX_FILES.map((file) => `src/server/__tests__/${file}`)
const FLAKY = TMUX_FILES[3]!
const PLAIN = 'src/server/__tests__/plain.test.ts'
// No CI and no full-properties flag inherited from the driving run: the
// first check's profile must be `reduced` wherever this test runs.
const LOCAL_ENV = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR }

let repo: string

function git(...args: string[]): string {
  const result = runGit(args, { cwd: repo, timeoutMs: 10_000, env: COMMIT_ENV })
  if (!result.ok) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
  return result.stdout.trim()
}

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true })
  fs.writeFileSync(path.join(repo, file), content)
}

const FLAKY_SOURCE = `import { test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
const marker = path.join(process.env.KAWAI_TEST_RUN_ROOT ?? '/nonexistent', 'flaky-attempted')
test('fails on its first run only', () => {
  if (!fs.existsSync(marker)) {
    fs.writeFileSync(marker, '')
    throw new Error('first attempt fails on purpose')
  }
})
`

beforeEach(() => {
  fs.mkdirSync(FIXTURES_PARENT, { recursive: true })
  repo = fs.realpathSync(fs.mkdtempSync(path.join(FIXTURES_PARENT, 'real-tmux-retry-')))
  git('init', '-q', '--initial-branch=master')
  for (const tree of ['src/client/__tests__', 'src/shared/__tests__', 'scripts/__tests__']) {
    fs.mkdirSync(path.join(repo, tree), { recursive: true })
  }
  write('scripts/test-preload.ts', fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'test-preload.ts'), 'utf8'))
  write(PLAIN, "import { test } from 'bun:test'\ntest('plain', () => {})\n")
  TMUX_FILES.forEach((file, index) => {
    write(file, file === FLAKY ? FLAKY_SOURCE : `import { test } from 'bun:test'\ntest('fixture ${index}', () => {})\n`)
  })
  git('add', '.')
  git('commit', '-q', '-m', 'fixture')
})

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true })
  try {
    fs.rmdirSync(FIXTURES_PARENT)
  } catch {
    // a concurrent probe run still holds the parent
  }
})

const STEPS = [
  { name: 'lint', command: ['true'] },
  { name: 'typecheck', command: ['true'] },
  { name: 'test', command: [process.execPath, RUNNER] },
]

// @covers: dev-checks › A recorded pass names its retries and case profile › Pass after a retry
test('RT3 through the real runner: one real-tmux file fails once, passes alone, and the record names it', async () => {
  const outcome = await runCheck({ cwd: repo, steps: STEPS, env: LOCAL_ENV })
  expect(outcome).toMatchObject({ kind: 'passed', recorded: true })
  const record = readRecord(recordsDir(repo), (outcome as { key: string }).key)
  expect(record?.retries).toEqual([{ file: FLAKY, failures: ['fails on its first run only'] }])
  // The test list holds the rerun's outcome for the retried file, once, and
  // every other real-tmux file ran.
  const entries = record === null ? null : readTestList(recordsDir(repo), record)
  expect(entries?.filter((entry) => entry.file === FLAKY)).toEqual([
    { file: FLAKY, path: '', name: 'fails on its first run only', status: 'passed' },
  ])
  expect([...new Set(entries?.map((entry) => entry.file))].sort()).toEqual([PLAIN, ...TMUX_FILES].sort())
}, 180_000)

test('RU4 through the real runner: --full-properties on a reduced pass runs again and records full', async () => {
  const first = await runCheck({ cwd: repo, steps: STEPS, env: LOCAL_ENV })
  expect(first).toMatchObject({ kind: 'passed', recorded: true })
  const key = (first as { key: string }).key
  expect(readRecord(recordsDir(repo), key)?.caseProfile).toBe('reduced')
  const second = await runCheck({ cwd: repo, steps: STEPS, env: LOCAL_ENV, fullProperties: true })
  expect(second).toMatchObject({ kind: 'passed', recorded: true })
  expect(readRecord(recordsDir(repo), key)?.caseProfile).toBe('full')
  // A third request of either kind now reuses the full pass.
  expect((await runCheck({ cwd: repo, steps: STEPS, env: LOCAL_ENV, fullProperties: true })).kind).toBe('recorded')
}, 240_000)
