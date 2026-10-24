// treeTestList.integration.test.ts - The acceptance path of task 4.3
// (independent-verification): "Citation resolves and ran" and "Cited test
// was skipped" answered against a REAL record that a real `bun run check`
// wrote in a temporary repository — the real runCheck pipeline, a real
// `bun test` step reporting JUnit into the check's report directory, the
// real list-then-record write, and the real tree reader.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readRecord, recordsDir } from '../checks/checkRecords'
import { readTestList } from '../checks/testLists'
import { runGit } from '../git/gitCommand'
import { computeResultFacts, makeCheckGit } from '../verification/resultChecks'
import { readTreeTestList } from '../verification/treeTestList'
import { runCheck } from '../../../scripts/lib/checkRun'

const HOST = { platform: process.platform, arch: process.arch }
const COMMIT_ENV = {
  GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.com',
}

let tempRoot: string
let repo: string

beforeEach(() => {
  tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-tree-list-e2e-')))
  repo = path.join(tempRoot, 'repo')
  fs.mkdirSync(repo)
  const init = runGit(['init', '--initial-branch=master', repo], { timeoutMs: 10_000 })
  if (!init.ok) throw new Error(`git init failed: ${init.stderr}`)
})
afterEach(() => { fs.rmSync(tempRoot, { recursive: true, force: true }) })

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
test('the citations answer from a real record a real bun run check wrote in a temporary repository', async () => {
  commit(
    'tiny.test.ts',
    "import { test, expect } from 'bun:test'\n"
    + "test('adds numbers', () => { expect(1 + 1).toBe(2) })\n"
    + "test.skip('skipped addition', () => { expect(1).toBe(2) })\n"
  )
  // A second file at the same commit whose tests the check's step never
  // ran: its titles exist at the commit but nothing lists them.
  commit(
    'other.test.ts',
    "import { test } from 'bun:test'\ntest('not run by the check', () => {})\n"
  )
  const sha = head()
  // The real pipeline: the test step is exactly what the runner plans —
  // the JUnit pair pointing into the check's report directory, which the
  // pipeline exports as KAWAI_TEST_JUNIT_DIR.
  const outcome = await runCheck({
    cwd: repo,
    steps: [
      { name: 'lint', command: ['true'] },
      { name: 'typecheck', command: ['true'] },
      {
        name: 'test',
        command: ['bash', '-c', 'exec bun test --reporter=junit --reporter-outfile="$KAWAI_TEST_JUNIT_DIR/0-test-0.junit.xml" ./tiny.test.ts'],
      },
    ],
    env: { ...process.env, ...COMMIT_ENV },
  })
  if (outcome.kind !== 'passed') throw new Error(`the check did not pass: ${JSON.stringify(outcome)}`)
  expect(outcome.recorded).toBe(true)

  // The record carries its list, written before it (K1 on the real path):
  // both entries, the skip recorded as skipped.
  const dir = recordsDir(repo)
  const record = readRecord(dir, outcome.key)
  expect(record?.tests).toEqual({ file: `${outcome.key}.tests.json.gz`, count: 2 })
  expect(readTestList(dir, record!)?.map((entry) => [entry.file, entry.name, entry.status])).toEqual([
    ['tiny.test.ts', 'adds numbers', 'passed'],
    ['tiny.test.ts', 'skipped addition', 'skipped'],
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
          cite('tiny.test.ts', 'adds numbers'),
          cite('tiny.test.ts', 'skipped addition'),
          cite('other.test.ts', 'not run by the check'),
        ],
      }],
      testList: (treeId) => readTreeTestList(repo, treeId),
    },
    makeCheckGit()
  )
  expect(facts.recorded.status).toBe('pass')
  expect(facts.coverage).toEqual([['ran-passed', 'not-run', 'not-in-run']])
}, 30_000)
