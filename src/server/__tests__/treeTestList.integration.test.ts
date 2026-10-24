// treeTestList.integration.test.ts - The acceptance path of task 4.3
// (independent-verification): "Citation resolves and ran" and "Cited test
// was skipped" answered against a REAL record that a real `bun run check`
// wrote — the real runCheck pipeline, whose test step is the real unit-suite
// runner planning its own JUnit reports and their planned-report manifest
// into the check's report directory, the real merge, the real list-then-
// record write, and the real tree reader.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { readRecord, recordsDir } from '../checks/checkRecords'
import { readTestList } from '../checks/testLists'
import { runGit } from '../git/gitCommand'
import { computeResultFacts, makeCheckGit } from '../verification/resultChecks'
import { readTreeTestList } from '../verification/treeTestList'
import { runCheck } from '../../../scripts/lib/checkRun'

const REPO_ROOT = path.resolve(import.meta.dir, '..', '..', '..')
const RUNNER = path.join(REPO_ROOT, 'scripts', 'test-runner.ts')
const HOST = { platform: process.platform, arch: process.arch }
const COMMIT_ENV = {
  GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.com',
}

// The fixture repository lives beneath the driving repository (ignored, see
// .gitignore), the runnerRoots publish-probe pattern: the runner's bare
// --preload path resolves at the nearest enclosing package.json, which only
// the driving repository provides, and the copied preload keeps the probe
// self-describing. /tmp cannot host it.
const FIXTURES_PARENT = path.join(REPO_ROOT, '.kawai-fixture-probes')

let repo: string

beforeEach(() => {
  fs.mkdirSync(FIXTURES_PARENT, { recursive: true })
  repo = fs.realpathSync(fs.mkdtempSync(path.join(FIXTURES_PARENT, 'tree-list-check-')))
  const init = runGit(['init', '--initial-branch=master', repo], { timeoutMs: 10_000 })
  if (!init.ok) throw new Error(`git init failed: ${init.stderr}`)
  // Every source tree collectFiles() scans, existing but empty, and the
  // production preload the runner passes to every `bun test` child.
  for (const tree of ['src/server/__tests__', 'src/client/__tests__', 'src/shared/__tests__', 'scripts/__tests__']) {
    fs.mkdirSync(path.join(repo, tree), { recursive: true })
  }
  fs.copyFileSync(path.join(REPO_ROOT, 'scripts', 'test-preload.ts'), path.join(repo, 'scripts', 'test-preload.ts'))
  // The preload is committed: the check's key is the working tree's content
  // (tracked and untracked non-ignored), and an untracked file would make
  // the record's tree differ from the commit's tree the citations resolve.
  const setup = runGit(['add', '--', 'scripts/test-preload.ts'], { cwd: repo, timeoutMs: 10_000 })
  if (!setup.ok) throw new Error(`git add failed: ${setup.stderr}`)
  const commitPreload = runGit(['commit', '-m', 'preload'], {
    cwd: repo, timeoutMs: 10_000, env: COMMIT_ENV,
  })
  if (!commitPreload.ok) throw new Error(`git commit failed: ${commitPreload.stderr}`)
})
afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true })
  try {
    fs.rmdirSync(FIXTURES_PARENT)
  } catch {
    // a concurrent probe run still holds the parent
  }
})

function commit(file: string, content: string): void {
  fs.writeFileSync(path.join(repo, file), content)
  const git = (args: string[]) => runGit(args, { cwd: repo, timeoutMs: 10_000, env: COMMIT_ENV })
  git(['add', '--', file])
  git(['commit', '-m', 'fixture'])
}

function head(): string {
  return runGit(['rev-parse', 'HEAD'], { cwd: repo, timeoutMs: 10_000 }).stdout.trim()
}

const cite = (file: string, title: string) => `\`${file}\` › \`${title}\``

// @covers: task-results › Results carry a coverage map › Citation resolves and ran
// @covers: task-results › Results carry a coverage map › Cited test was skipped
test('the citations answer from a real record a real bun run check wrote through the real runner', async () => {
  commit(
    'src/server/__tests__/tiny.test.ts',
    "import { test, expect } from 'bun:test'\n"
    + "test('adds numbers', () => { expect(1 + 1).toBe(2) })\n"
    + "test.skip('skipped addition', () => { expect(1).toBe(2) })\n"
  )
  // A file at the same commit whose test the check's run never collects
  // (outside every tree the runner scans): its title exists at the commit
  // but nothing lists it — the genuine not-in-run shape.
  commit(
    'unlisted.test.ts',
    "import { test } from 'bun:test'\ntest('exists but is never collected', () => {})\n"
  )
  const sha = head()
  // The real pipeline end to end: the test step is the production runner
  // over the fixture repository's whole suite — it consumes the check's
  // KAWAI_TEST_JUNIT_DIR, plans its batch reports, writes the planned-report
  // manifest, and runs both files under the real per-file machinery.
  const outcome = await runCheck({
    cwd: repo,
    steps: [
      { name: 'lint', command: ['true'] },
      { name: 'typecheck', command: ['true'] },
      { name: 'test', command: [process.execPath, RUNNER, '--skip-real-tmux'] },
    ],
  })
  if (outcome.kind !== 'passed') throw new Error(`the check did not pass: ${JSON.stringify(outcome)}`)
  expect(outcome.recorded).toBe(true)

  // The record carries its list, written before it (K1 on the real path):
  // both entries, the skip recorded as skipped.
  const dir = recordsDir(repo)
  const record = readRecord(dir, outcome.key)
  expect(record?.tests).toEqual({ file: `${outcome.key}.tests.json.gz`, count: 2 })
  expect(readTestList(dir, record!)?.map((entry) => [entry.file, entry.name, entry.status])).toEqual([
    ['src/server/__tests__/tiny.test.ts', 'adds numbers', 'passed'],
    ['src/server/__tests__/tiny.test.ts', 'skipped addition', 'skipped'],
  ])

  // The citations answer from that record through the real reader: the
  // passed test ran, the skipped one reads not run, a test the run never
  // listed reads not in run.
  const facts = await computeResultFacts(
    {
      given: sha, worktree: null, repoRoot: repo, others: [], host: HOST,
      coverage: [{
        clause: 'The clause',
        tests: [
          cite('src/server/__tests__/tiny.test.ts', 'adds numbers'),
          cite('src/server/__tests__/tiny.test.ts', 'skipped addition'),
          cite('unlisted.test.ts', 'exists but is never collected'),
        ],
      }],
      testList: (treeId) => readTreeTestList(repo, treeId),
    },
    makeCheckGit()
  )
  expect(facts.recorded.status).toBe('pass')
  expect(facts.coverage).toEqual([['ran-passed', 'not-run', 'not-in-run']])
}, 60_000)
