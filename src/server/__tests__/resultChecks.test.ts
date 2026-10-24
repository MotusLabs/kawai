// Result check computation (independent-verification task 2.2, design D2)
// over real temporary repositories: one test per spec scenario of "Kawai
// checks a result's commit" and "Kawai checks a result against the base and
// other open branches", plus the runner rules (a call that does not answer
// is unavailable; the budget is bounded) and the read-only invariant: the
// check changes no ref, no index, and no worktree file.
// @covers: specs/task-results "Kawai checks a result's commit"
// @covers: specs/task-results "Kawai checks a result against the base and other open branches"
import { afterEach, beforeEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runGit } from '../git/gitCommand'
import { recordsDir, writeRecord } from '../checks/checkRecords'
import {
  CheckUnavailable, computeResultFacts, makeCheckGit, serializeFacts,
  type OtherTaskHead, type ResultCheckInput,
} from '../verification/resultChecks'
import type { ResultCheckFacts } from '../../shared/teamTasks'

const HOST = { platform: process.platform, arch: process.arch }
const BUN = process.versions.bun

interface Fixture {
  root: string
  git: (args: string[], cwd?: string) => ReturnType<typeof runGit>
  commit: (file: string, content: string, message: string, cwd?: string) => string
  worktree: (dir: string, branch: string) => string
}

let tempRoot: string

beforeEach(() => {
  tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-result-checks-')))
})
afterEach(() => { fs.rmSync(tempRoot, { recursive: true, force: true }) })

function makeRepo(): Fixture {
  const root = path.join(tempRoot, 'repo')
  fs.mkdirSync(root)
  runGit(['init', '--initial-branch=master', root], { timeoutMs: 10_000 })
  const git = (args: string[], cwd = root) => runGit(args, { cwd, timeoutMs: 10_000, env: COMMIT_ENV })
  const commit = (file: string, content: string, message: string, cwd = root) => {
    fs.writeFileSync(path.join(cwd, file), content)
    git(['add', '--', file], cwd)
    git(['commit', '-m', message], cwd)
    return git(['rev-parse', 'HEAD'], cwd).stdout.trim()
  }
  const worktree = (dir: string, branch: string) => {
    git(['worktree', 'add', '-b', branch, dir])
    return dir
  }
  commit('README.md', '# repo\n', 'init')
  return { root, git, commit, worktree }
}

const COMMIT_ENV = {
  GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.com',
}

/** Record one full-check pass for a tree, as scripts/check.ts would. */
function writePass(fixture: Fixture, treeId: string, bun = BUN, at = new Date().toISOString()): void {
  writeRecord(recordsDir(fixture.root), {
    key: Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join(''),
    treeId, bun, platform: process.platform, arch: process.arch, at, worktree: fixture.root, steps: [],
  })
}

const treeOf = (fixture: Fixture, sha: string): string =>
  fixture.git(['rev-parse', `${sha}^{tree}`]).stdout.trim()

async function check(fixture: Fixture, overrides: Partial<ResultCheckInput> = {}): Promise<ResultCheckFacts> {
  const input: ResultCheckInput = {
    given: null, worktree: null, repoRoot: fixture.root, others: [], host: HOST, ...overrides,
  }
  return computeResultFacts(input, makeCheckGit())
}

const baseAt = (fixture: Fixture, sha: string): void => {
  fixture.git(['update-ref', 'refs/remotes/origin/HEAD', sha])
}

test('a clean, checked commit: every fact passes', async () => {
  const repo = makeRepo()
  const sha = repo.commit('.bun-version', `${BUN}\n`, 'pin bun')
  const wt = repo.worktree(path.join(tempRoot, 'wt'), 'feature')
  writePass(repo, treeOf(repo, sha))
  const facts = await check(repo, { given: sha, worktree: wt })
  expect(facts.commit.status).toBe('pass')
  expect(facts.commit.sha).toBe(sha)
  expect(facts.commit.resolvedAtCheckTime).toBe(false)
  expect(facts.head?.relation).toBe('same')
  expect(facts.head?.branch).toBe('feature')
  expect(facts.head?.status).toBe('pass')
  expect(facts.clean?.clean).toBe(true)
  expect(facts.clean?.status).toBe('pass')
  expect(facts.recorded?.status).toBe('pass')
  expect(facts.recorded?.recordBun).toBe(BUN)
  expect(facts.recorded?.commitBun).toBe(BUN)
})

test('unknown commit: the check records not found and checks nothing else', async () => {
  const repo = makeRepo()
  const wt = repo.worktree(path.join(tempRoot, 'wt'), 'feature')
  const facts = await check(repo, { given: 'deadbeef'.repeat(5), worktree: wt })
  expect(facts.commit.status).toBe('fail')
  expect(facts.commit.note).toContain('not found')
  expect(facts.head).toBeNull()
  expect(facts.clean).toBeNull()
  expect(facts.recorded?.status).toBe('unknown')
  expect(facts.base?.status).toBe('unknown')
  expect(facts.branches.status).toBe('unknown')
})

test('HEAD moved past the commit: ahead two on its branch, a warning', async () => {
  const repo = makeRepo()
  const sha = repo.commit('a.txt', 'a\n', 'c1')
  const wt = repo.worktree(path.join(tempRoot, 'wt'), 'feature')
  repo.commit('b.txt', 'b\n', 'c2', wt)
  repo.commit('c.txt', 'c\n', 'c3', wt)
  const facts = await check(repo, { given: sha.slice(0, 7), worktree: wt })
  expect(facts.commit.resolvedAtCheckTime).toBe(true)
  expect(facts.head?.relation).toBe('ahead')
  expect(facts.head?.ahead).toBe(2)
  expect(facts.head?.branch).toBe('feature')
  expect(facts.head?.status).toBe('warn')
})

test('dirty worktree: the modified tracked file and the untracked file are listed', async () => {
  const repo = makeRepo()
  const sha = repo.commit('tracked.txt', 'one\n', 'c1')
  const wt = repo.worktree(path.join(tempRoot, 'wt'), 'feature')
  fs.writeFileSync(path.join(wt, 'tracked.txt'), 'changed\n')
  fs.writeFileSync(path.join(wt, 'stray.txt'), 'new\n')
  const facts = await check(repo, { given: sha, worktree: wt })
  expect(facts.clean?.clean).toBe(false)
  expect([...(facts.clean?.paths ?? [])].sort()).toEqual(['stray.txt', 'tracked.txt'])
  expect(facts.clean?.status).toBe('warn')
})

test('no recorded pass: the check says so, as a warning', async () => {
  const repo = makeRepo()
  const sha = repo.commit('a.txt', 'a\n', 'c1')
  const wt = repo.worktree(path.join(tempRoot, 'wt'), 'feature')
  const facts = await check(repo, { given: sha, worktree: wt })
  expect(facts.recorded?.status).toBe('warn')
  expect(facts.recorded?.note).toContain('no full check passed')
  expect(facts.recorded?.recordBun).toBeNull()
})

test('pass under another Bun version: both versions shown, marked as a warning', async () => {
  const repo = makeRepo()
  const sha = repo.commit('.bun-version', `${BUN}\n`, 'pin bun')
  const wt = repo.worktree(path.join(tempRoot, 'wt'), 'feature')
  writePass(repo, treeOf(repo, sha), '9.9.9-test')
  const facts = await check(repo, { given: sha, worktree: wt })
  expect(facts.recorded?.status).toBe('warn')
  expect(facts.recorded?.recordBun).toBe('9.9.9-test')
  expect(facts.recorded?.commitBun).toBe(BUN)
})

test('result without a commit: recorded as nothing to check', async () => {
  const repo = makeRepo()
  const facts = await check(repo, {})
  expect(facts.commit.status).toBe('unknown')
  expect(facts.commit.note).toContain('no commit to check')
  expect(facts.head).toBeNull()
  expect(facts.recorded?.status).toBe('unknown')
  expect(facts.base?.status).toBe('unknown')
  expect(facts.branches.status).toBe('unknown')
})

test('worktree removed: HEAD and cleanliness unknown with the reason, the commit still checked', async () => {
  const repo = makeRepo()
  const sha = repo.commit('a.txt', 'a\n', 'c1')
  const wt = repo.worktree(path.join(tempRoot, 'wt'), 'feature')
  writePass(repo, treeOf(repo, sha))
  baseAt(repo, sha)
  fs.rmSync(wt, { recursive: true, force: true })
  const facts = await check(repo, { given: sha, worktree: wt })
  expect(facts.head?.status).toBe('unknown')
  expect(facts.head?.note).toBeTruthy()
  expect(facts.clean?.status).toBe('unknown')
  expect(facts.commit.status).toBe('pass')
  expect(facts.recorded?.status).toBe('pass')
  expect(facts.base?.status).toBe('pass')
})

test('clean against the base: the base commit named, the merge clean, three commits behind', async () => {
  const repo = makeRepo()
  const branchPoint = repo.git(['rev-parse', 'HEAD']).stdout.trim()
  const wt = repo.worktree(path.join(tempRoot, 'wt'), 'feature')
  const result = repo.commit('feature.txt', 'f\n', 'feature work', wt)
  repo.commit('m1.txt', '1\n', 'm1')
  repo.commit('m2.txt', '2\n', 'm2')
  const tip = repo.commit('m3.txt', '3\n', 'm3')
  baseAt(repo, tip)
  const facts = await check(repo, { given: result, worktree: wt })
  expect(facts.base?.status).toBe('pass')
  expect(facts.base?.sha).toBe(tip)
  expect(facts.base?.mergeClean).toBe(true)
  expect(facts.base?.behind).toBe(3)
  expect(branchPoint).not.toBe(tip)
})

test('conflict with the base: both conflicting files listed, a failure', async () => {
  const repo = makeRepo()
  const wt = repo.worktree(path.join(tempRoot, 'wt'), 'feature')
  repo.commit('shared1.txt', 'base line\n', 'base one')
  repo.commit('shared2.txt', 'base line\n', 'base two')
  const tip = repo.git(['rev-parse', 'HEAD']).stdout.trim()
  baseAt(repo, tip)
  repo.commit('shared1.txt', 'feature line\n', 'feature one', wt)
  const result = repo.commit('shared2.txt', 'feature line\n', 'feature two', wt)
  const facts = await check(repo, { given: result, worktree: wt })
  expect(facts.base?.status).toBe('fail')
  expect(facts.base?.mergeClean).toBe(false)
  expect([...(facts.base?.conflicts ?? [])].sort()).toEqual(['shared1.txt', 'shared2.txt'])
})

test('conflict with another open task branch: the task, its head, and the files', async () => {
  const repo = makeRepo()
  const wt = repo.worktree(path.join(tempRoot, 'wt'), 'feature')
  repo.commit('shared.txt', 'base line\n', 'base')
  const tip = repo.git(['rev-parse', 'HEAD']).stdout.trim()
  baseAt(repo, tip)
  const result = repo.commit('shared.txt', 'feature line\n', 'feature', wt)
  const otherWt = repo.worktree(path.join(tempRoot, 'other'), 'other-task')
  repo.commit('shared.txt', 'other line\n', 'other', otherWt)
  const otherHead = repo.git(['rev-parse', 'HEAD'], otherWt).stdout.trim()
  const others: OtherTaskHead[] = [{ taskId: 'task-other', worktree: otherWt }]
  const facts = await check(repo, { given: result, worktree: wt, others })
  expect(facts.branches.status).toBe('fail')
  expect(facts.branches.compared).toHaveLength(1)
  const entry = facts.branches.compared[0]
  expect(entry?.taskId).toBe('task-other')
  expect(entry?.head).toBe(otherHead)
  expect(entry?.conflicts).toEqual(['shared.txt'])
  expect(entry?.status).toBe('fail')
})

test('shared files without a conflict: overlap named, not a conflict', async () => {
  const repo = makeRepo()
  // Both branches grow from the base commit, so their shared-file edits can
  // merge cleanly; the base ref points at the same commit (the result lacks
  // no base commits, which keeps the base fact a pass).
  repo.commit('shared.txt', 'l1\nl2\nl3\n', 'base')
  const base = repo.git(['rev-parse', 'HEAD']).stdout.trim()
  baseAt(repo, base)
  const wt = repo.worktree(path.join(tempRoot, 'wt'), 'feature')
  const result = repo.commit('shared.txt', 'l1 feature\nl2\nl3\n', 'feature', wt)
  const otherWt = repo.worktree(path.join(tempRoot, 'other'), 'other-task')
  repo.commit('shared.txt', 'l1\nl2\nl3 other\n', 'other', otherWt)
  const facts = await check(repo, {
    given: result, worktree: wt, others: [{ taskId: 'task-other', worktree: otherWt }],
  })
  expect(facts.branches.status).toBe('warn')
  const entry = facts.branches.compared[0]
  expect(entry?.conflicts).toEqual([])
  expect(entry?.overlap).toEqual(['shared.txt'])
  expect(entry?.status).toBe('warn')
  expect(facts.base?.status).toBe('pass')
})

test('landed or contained heads: a head the base contains is not compared', async () => {
  const repo = makeRepo()
  const wt = repo.worktree(path.join(tempRoot, 'wt'), 'feature')
  const contained = repo.commit('landed.txt', 'l\n', 'landed')
  const tip = repo.commit('after.txt', 'a\n', 'after')
  baseAt(repo, tip)
  const result = repo.commit('feature.txt', 'f\n', 'feature', wt)
  const otherWt = repo.worktree(path.join(tempRoot, 'other'), 'other-task')
  repo.git(['reset', '--hard', contained], otherWt)
  const facts = await check(repo, {
    given: result, worktree: wt, others: [{ taskId: 'task-landed', worktree: otherWt }],
  })
  expect(facts.branches.compared).toEqual([])
  expect(facts.branches.comparedCount).toBe(0)
  expect(facts.branches.skipped).toBe(0)
})

test('more open branches than the cap: thirty newest compared, five counted', async () => {
  const repo = makeRepo()
  const wt = repo.worktree(path.join(tempRoot, 'wt'), 'feature')
  repo.commit('base.txt', 'base\n', 'base')
  baseAt(repo, repo.git(['rev-parse', 'HEAD']).stdout.trim())
  const result = repo.commit('feature.txt', 'f\n', 'feature', wt)
  const others: OtherTaskHead[] = []
  for (let i = 0; i < 35; i++) {
    const otherWt = repo.worktree(path.join(tempRoot, `other-${i}`), `other-${i}`)
    repo.commit(`o${i}.txt`, `${i}\n`, `other ${i}`, otherWt)
    others.push({ taskId: `task-${String(i).padStart(2, '0')}`, worktree: otherWt })
  }
  const facts = await check(repo, { given: result, worktree: wt, others })
  expect(facts.branches.comparedCount).toBe(30)
  expect(facts.branches.skipped).toBe(5)
  expect(facts.branches.compared[0]?.taskId).toBe('task-00')
  expect(facts.branches.compared[29]?.taskId).toBe('task-29')
})

test('a call that does not answer makes the whole check unavailable', async () => {
  const repo = makeRepo()
  const sha = repo.commit('a.txt', 'a\n', 'c1')
  const git = makeCheckGit(10_000, async () => ({ ok: false, exitCode: null, stdout: '', stderr: '' }))
  let failure: unknown = null
  try {
    await computeResultFacts({ given: sha, worktree: null, repoRoot: repo.root, others: [], host: HOST }, git)
  } catch (error) {
    failure = error
  }
  expect(failure).toBeInstanceOf(CheckUnavailable)
})

test('an exhausted budget refuses the first call', async () => {
  const git = makeCheckGit(0)
  let failure: unknown = null
  try {
    await git(['rev-parse', 'HEAD'])
  } catch (error) {
    failure = error
  }
  expect(failure).toBeInstanceOf(CheckUnavailable)
})

test('a check writes nothing: refs, index, and worktree files are unchanged', async () => {
  const repo = makeRepo()
  const sha = repo.commit('a.txt', 'a\n', 'c1')
  const wt = repo.worktree(path.join(tempRoot, 'wt'), 'feature')
  const otherWt = repo.worktree(path.join(tempRoot, 'other'), 'other-task')
  baseAt(repo, sha)
  const refsBefore = repo.git(['for-each-ref', '--format=%(refname) %(objectname)']).stdout
  const objectsBefore = repo.git(['rev-list', '--objects', '--all']).stdout.split('\n').length
  await check(repo, {
    given: sha, worktree: wt,
    others: [{ taskId: 'task-other', worktree: otherWt }],
  })
  expect(repo.git(['for-each-ref', '--format=%(refname) %(objectname)']).stdout).toBe(refsBefore)
  expect(repo.git(['rev-list', '--objects', '--all']).stdout.split('\n').length).toBe(objectsBefore)
  expect(repo.git(['--no-optional-locks', 'status', '--porcelain'], wt).stdout).toBe('')
})

test('oversized facts clamp under 64 KB with their counts preserved', () => {
  const fat = (n: number): string[] => Array.from({ length: n }, (_, i) => `very-long-path-${i}-${'x'.repeat(200)}`)
  const facts: ResultCheckFacts = {
    version: 1,
    commit: { given: 'abc', sha: 'a'.repeat(40), resolvedAtCheckTime: false, status: 'pass', note: null },
    head: null,
    clean: { clean: false, paths: fat(20), more: 0, status: 'warn', note: null },
    recorded: { status: 'pass', recordBun: BUN, recordAt: 'now', commitBun: BUN, note: null },
    base: { ref: 'refs/remotes/origin/HEAD', sha: 'b'.repeat(40), behind: 1, mergeClean: false, conflicts: fat(20), moreConflicts: 0, status: 'fail', note: null },
    branches: {
      compared: Array.from({ length: 30 }, (_, i) => ({
        taskId: `task-${i}`, head: `${i}`.padStart(40, '0'),
        conflicts: fat(20), moreConflicts: 0, overlap: fat(20), moreOverlap: 0, status: 'fail' as const,
      })),
      comparedCount: 30, skipped: 0, status: 'fail',
    },
  }
  expect(Buffer.byteLength(JSON.stringify(facts))).toBeGreaterThan(64 * 1024)
  const stored = serializeFacts(facts)
  expect(Buffer.byteLength(stored)).toBeLessThanOrEqual(64 * 1024)
  const parsed = JSON.parse(stored) as ResultCheckFacts
  expect(parsed.version).toBe(1)
  expect(parsed.commit.sha).toBe(facts.commit.sha)
  expect(parsed.base.conflicts.length).toBeGreaterThan(0)
  expect(parsed.base.moreConflicts).toBeGreaterThan(0)
})
