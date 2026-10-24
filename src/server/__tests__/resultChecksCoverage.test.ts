// Coverage citation resolution (independent-verification task 3.1, design
// D5): the check reads each cited file at the result's commit, matches the
// literal title, and classifies the run from the recorded pass's test list
// — one outcome per citation, positionally joined to the stored map. One
// test per spec scenario of "Results carry a coverage map" that the check
// answers, plus the storage rule: oversized facts drop the outcomes whole,
// never truncated.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runGit } from '../git/gitCommand'
import {
  computeResultFacts, makeCheckGit, serializeFacts,
  type ResultCheckInput,
} from '../verification/resultChecks'
import { clauseStatus, type CitationOutcome } from '../../shared/coverageMaps'
import type { ResultCheckFacts } from '../../shared/teamTasks'

const HOST = { platform: process.platform, arch: process.arch }

interface Fixture {
  root: string
  git: (args: string[], cwd?: string) => ReturnType<typeof runGit>
  commit: (file: string, content: string, message: string, cwd?: string) => string
}

let tempRoot: string

beforeEach(() => {
  tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-coverage-checks-')))
})
afterEach(() => { fs.rmSync(tempRoot, { recursive: true, force: true }) })

function makeRepo(): Fixture {
  const root = path.join(tempRoot, 'repo')
  fs.mkdirSync(root)
  runGit(['init', '--initial-branch=master', root], { timeoutMs: 10_000 })
  const git = (args: string[], cwd = root) => runGit(args, { cwd, timeoutMs: 10_000, env: COMMIT_ENV })
  const commit = (file: string, content: string, message: string, cwd = root) => {
    fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true })
    fs.writeFileSync(path.join(cwd, file), content)
    git(['add', '--', file], cwd)
    git(['commit', '-m', message], cwd)
    return git(['rev-parse', 'HEAD'], cwd).stdout.trim()
  }
  commit('README.md', '# repo\n', 'init')
  return { root, git, commit }
}

const COMMIT_ENV = {
  GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.com',
}

const cite = (file: string, title: string) => `\`${file}\` › \`${title}\``

async function check(fixture: Fixture, overrides: Partial<ResultCheckInput>): Promise<ResultCheckFacts> {
  const input: ResultCheckInput = {
    given: null, worktree: null, repoRoot: fixture.root, others: [], host: HOST, ...overrides,
  }
  return computeResultFacts(input, makeCheckGit())
}

/** The map the check is given, its clause's citations, and the outcomes the facts carry. */
const mapWith = (...tests: string[]) => [{ clause: 'The clause', tests }]

// @covers: task-results › Results carry a coverage map › Citation resolves and ran
test('citation resolves and ran: the file and title exist at the commit and the test list says passed', async () => {
  const repo = makeRepo()
  const sha = repo.commit('src/export.test.ts', "test('downloads a csv', () => {})\n", 'tests')
  const facts = await check(repo, {
    given: sha, coverage: mapWith(cite('src/export.test.ts', 'downloads a csv')),
    testList: () => 'passed',
  })
  expect(facts.coverage).toEqual([['ran-passed']])
  // The clause the reader derives: covered by a test that ran and passed.
  expect(clauseStatus(1, facts.coverage![0]!, facts.commit.sha !== null)).toBe('covered')
})

// @covers: task-results › Results carry a coverage map › Cited test does not exist
test('cited test does not exist: the title no test in the file carries reads not found, the clause not covered', async () => {
  const repo = makeRepo()
  const sha = repo.commit('src/export.test.ts', "test('downloads a csv', () => {})\n", 'tests')
  const facts = await check(repo, {
    given: sha, coverage: mapWith(cite('src/export.test.ts', 'uploads a csv'), cite('src/missing.test.ts', 'any')),
    testList: () => 'passed',
  })
  expect(facts.coverage).toEqual([['not-found', 'not-found']])
  expect(clauseStatus(2, facts.coverage![0]!, true)).toBe('not-covered')
})

// @covers: task-results › Results carry a coverage map › Cited test was skipped
test('cited test was skipped: the test list says skipped, the citation reads not run', async () => {
  const repo = makeRepo()
  const sha = repo.commit('src/export.test.ts', "test.skip('downloads a csv', () => {})\n", 'tests')
  const facts = await check(repo, {
    given: sha, coverage: mapWith(cite('src/export.test.ts', 'downloads a csv')),
    testList: () => 'skipped',
  })
  expect(facts.coverage).toEqual([['not-run']])
  expect(clauseStatus(1, facts.coverage![0]!, true)).toBe('not-covered')
})

// @covers: task-results › Results carry a coverage map › Partly covered clause
test('partly covered clause: the first citation ran and passed, the second does not exist at the commit', async () => {
  const repo = makeRepo()
  const sha = repo.commit('src/export.test.ts', "test('downloads a csv', () => {})\n", 'tests')
  const facts = await check(repo, {
    given: sha, coverage: mapWith(cite('src/export.test.ts', 'downloads a csv'), cite('src/gone.test.ts', 'deleted')),
    testList: (file, title) => file === 'src/export.test.ts' && title === 'downloads a csv' ? 'passed' : 'absent',
  })
  expect(facts.coverage).toEqual([['ran-passed', 'not-found']])
  expect(clauseStatus(2, facts.coverage![0]!, true)).toBe('partly-covered')
})

// @covers: task-results › Results carry a coverage map › Record without a test list
test('record without a test list: a found citation reads run-unknown, the clause covered with its run unknown', async () => {
  const repo = makeRepo()
  const sha = repo.commit('src/export.test.ts', "test('downloads a csv', () => {})\n", 'tests')
  const facts = await check(repo, { given: sha, coverage: mapWith(cite('src/export.test.ts', 'downloads a csv')) })
  expect(facts.coverage).toEqual([['run-unknown']])
  expect(clauseStatus(1, facts.coverage![0]!, true)).toBe('covered-run-unknown')
})

// @covers: task-results › Results carry a coverage map › Declared uncovered
test('declared uncovered: the clause cites nothing and reads uncovered by the submitter\'s own statement', async () => {
  const repo = makeRepo()
  const sha = repo.commit('src/export.test.ts', "test('downloads a csv', () => {})\n", 'tests')
  const facts = await check(repo, { given: sha, coverage: mapWith() })
  expect(facts.coverage).toEqual([[]])
  expect(clauseStatus(0, facts.coverage![0]!, true)).toBe('declared-uncovered')
})

// @covers: task-results › Results carry a coverage map › Citations without a commit
test('citations without a commit: every cited test reads unresolved, the clause unresolved', async () => {
  const repo = makeRepo()
  repo.commit('src/export.test.ts', "test('downloads a csv', () => {})\n", 'tests')
  const map = mapWith(cite('src/export.test.ts', 'downloads a csv'))
  // A diff-only result has no commit to resolve at.
  const facts = await check(repo, { given: null, coverage: map, testList: () => 'passed' })
  expect(facts.coverage).toEqual([['unresolved']])
  expect(clauseStatus(1, facts.coverage![0]!, false)).toBe('unresolved')
  // So does a commit that does not resolve.
  const missing = await check(repo, { given: 'deadbeef'.repeat(5), coverage: map, testList: () => 'passed' })
  expect(missing.coverage).toEqual([['unresolved']])
})

test('resolution reads the commit, not the worktree: an uncommitted test file is not found', async () => {
  const repo = makeRepo()
  const sha = repo.commit('src/kept.test.ts', "test('kept', () => {})\n", 'kept')
  // Only in the working tree: the commit's tree does not hold it.
  fs.writeFileSync(path.join(repo.root, 'src/uncommitted.test.ts'), "test('uncommitted', () => {})\n")
  const facts = await check(repo, {
    given: sha,
    coverage: mapWith(cite('src/kept.test.ts', 'kept'), cite('src/uncommitted.test.ts', 'uncommitted')),
    testList: () => 'passed',
  })
  expect(facts.coverage).toEqual([['ran-passed', 'not-found']])
})

test('each distinct path is read once and the outcomes join positionally across clauses', async () => {
  const repo = makeRepo()
  const sha = repo.commit('src/a.test.ts', "test('one', () => {})\ntest('two', () => {})\n", 'tests')
  const coverage = [
    { clause: 'First', tests: [cite('src/a.test.ts', 'one')] },
    { clause: 'Second', tests: [cite('src/a.test.ts', 'two'), cite('src/a.test.ts', 'one')] },
    { clause: 'Third', tests: [] },
  ]
  const facts = await check(repo, { given: sha, coverage, testList: (file, title) => title === 'one' ? 'passed' : 'absent' })
  expect(facts.coverage).toEqual([
    ['ran-passed'],
    ['not-in-run', 'ran-passed'],
    [],
  ])
})

test('oversized facts keep or drop the coverage outcomes whole, never truncated positionally', () => {
  const fat = (n: number): string[] => Array.from({ length: n }, (_, i) => `very-long-path-${i}-${'x'.repeat(200)}`)
  const base = (): ResultCheckFacts => ({
    version: 1,
    commit: { given: 'abc', sha: 'a'.repeat(40), resolvedAtCheckTime: false, status: 'pass', note: null },
    head: null,
    clean: { clean: false, paths: fat(20), more: 0, status: 'warn', note: null },
    recorded: { status: 'pass', recordBun: '1.4.3', recordAt: 'now', commitBun: '1.4.3', note: null },
    base: { ref: 'refs/remotes/origin/HEAD', sha: 'b'.repeat(40), behind: 1, mergeClean: false, conflicts: fat(20), moreConflicts: 0, status: 'fail', note: null },
    branches: {
      compared: Array.from({ length: 30 }, (_, i) => ({
        taskId: `task-${i}`, head: `${i}`.padStart(40, '0'),
        conflicts: fat(20), moreConflicts: 0, overlap: fat(20), moreOverlap: 0, status: 'fail' as const,
      })),
      comparedCount: 30, skipped: 0, status: 'fail',
    },
  })
  const coverage: CitationOutcome[][] = [['ran-passed', 'not-found'], ['run-unknown']]
  // When shrinking the lists makes room, the outcomes ride along whole.
  const fitting = { ...base(), coverage }
  expect(Buffer.byteLength(JSON.stringify(fitting))).toBeGreaterThan(64 * 1024)
  const kept = JSON.parse(serializeFacts(fitting)) as ResultCheckFacts
  expect(kept.coverage).toEqual(coverage)
  // When they cannot fit — here a pathological commit text crowds the cap —
  // they go whole: absent, never a cut array that would misjoin the map.
  // Coverage is bounded (D5's limits) at ≈28 KB, so crowding needs a given
  // string near the cap too.
  const crowded = {
    ...base(),
    commit: { ...base().commit, given: 'g'.repeat(40 * 1024) },
    coverage: Array.from({ length: 200 }, () => Array.from({ length: 10 }, () => 'ran-passed' as const)),
  }
  const stored = serializeFacts(crowded)
  expect(Buffer.byteLength(stored)).toBeLessThanOrEqual(64 * 1024)
  const parsed = JSON.parse(stored) as ResultCheckFacts
  expect(parsed.coverage).toBeUndefined()
  expect(stored).not.toContain('ran-passed')
  expect(parsed.commit.given).toBe(crowded.commit.given)
})


