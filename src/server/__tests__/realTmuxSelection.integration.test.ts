// realTmuxSelection.integration.test.ts - Rows SE4 and SE5 of
// check-time-optimization design.md (D6, task 2.6) through the production
// composition: the real `runCheck` pipeline whose test step is the real
// unit-suite runner, in a temporary git repository with a local
// `origin/master` ref, one ordinary test, and the 7 real-tmux file names as
// fixtures that each declare their own `@exercises` area. Which files ran is
// read from the record's test list, which the check merges from the runner's
// per-batch JUnit reports; what was skipped and against which merge-base is
// read from the record's selection.
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
const PLAIN = 'src/server/__tests__/plain.test.ts'

let repo: string
let mergeBase: string

function git(...args: string[]): string {
  const result = runGit(args, { cwd: repo, timeoutMs: 10_000, env: COMMIT_ENV })
  if (!result.ok) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
  return result.stdout.trim()
}

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true })
  fs.writeFileSync(path.join(repo, file), content)
}

beforeEach(() => {
  fs.mkdirSync(FIXTURES_PARENT, { recursive: true })
  repo = fs.realpathSync(fs.mkdtempSync(path.join(FIXTURES_PARENT, 'real-tmux-selection-')))
  git('init', '-q', '--initial-branch=master')
  for (const tree of ['src/client/__tests__', 'src/shared/__tests__', 'scripts/__tests__']) {
    fs.mkdirSync(path.join(repo, tree), { recursive: true })
  }
  write('scripts/test-preload.ts', fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'test-preload.ts'), 'utf8'))
  write(PLAIN, "import { test } from 'bun:test'\ntest('plain', () => {})\n")
  TMUX_FILES.forEach((file, index) => {
    write(`src/area${index}/code.ts`, `export const area = ${index}\n`)
    write(file, `// @exercises: src/area${index}/**\nimport { test } from 'bun:test'\ntest('fixture ${index}', () => {})\n`)
  })
  git('add', '.')
  git('commit', '-q', '-m', 'fixture')
  mergeBase = git('rev-parse', 'HEAD')
  git('update-ref', 'refs/remotes/origin/master', mergeBase)
  git('checkout', '-q', '-b', 'feature')
})

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true })
  try {
    fs.rmdirSync(FIXTURES_PARENT)
  } catch {
    // a concurrent probe run still holds the parent
  }
})

async function checkAndRead(): Promise<{ ran: string[]; realTmux: unknown }> {
  const outcome = await runCheck({
    cwd: repo,
    steps: [
      { name: 'lint', command: ['true'] },
      { name: 'typecheck', command: ['true'] },
      { name: 'test', command: [process.execPath, RUNNER] },
    ],
  })
  if (outcome.kind !== 'passed' || !outcome.recorded) throw new Error(`the check did not record a pass: ${JSON.stringify(outcome)}`)
  const record = readRecord(recordsDir(repo), outcome.key)
  const entries = record === null ? null : readTestList(recordsDir(repo), record)
  if (entries === null) throw new Error('the record has no test list')
  return { ran: [...new Set(entries.map((entry) => entry.file))].sort(), realTmux: record?.realTmux }
}

test('SE4 through the real runner: a change in one file\'s declared area runs only that real-tmux file', async () => {
  write('src/area2/code.ts', 'export const area = "changed"\n')
  git('commit', '-qam', 'touch area 2')
  const { ran, realTmux } = await checkAndRead()
  expect(ran).toEqual([PLAIN, TMUX_FILES[2]].sort())
  expect(realTmux).toEqual({ mergeBase, skipped: TMUX_FILES.filter((_, index) => index !== 2) })
}, 120_000)

// @covers: dev-checks › Real-tmux files run only when affected › An unrelated change
test('SE5 through the real runner: a change outside every declared area and trigger skips every real-tmux file', async () => {
  // Uncommitted and untracked both count toward the changed set.
  write('notes/unrelated.md', 'unrelated\n')
  const { ran, realTmux } = await checkAndRead()
  expect(ran).toEqual([PLAIN])
  expect(realTmux).toEqual({ mergeBase, skipped: TMUX_FILES })
}, 120_000)
