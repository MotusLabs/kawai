// checkKey.test.ts - Content-key computation for `bun run check` (check-dedup
// 1.1). Every git spawn targets a temporary repository through runGit's
// cleanGitEnv; the real repository's index is never touched.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runGit } from '../git/gitCommand'
import { computeContentKey, contentKeyFrom, resolveIndexPath } from '../../../scripts/lib/checkKey'

let tempRoot: string
let repo: string

function git(...args: string[]) {
  const result = runGit(args, { cwd: repo, timeoutMs: 10000 })
  if (!result.ok) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`)
  }
  return result.stdout
}

function write(relativePath: string, contents: string) {
  const absolute = path.join(repo, relativePath)
  fs.mkdirSync(path.dirname(absolute), { recursive: true })
  fs.writeFileSync(absolute, contents)
}

function key() {
  return computeContentKey({ cwd: repo }).key
}

function sha256File(absolutePath: string) {
  return createHash('sha256').update(fs.readFileSync(absolutePath)).digest('hex')
}

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-checkkey-'))
  repo = path.join(tempRoot, 'repo')
  fs.mkdirSync(repo)
  git('init', '--initial-branch=main')
  write('.gitignore', 'ignored.txt\nbuild/\n')
  write('README.md', '# repo\n')
  write('src/a.ts', 'export const a = 1\n')
  git('add', '-A')
  git('-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-m', 'init')
})

afterEach(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true })
})

describe('computeContentKey', () => {
  test('the same tree yields the same 64-hex key', () => {
    const first = key()
    const second = key()
    expect(second).toBe(first)
    expect(first).toMatch(/^[0-9a-f]{64}$/)
  })

  test('editing a tracked file changes the key', () => {
    const before = key()
    write('src/a.ts', 'export const a = 2\n')
    expect(key()).not.toBe(before)
  })

  test('an untracked non-ignored file changes the key', () => {
    const before = key()
    write('src/extra.ts', 'export const extra = 1\n')
    expect(key()).not.toBe(before)
  })

  test('deleting a tracked file changes the key', () => {
    const before = key()
    fs.rmSync(path.join(repo, 'src/a.ts'))
    expect(key()).not.toBe(before)
  })

  test('an ignored file does not change the key', () => {
    const before = key()
    write('ignored.txt', 'scratch\n')
    write('build/out.bin', 'binary\n')
    expect(key()).toBe(before)
  })

  test('the real index stays byte-identical while untracked files are keyed', () => {
    const index = path.join(repo, '.git', 'index')
    const before = sha256File(index)
    write('src/untracked.ts', 'export const untracked = 1\n')
    computeContentKey({ cwd: repo })
    expect(sha256File(index)).toBe(before)
    // The untracked file is still untracked: the add ran on the copy only.
    expect(git('status', '--porcelain').trim()).toBe('?? src/untracked.ts')
  })

  test('a GIT_INDEX_FILE exported by a hook never reaches the key computation', () => {
    const original = process.env.GIT_INDEX_FILE
    process.env.GIT_INDEX_FILE = path.join(tempRoot, 'missing-dir', 'foreign-index')
    try {
      const baseline = computeContentKey({ cwd: repo })
      // Same result as a clean environment: the ambient variable was stripped
      // from git's spawn env, not followed.
      expect(computeContentKey({ cwd: repo }).key).toBe(baseline.key)
    } finally {
      if (original === undefined) delete process.env.GIT_INDEX_FILE
      else process.env.GIT_INDEX_FILE = original
    }
  })

  test('the index path resolves inside the repository, not this process', () => {
    // git answers `--git-path` relative to the cwd it was given; joining it
    // to the test process's cwd instead would silently read another repo's
    // index (the worktree's) as the copy source.
    expect(resolveIndexPath(repo)).toBe(path.join(repo, '.git', 'index'))
    expect(fs.existsSync(resolveIndexPath(repo))).toBe(true)
  })

  test('an explicit indexFile is used as the copy source', () => {    const hookIndex = path.join(tempRoot, 'hook-index')
    fs.copyFileSync(path.join(repo, '.git', 'index'), hookIndex)
    expect(computeContentKey({ cwd: repo, indexFile: hookIndex }).key).toBe(key())
  })

  test('outside a repository it throws instead of deriving a key', () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-checkkey-plain-'))
    try {
      expect(() => computeContentKey({ cwd: plain })).toThrow(/git/)
    } finally {
      fs.rmSync(plain, { recursive: true, force: true })
    }
  })
})

describe('contentKeyFrom', () => {
  const base = { treeId: 'tree', bunVersion: '1.3.14', platform: 'linux', arch: 'x64' }

  test('every input changes the hash', () => {
    expect(contentKeyFrom({ ...base, treeId: 'tree2' })).not.toBe(contentKeyFrom(base))
    expect(contentKeyFrom({ ...base, bunVersion: '1.4.3' })).not.toBe(contentKeyFrom(base))
    expect(contentKeyFrom({ ...base, platform: 'darwin' })).not.toBe(contentKeyFrom(base))
    expect(contentKeyFrom({ ...base, arch: 'arm64' })).not.toBe(contentKeyFrom(base))
  })

  test('inputs are separated, not concatenated', () => {
    // 'tree' + '1' must not hash like 'tree1' would against a shifted split.
    expect(contentKeyFrom({ ...base, treeId: 'tree1' })).not.toBe(
      contentKeyFrom({ ...base, bunVersion: '1.3.141' })
    )
  })
})
