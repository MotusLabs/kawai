// checkKey.test.ts - Content-key computation for `bun run check` (check-dedup
// 1.1). Every git spawn targets a temporary repository through runGit's
// cleanGitEnv; the real repository's index is never touched.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runGit } from '../git/gitCommand'
import {
  HiddenIndexEntriesError,
  describeHidden,
  computeContentKey,
  contentKeyFrom,
  hiddenEntries,
  resolveIndexPath,
} from '../checks/checkKey'
import { recordsDir } from '../checks/checkRecords'
import { runCheck } from '../../../scripts/lib/checkRun'

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

  test('an explicit indexFile is used as the copy source', () => {
    const hookIndex = path.join(tempRoot, 'hook-index')
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

// per-result-suite CP1 F1: a skip-worktree or assume-unchanged entry hides
// its on-disk edit from `add -A`, so the key would name HEAD's content while
// the steps read the edit. The key refuses such an index outright.
describe('hidden index entries', () => {
  test('a skip-worktree edit refuses the key, naming the path', () => {
    git('update-index', '--skip-worktree', 'src/a.ts')
    write('src/a.ts', 'export const a = HIDDEN\n')
    // git status cannot see it: the clean-tree test alone would pass.
    expect(git('status', '--porcelain', '--untracked-files=all').trim()).toBe('')
    expect(() => key()).toThrow(HiddenIndexEntriesError)
    expect(() => key()).toThrow(/skip-worktree: src\/a\.ts — clear with `git update-index --no-skip-worktree -- src\/a\.ts`/)
    expect(() => key()).toThrow(/Sparse checkouts are not supported: run `git sparse-checkout disable`/)
  })

  test('an assume-unchanged edit refuses the key, naming the path', () => {
    git('update-index', '--assume-unchanged', 'src/a.ts')
    write('src/a.ts', 'export const a = HIDDEN\n')
    expect(() => key()).toThrow(/1 index entry hides working-tree content/)
    expect(() => key()).toThrow(/assume-unchanged: src\/a\.ts — clear with `git update-index --no-assume-unchanged -- src\/a\.ts`/)
  })

  test('an index without the flags keys normally', () => {
    expect(hiddenEntries(git('ls-files', '-v', '-z'))).toEqual([])
    expect(key()).toMatch(/^[0-9a-f]{64}$/)
  })

  test('the tag rule: S and lowercase tags hide, other tags do not', () => {
    const listing = ['H keep.ts', 'S skip.ts', 'h assume.ts', 's both.ts', 'M merge.ts', 'C changed.ts', '']
    expect(hiddenEntries(listing.join('\0'))).toEqual([
      { path: 'skip.ts', skipWorktree: true, assumeUnchanged: false },
      { path: 'assume.ts', skipWorktree: false, assumeUnchanged: true },
      { path: 'both.ts', skipWorktree: true, assumeUnchanged: true },
    ])
  })

  test('the fix names one command per flag with that flag\'s paths, shell-quoted', () => {
    const text = describeHidden([
      { path: 'a b.ts', skipWorktree: true, assumeUnchanged: false },
      { path: 'c.ts', skipWorktree: true, assumeUnchanged: true },
    ])
    expect(text).toContain("skip-worktree: a b.ts, c.ts — clear with `git update-index --no-skip-worktree -- 'a b.ts' c.ts`")
    expect(text).toContain('assume-unchanged: c.ts — clear with `git update-index --no-assume-unchanged -- c.ts`')
    expect(text).toContain('`git sparse-checkout disable`')
  })

  test('the check errors and records nothing over a hidden entry', async () => {
    git('update-index', '--skip-worktree', 'src/a.ts')
    write('src/a.ts', 'export const a = HIDDEN\n')
    let spawned = 0
    const outcome = await runCheck({
      cwd: repo,
      steps: [{ name: 'test', command: ['true'] }],
      spawn: async () => {
        spawned += 1
        return 0
      },
    })
    expect(outcome.kind).toBe('error')
    if (outcome.kind === 'error') expect(outcome.message).toContain('src/a.ts')
    expect(spawned).toBe(0)
    const dir = recordsDir(repo)
    const records = fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.endsWith('.json')) : []
    expect(records).toEqual([])
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
