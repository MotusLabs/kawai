// treeTestList.test.ts - The citation check's real test-list reader
// (independent-verification D7, task 4.3): unit tests over real records and
// lists written into a temporary repository's records directory, plus the
// D5 pin through the real resolver — a clause never mixes ran-passed with
// run-unknown, so a future partial list fails here.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runGit } from '../git/gitCommand'
import { recordsDir, writeRecord, type CheckRecord } from '../checks/checkRecords'
import { testListName, writeTestList, type TestListEntry } from '../checks/testLists'
import { computeResultFacts, makeCheckGit } from '../verification/resultChecks'
import { readTreeTestList } from '../verification/treeTestList'

const HOST = { platform: process.platform, arch: process.arch }
const TREE = 'a'.repeat(40)
const OTHER_TREE = 'b'.repeat(40)

let tempRoot: string
let repo: string
let dir: string

beforeEach(() => {
  tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-tree-test-list-')))
  repo = path.join(tempRoot, 'repo')
  fs.mkdirSync(repo)
  const init = runGit(['init', '--initial-branch=master', repo], { timeoutMs: 10_000 })
  if (!init.ok) throw new Error(`git init failed: ${init.stderr}`)
  dir = recordsDir(repo)
})
afterEach(() => { fs.rmSync(tempRoot, { recursive: true, force: true }) })

const hexKey = (n: number) => n.toString(16).padStart(64, '0')

function recordFor(key: string, treeId: string, ageMs: number, entryCount: number): CheckRecord {
  return {
    key,
    treeId,
    bun: '1.4.3',
    platform: 'linux',
    arch: 'x64',
    at: new Date(Date.now() - ageMs).toISOString(),
    worktree: '/somewhere/impl-feature',
    steps: [{ name: 'test', ms: 1000 }],
    tests: { file: testListName(key), count: entryCount },
  }
}

function seed(
  key: string,
  treeId: string,
  ageMs: number,
  entries: TestListEntry[],
  options: { dropList?: boolean; wrongCount?: boolean } = {}
): void {
  writeTestList(dir, key, entries)
  if (options.dropList) fs.unlinkSync(path.join(dir, testListName(key)))
  const count = options.wrongCount ? entries.length + 1 : entries.length
  writeRecord(dir, recordFor(key, treeId, ageMs, count))
}

const entry = (file: string, name: string, status: TestListEntry['status'] = 'passed'): TestListEntry => ({
  file, path: `src/__tests__/${file}`, name, status,
})

describe('readTreeTestList', () => {
  test('the newest usable record answers: its entries, not an older record\'s', () => {
    seed(hexKey(1), TREE, 5_000, [entry('old.test.ts', 'old title')])
    seed(hexKey(2), TREE, 1_000, [entry('new.test.ts', 'new title')])
    const lookup = readTreeTestList(repo, TREE)
    expect(lookup).not.toBeNull()
    expect(lookup!('new.test.ts', 'new title')).toBe('passed')
    expect(lookup!('old.test.ts', 'old title')).toBe('absent')
  })

  test('a newest record whose list file is missing falls through to the older record', () => {
    seed(hexKey(1), TREE, 5_000, [entry('old.test.ts', 'old title')])
    seed(hexKey(2), TREE, 1_000, [entry('new.test.ts', 'new title')], { dropList: true })
    const lookup = readTreeTestList(repo, TREE)
    expect(lookup).not.toBeNull()
    expect(lookup!('old.test.ts', 'old title')).toBe('passed')
  })

  test('a list whose count disagrees with its pointer is not usable, and the older record answers', () => {
    seed(hexKey(1), TREE, 5_000, [entry('old.test.ts', 'old title')])
    seed(hexKey(2), TREE, 1_000, [entry('new.test.ts', 'new title')], { wrongCount: true })
    const lookup = readTreeTestList(repo, TREE)
    expect(lookup).not.toBeNull()
    expect(lookup!('old.test.ts', 'old title')).toBe('passed')
  })

  test('skipped and todo both answer skipped, an unknown test answers absent', () => {
    seed(hexKey(1), TREE, 1_000, [
      entry('mix.test.ts', 'passes'),
      entry('mix.test.ts', 'is skipped', 'skipped'),
      entry('mix.test.ts', 'is todo', 'todo'),
    ])
    const lookup = readTreeTestList(repo, TREE)
    expect(lookup!('mix.test.ts', 'passes')).toBe('passed')
    expect(lookup!('mix.test.ts', 'is skipped')).toBe('skipped')
    expect(lookup!('mix.test.ts', 'is todo')).toBe('skipped')
    expect(lookup!('mix.test.ts', 'never written')).toBe('absent')
  })

  test('no record of the tree, a foreign tree, or a non-tree id reads as no list', () => {
    seed(hexKey(1), TREE, 1_000, [entry('old.test.ts', 'old title')])
    expect(readTreeTestList(repo, OTHER_TREE)).toBeNull()
    expect(readTreeTestList(repo, 'not-a-tree')).toBeNull()
  })

  test('a missing records directory reads as no list, never a throw', () => {
    const empty = path.join(tempRoot, 'empty-repo')
    fs.mkdirSync(empty)
    const init = runGit(['init', '--initial-branch=master', empty], { timeoutMs: 10_000 })
    if (!init.ok) throw new Error(`git init failed: ${init.stderr}`)
    expect(readTreeTestList(empty, TREE)).toBeNull()
  })
})

// The D5 pin (C1 advisor follow-up 3), through the real resolver and the
// real reader: one usable list answers a clause uniformly — a found
// citation reads ran-passed, not-run, or not-in-run, never run-unknown —
// and only a tree with no usable list reads run-unknown, whole clauses of
// it. A future partial list fails one of these two.
describe('a clause never mixes ran-passed with run-unknown (D5)', () => {
  const cite = (file: string, title: string) => `\`${file}\` › \`${title}\``
  const mapWith = (...tests: string[]) => [{ clause: 'The clause', tests }]

  async function check(given: string, coverage: ReturnType<typeof mapWith>) {
    return computeResultFacts(
      {
        given, worktree: null, repoRoot: repo, others: [], host: HOST, coverage,
        testList: (treeId) => readTreeTestList(repo, treeId),
      },
      makeCheckGit()
    )
  }

  function commitFixture(): { sha: string; tree: string } {
    // The file at the commit must carry the cited titles: the resolver
    // matches them in the file before the list answers for the run.
    fs.writeFileSync(
      path.join(repo, 'mix.test.ts'),
      "test('passes', () => {})\ntest.skip('is skipped', () => {})\ntest('in file only', () => {})\n"
    )
    const git = (args: string[]) => runGit(args, {
      cwd: repo, timeoutMs: 10_000,
      env: { GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.com' },
    })
    git(['add', 'mix.test.ts'])
    git(['commit', '-m', 'fixture'])
    const sha = git(['rev-parse', 'HEAD']).stdout.trim()
    return { sha, tree: git(['rev-parse', `${sha}^{tree}`]).stdout.trim() }
  }

  test('a usable list answers every found citation from the run, never run-unknown', async () => {
    const { sha, tree } = commitFixture()
    seed(hexKey(1), tree, 1_000, [
      entry('mix.test.ts', 'passes'),
      entry('mix.test.ts', 'is skipped', 'skipped'),
    ])
    const facts = await check(sha, mapWith(
      cite('mix.test.ts', 'passes'),
      cite('mix.test.ts', 'is skipped'),
      cite('mix.test.ts', 'in file only')
    ))
    expect(facts.coverage).toEqual([['ran-passed', 'not-run', 'not-in-run']])
    for (const outcome of facts.coverage!.flat()) {
      expect(outcome).not.toBe('run-unknown')
    }
  })

  test('without a usable list the found citations read run-unknown, uniformly', async () => {
    const { sha, tree } = commitFixture()
    seed(hexKey(1), tree, 1_000, [entry('mix.test.ts', 'passes')], { dropList: true })
    const facts = await check(sha, mapWith(cite('mix.test.ts', 'passes'), cite('mix.test.ts', 'in file only')))
    expect(facts.coverage).toEqual([['run-unknown', 'run-unknown']])
  })
})
