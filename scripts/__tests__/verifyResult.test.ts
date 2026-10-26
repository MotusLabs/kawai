// verifyResult.test.ts - The local check script (independent-verification,
// requirement "A local script reports a result's checks"): the exit matrix,
// the flag grammar, the worktree-head source, the printed lines, and the
// three spec scenarios against a real repository through the real script —
// the same computeResultFacts Kawai's service runs, so the answers agree by
// wiring, not by a second implementation.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cleanGitEnv, runGit } from '../../src/server/git/gitCommand'
import { recordsDir, writeRecord } from '../../src/server/checks/checkRecords'
import { testListName, writeTestList } from '../../src/server/checks/testLists'
import {
  computeResultFacts,
  makeCheckGit,
} from '../../src/server/verification/resultChecks'
import { readTreeTestList } from '../../src/server/verification/treeTestList'
import { validateCoverageMap } from '../../src/shared/coverageMaps'
import type { ResultCheckFacts } from '../../src/shared/teamTasks'
import {
  exitCodeFor,
  factLines,
  parseScriptArgs,
  parseWorktreeHeads,
  resolveTarget,
  usageText,
} from '../verify-result'

const REPO_ROOT = path.resolve(import.meta.dir, '..', '..')
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'verify-result.ts')
const HOST = { platform: process.platform, arch: process.arch }
const COMMIT_ENV = {
  GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.com',
}

const cite = (file: string, title: string) => `\`${file}\` › \`${title}\``

// --- the exit matrix (the requirement's "exits non-zero when a check fails") ---

function greenFacts(overrides: Partial<ResultCheckFacts> = {}): ResultCheckFacts {
  return {
    version: 1,
    commit: { given: 'HEAD', sha: 'a'.repeat(40), resolvedAtCheckTime: false, status: 'pass', note: null },
    head: { sha: 'a'.repeat(40), branch: 'feat', relation: 'same', ahead: 0, behind: 0, status: 'pass', note: null },
    clean: { clean: true, paths: [], more: 0, status: 'pass', note: null },
    recorded: {
      status: 'pass', recordBun: '1.4.3', recordAt: new Date().toISOString(), commitBun: null, note: null,
    },
    base: {
      ref: 'refs/remotes/origin/HEAD', sha: 'b'.repeat(40), behind: 0, mergeClean: true,
      conflicts: [], moreConflicts: 0, status: 'pass', note: null,
    },
    branches: { compared: [], comparedCount: 0, skipped: 0, status: 'pass' },
    ...overrides,
  }
}

describe('the exit matrix: 0 only when every present fact passes and every citation ran', () => {
  test('all green, no coverage, exits 0', () => {
    expect(exitCodeFor(greenFacts())).toBe(0)
  })

  test('any fact that is not pass keeps the script at 1 — warn and unknown included', () => {
    expect(exitCodeFor(greenFacts({ commit: { given: 'x', sha: null, resolvedAtCheckTime: false, status: 'fail', note: 'commit not found' } }))).toBe(1)
    expect(exitCodeFor(greenFacts({ recorded: { status: 'unknown', recordBun: null, recordAt: null, commitBun: null, note: 'none' } }))).toBe(1)
    expect(exitCodeFor(greenFacts({
      base: {
        ref: 'r', sha: null, behind: null, mergeClean: null, conflicts: [], moreConflicts: 0,
        status: 'warn', note: 'unreadable',
      },
    }))).toBe(1)
    expect(exitCodeFor(greenFacts({ branches: { compared: [], comparedCount: 0, skipped: 0, status: 'fail' } }))).toBe(1)
  })

  test('a compared head that is warn or fail counts even when the branches summary lags', () => {
    const entry = (status: 'pass' | 'warn' | 'fail'): ResultCheckFacts['branches']['compared'][number] => ({
      taskId: 'other', head: 'c'.repeat(40), conflicts: [], moreConflicts: 0,
      overlap: [], moreOverlap: 0, status,
    })
    expect(exitCodeFor(greenFacts({
      branches: { compared: [entry('warn')], comparedCount: 1, skipped: 0, status: 'pass' },
    }))).toBe(1)
    expect(exitCodeFor(greenFacts({
      branches: { compared: [entry('fail')], comparedCount: 1, skipped: 0, status: 'pass' },
    }))).toBe(1)
  })

  test('absent facts (no worktree given) never block green', () => {
    const facts = greenFacts()
    facts.head = null
    facts.clean = null
    expect(exitCodeFor(facts)).toBe(0)
  })

  test('coverage: ran-passed and declared-uncovered are green; run-unknown is not', () => {
    const withCoverage = (outcomes: NonNullable<ResultCheckFacts['coverage']>): ResultCheckFacts => {
      const facts = greenFacts()
      facts.coverage = outcomes
      return facts
    }
    expect(exitCodeFor(withCoverage([['ran-passed', 'ran-passed']]))).toBe(0)
    // A clause citing no tests is declared uncovered: it passes vacuously.
    expect(exitCodeFor(withCoverage([[]]))).toBe(0)
    expect(exitCodeFor(withCoverage([['ran-passed', 'not-run']]))).toBe(1)
    expect(exitCodeFor(withCoverage([['run-unknown']]))).toBe(1)
    expect(exitCodeFor(withCoverage([['unresolved']]))).toBe(1)
    expect(exitCodeFor(withCoverage([['ran-passed'], ['not-found']]))).toBe(1)
  })
})

// --- flag grammar, worktree heads, printed lines ---

describe('parseScriptArgs', () => {
  test('defaults and the full set', () => {
    expect(parseScriptArgs([])).toEqual({ worktree: null, commit: null, coveragePath: null, json: false })
    expect(parseScriptArgs(['--worktree', '/w', '--commit', 'HEAD~1', '--coverage', '/m.json', '--json'])).toEqual({
      worktree: '/w', commit: 'HEAD~1', coveragePath: '/m.json', json: true,
    })
  })

  test('unknown flags and missing values are usage errors', () => {
    expect(() => parseScriptArgs(['--wat'])).toThrow(/unknown flag/)
    expect(() => parseScriptArgs(['--worktree'])).toThrow(/needs a value/)
    expect(() => parseScriptArgs(['--commit', '--json'])).toThrow(/needs a value/)
  })
})

describe('parseWorktreeHeads', () => {
  test('every listed worktree but the chosen one, named by basename', () => {
    const porcelain = [
      'worktree /repos/main',
      'HEAD ' + 'a'.repeat(40),
      '',
      'worktree /repos/impl-one',
      'HEAD ' + 'b'.repeat(40),
      '',
      'worktree /repos/impl-two',
      'HEAD ' + 'c'.repeat(40),
      '',
    ].join('\n')
    expect(parseWorktreeHeads(porcelain, '/repos/main')).toEqual([
      { taskId: 'impl-one', worktree: '/repos/impl-one' },
      { taskId: 'impl-two', worktree: '/repos/impl-two' },
    ])
    // The chosen worktree may be any of the listed ones.
    expect(parseWorktreeHeads(porcelain, '/repos/impl-one')).toEqual([
      { taskId: 'main', worktree: '/repos/main' },
      { taskId: 'impl-two', worktree: '/repos/impl-two' },
    ])
  })
})

describe('factLines prints the facts a human checks, conflict files included', () => {
  test('a failing base names its conflicting files, capped', () => {
    const facts = greenFacts({
      base: {
        ref: 'refs/remotes/origin/HEAD', sha: 'b'.repeat(40), behind: 3, mergeClean: false,
        conflicts: ['src/a.ts', 'src/b.ts'], moreConflicts: 2, status: 'fail', note: null,
      },
    })
    const lines = factLines(facts, null)
    expect(lines.some((line) => line.includes('CONFLICTS: src/a.ts, src/b.ts, +2 more'))).toBe(true)
    expect(lines.some((line) => line.includes('behind 3'))).toBe(true)
  })

  test('coverage clauses print their outcomes per citation, declared-uncovered named', () => {
    const facts = greenFacts()
    facts.coverage = [['ran-passed', 'run-unknown'], []]
    const map = [
      { clause: 'first', tests: [cite('src/a.test.ts', 'one'), cite('src/a.test.ts', 'two')] },
      { clause: 'declared', tests: [] },
    ]
    const lines = factLines(facts, map)
    expect(lines).toContain('coverage clause 1 "first" — ran-passed, run-unknown')
    expect(lines).toContain(`    ${cite('src/a.test.ts', 'one')}: ran-passed`)
    expect(lines).toContain('coverage clause 2 "declared" — declared uncovered')
  })

  test('a compared head names the task, its short head, and its conflicts', () => {
    const facts = greenFacts({
      branches: {
        compared: [{
          taskId: 'impl-two', head: 'c'.repeat(40), conflicts: ['shared.ts'], moreConflicts: 0,
          overlap: ['both.ts'], moreOverlap: 0, status: 'fail',
        }],
        comparedCount: 1, skipped: 0, status: 'fail',
      },
    })
    const line = factLines(facts, null).find((one) => one.includes('impl-two'))
    expect(line).toContain(`vs impl-two at ${'c'.repeat(12)}`)
    expect(line).toContain('CONFLICTS: shared.ts')
    expect(line).toContain('overlap: both.ts')
  })
})

describe('the script surface', () => {
  test('usage names every flag and the green rule', () => {
    const text = usageText()
    for (const flag of ['--worktree', '--commit', '--coverage', '--json']) {
      expect(text).toContain(flag)
    }
    expect(text).toContain('never covered-run-unknown')
  })

  test('resolveTarget refuses a directory outside a repository', () => {
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'verify-result-outside-')))
    try {
      expect(resolveTarget(outside)).toBeNull()
    } finally {
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })
})

// --- the spec scenarios, through the real script over a real repository ---

const FIXTURES_PARENT = path.join(REPO_ROOT, '.kawai-fixture-probes')

let tempDir: string
let repo: string

beforeEach(() => {
  fs.mkdirSync(FIXTURES_PARENT, { recursive: true })
  tempDir = fs.realpathSync(fs.mkdtempSync(path.join(FIXTURES_PARENT, 'verify-result-')))
  repo = path.join(tempDir, 'repo')
  fs.mkdirSync(repo)
  const init = runGit(['init', '--initial-branch=master', repo], { timeoutMs: 10_000 })
  if (!init.ok) throw new Error(`git init failed: ${init.stderr}`)
})
afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true })
  try {
    fs.rmdirSync(FIXTURES_PARENT)
  } catch {
    // a concurrent probe run still holds the parent
  }
})

function git(args: string[]): void {
  const result = runGit(args, { cwd: repo, timeoutMs: 10_000, env: COMMIT_ENV })
  if (!result.ok) throw new Error(`git ${args[0]} failed: ${result.stderr}`)
}

function commitFile(file: string, content: string): string {
  const absolute = path.join(repo, file)
  fs.mkdirSync(path.dirname(absolute), { recursive: true })
  fs.writeFileSync(absolute, content)
  git(['add', '--', file])
  git(['commit', '-m', 'fixture'])
  return runGit(['rev-parse', 'HEAD'], { cwd: repo, timeoutMs: 10_000 }).stdout.trim()
}

function setBase(sha: string): void {
  git(['update-ref', 'refs/remotes/origin/master', sha])
  git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/master'])
}

async function runScript(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn({
    cmd: [process.execPath, SCRIPT, ...args],
    // Anywhere outside the fixture repository: the script takes the
    // worktree from its flag, not from the working directory.
    cwd: os.tmpdir(),
    env: cleanGitEnv(),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const stdoutText = new Response(proc.stdout).text()
  const stderrText = new Response(proc.stderr).text()
  const code = await proc.exited
  return { code, stdout: await stdoutText, stderr: await stderrText }
}

// @covers: dev-checks › A local script reports a result's checks › A failing check
test('a commit conflicting with the base lists the conflicting files and exits non-zero', async () => {
  commitFile('file.txt', 'base\n')
  git(['checkout', '-b', 'feat'])
  const feat = commitFile('file.txt', 'feat\n')
  git(['checkout', 'master'])
  const master = commitFile('file.txt', 'master\n')
  setBase(master)
  git(['checkout', 'feat'])
  const { code, stdout, stderr } = await runScript(['--worktree', repo, '--commit', feat])
  if (code !== 1) throw new Error(`expected exit 1, got ${code}: ${stderr}`)
  expect(stdout).toContain('CONFLICTS')
  expect(stdout).toContain('file.txt')
}, 30_000)

// @covers: dev-checks › A local script reports a result's checks › Coverage from a file
test('a coverage file is checked citation by citation as Kawai does', async () => {
  const sha = commitFile(
    'src/a.test.ts',
    "import { test } from 'bun:test'\ntest('adds numbers', () => {})\n"
  )
  const mapFile = path.join(tempDir, 'map.json')
  fs.writeFileSync(
    mapFile,
    JSON.stringify([
      { clause: 'adds', tests: [cite('src/a.test.ts', 'adds numbers')] },
      { clause: 'missing', tests: [cite('src/a.test.ts', 'never written')] },
    ])
  )
  const { code, stdout } = await runScript(['--worktree', repo, '--commit', sha, '--coverage', mapFile])
  // No recorded list for this tree: the found citation reads run-unknown,
  // the absent one not-found — never fabricated, and the script is not green.
  expect(code).toBe(1)
  expect(stdout).toContain('run-unknown')
  expect(stdout).toContain('not-found')
}, 30_000)

// The bare run (no --commit) defaults the given text to HEAD, and HEAD is a
// worktree-local ref: in a linked worktree it must name that worktree's
// head, never the main checkout's.
test('a bare run in a linked worktree reports the linked worktree\'s HEAD, not the main checkout\'s', async () => {
  commitFile('main-only.txt', 'main\n')
  const linked = path.join(tempDir, 'linked')
  git(['worktree', 'add', '-b', 'feature', linked])
  const worktreeGit = (args: string[]): void => {
    const result = runGit(args, { cwd: linked, timeoutMs: 10_000, env: COMMIT_ENV })
    if (!result.ok) throw new Error(`git ${args[0]} failed: ${result.stderr}`)
  }
  fs.writeFileSync(path.join(linked, 'wt-only.txt'), 'wt\n')
  worktreeGit(['add', '--', 'wt-only.txt'])
  worktreeGit(['commit', '-m', 'fixture'])
  const linkedHead = runGit(['rev-parse', 'HEAD'], { cwd: linked, timeoutMs: 10_000 }).stdout.trim()
  const mainHead = runGit(['rev-parse', 'HEAD'], { cwd: repo, timeoutMs: 10_000 }).stdout.trim()
  expect(linkedHead).not.toBe(mainHead)
  const { code, stdout, stderr } = await runScript(['--worktree', linked, '--json'])
  if (code !== 1) throw new Error(`expected exit 1, got ${code}: ${stderr}${stdout}`)
  const facts = JSON.parse(stdout) as ResultCheckFacts
  expect(facts.commit.given).toBe('HEAD')
  expect(facts.commit.sha).toBe(linkedHead)
  expect(facts.head?.sha).toBe(linkedHead)
}, 30_000)

// @covers: dev-checks › A local script reports a result's checks › Same answer as Kawai
test('the script reports the same facts as the module Kawai runs, green when all green', async () => {
  const sha = commitFile(
    'src/a.test.ts',
    "import { test } from 'bun:test'\ntest('adds numbers', () => {})\n"
  )
  const tree = runGit(['rev-parse', `${sha}^{tree}`], { cwd: repo, timeoutMs: 10_000 }).stdout.trim()
  // The records Kawai's own check machinery writes: a list beside a record
  // of this tree, on this host.
  const dir = recordsDir(repo)
  const key = 'a'.repeat(64)
  writeTestList(dir, key, [{ file: 'src/a.test.ts', path: '', name: 'adds numbers', status: 'passed' }])
  writeRecord(dir, {
    key,
    treeId: tree,
    bun: '1.4.3',
    platform: process.platform,
    arch: process.arch,
    at: new Date().toISOString(),
    worktree: repo,
    steps: [],
    tests: { file: testListName(key), count: 1 },
  })
  setBase(sha)
  const mapFile = path.join(tempDir, 'map.json')
  const map = [{ clause: 'adds', tests: [cite('src/a.test.ts', 'adds numbers')] }]
  fs.writeFileSync(mapFile, JSON.stringify(map))
  const { code, stdout, stderr } = await runScript([
    '--worktree', repo, '--commit', sha, '--coverage', mapFile, '--json',
  ])
  if (code !== 0) throw new Error(`expected exit 0, got ${code}: ${stderr}${stdout}`)
  // Same module, same readers, same answers — the wiring is the difference,
  // and the JSON is identical.
  const scriptFacts = JSON.parse(stdout) as ResultCheckFacts
  const kawaiFacts = await computeResultFacts(
    {
      given: sha,
      worktree: repo,
      repoRoot: repo,
      others: [],
      host: HOST,
      coverage: validateCoverageMap(map),
      testList: (treeId) => readTreeTestList(repo, treeId),
    },
    makeCheckGit()
  )
  expect(scriptFacts).toEqual(kawaiFacts)
}, 30_000)

// --- K6: the script is read-only and a usage error exits 2 ---

/** Every path under `root` — directories by name, files with a sha256 of
 * their bytes, sorted: a content snapshot. Bytes, not mtimes: git may
 * freshen an existing loose object's mtime without writing a byte (the
 * carve-out resultChecks.ts documents for merge-tree). */
function snapshotTree(root: string): string[] {
  const lines: string[] = []
  const walk = (relative: string): void => {
    const absolute = path.join(root, relative)
    const stats = fs.lstatSync(absolute)
    if (stats.isDirectory()) {
      lines.push(`d ${relative}`)
      for (const entry of fs.readdirSync(absolute).sort()) {
        walk(path.join(relative, entry))
      }
    } else if (stats.isFile()) {
      const hash = new Bun.CryptoHasher('sha256').update(fs.readFileSync(absolute)).digest('hex')
      lines.push(`f ${relative} ${hash}`)
    } else {
      lines.push(`o ${relative}`)
    }
  }
  walk('')
  return lines
}

test('a full green run leaves the worktree, git dir, and records dir byte-for-byte unchanged (K6)', async () => {
  const sha = commitFile(
    'src/a.test.ts',
    "import { test } from 'bun:test'\ntest('adds numbers', () => {})\n"
  )
  const tree = runGit(['rev-parse', `${sha}^{tree}`], { cwd: repo, timeoutMs: 10_000 }).stdout.trim()
  // A recorded pass with a list, exactly as the machinery writes it.
  const dir = recordsDir(repo)
  const key = 'a'.repeat(64)
  writeTestList(dir, key, [{ file: 'src/a.test.ts', path: '', name: 'adds numbers', status: 'passed' }])
  writeRecord(dir, {
    key,
    treeId: tree,
    bun: '1.4.3',
    platform: process.platform,
    arch: process.arch,
    at: new Date().toISOString(),
    worktree: repo,
    steps: [],
    tests: { file: testListName(key), count: 1 },
  })
  // The base is HEAD itself: merge-tree --write-tree then merges the tree
  // onto itself and writes no new object, so the one write git may make on
  // this path stays out of the comparison.
  setBase(sha)
  const mapFile = path.join(tempDir, 'map.json')
  fs.writeFileSync(
    mapFile,
    JSON.stringify([{ clause: 'adds', tests: [cite('src/a.test.ts', 'adds numbers')] }])
  )
  const before = snapshotTree(repo)
  const { code, stderr } = await runScript(['--worktree', repo, '--commit', sha, '--coverage', mapFile])
  if (code !== 0) throw new Error(`expected a green run, got ${code}: ${stderr}`)
  expect(snapshotTree(repo)).toEqual(before)
}, 30_000)

test('a usage error exits 2: an unknown flag, and an unreadable --coverage file (K6)', async () => {
  expect((await runScript(['--wat'])).code).toBe(2)
  const sha = commitFile(
    'src/a.test.ts',
    "import { test } from 'bun:test'\ntest('adds numbers', () => {})\n"
  )
  const missing = path.join(tempDir, 'no-such-map.json')
  const unreadable = await runScript(['--worktree', repo, '--commit', sha, '--coverage', missing])
  expect(unreadable.code).toBe(2)
  expect(unreadable.stderr).toContain('cannot read the coverage file')
}, 30_000)
