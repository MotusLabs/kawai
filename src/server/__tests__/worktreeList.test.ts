// worktreeList.test.ts - Task 2.2 coverage: fixture-based parsing of
// `git worktree list --porcelain` and `git for-each-ref refs/heads` output
// covering linked and detached worktrees plus packed and loose refs.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runGit } from '../git/gitCommand'
import {
  assignBranches,
  discoverRepository,
  parseForEachRefHeads,
  parseWorktreePorcelain,
} from '../git/worktreeList'

const COMMIT_ENV = {
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
}

let tempRoot: string

function gitInit(dir: string): void {
  fs.mkdirSync(dir, { recursive: true })
  runGit(['init', '--initial-branch=main', dir], { timeoutMs: 5000 })
  runGit(['-C', dir, 'commit', '--allow-empty', '-m', 'init'], {
    timeoutMs: 5000,
    env: COMMIT_ENV,
  })
}

beforeAll(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-wtlist-'))
})

afterAll(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true })
})

describe('parseWorktreePorcelain fixtures', () => {
  test('parses main, linked, and detached worktrees', () => {
    const fixture = [
      'worktree /repos/main',
      'HEAD 0123456789abcdef0123456789abcdef01234567',
      'branch refs/heads/main',
      '',
      'worktree /repos/linked',
      'HEAD fedcba9876543210fedcba9876543210fedcba98',
      'branch refs/heads/feature/x',
      '',
      'worktree /repos/detached',
      'HEAD abcdefabcdefabcdefabcdefabcdefabcdefabcd',
      'detached',
      '',
    ].join('\n')

    const worktrees = parseWorktreePorcelain(fixture)
    expect(worktrees).toHaveLength(3)

    const [main, linked, detached] = worktrees
    expect(main).toMatchObject({
      path: '/repos/main',
      branch: 'main',
      detached: false,
      isMain: true,
      headRevision: '0123456789abcdef0123456789abcdef01234567',
    })
    expect(linked).toMatchObject({
      path: '/repos/linked',
      branch: 'feature/x',
      detached: false,
      isMain: false,
    })
    expect(detached).toMatchObject({
      path: '/repos/detached',
      detached: true,
      isMain: false,
    })
    expect(detached.branch).toBeUndefined()
  })

  test('marks prunable and locked worktrees', () => {
    const fixture = [
      'worktree /repos/main',
      'HEAD aaa',
      'branch refs/heads/main',
      '',
      'worktree /repos/gone',
      'HEAD bbb',
      'branch refs/heads/gone-branch',
      'prunable gitdir is a .git file pointing to a missing directory',
      '',
      'worktree /repos/locked',
      'HEAD ccc',
      'detached',
      'locked reason',
      '',
    ].join('\n')

    const worktrees = parseWorktreePorcelain(fixture)
    expect(worktrees[1].prunable).toBe(true)
    expect(worktrees[1].locked).toBe(false)
    expect(worktrees[2].locked).toBe(true)
  })

  test('ignores entries missing path or HEAD and unknown attributes', () => {
    const fixture = [
      'bare',
      '',
      'worktree /repos/partial',
      'branch refs/heads/x',
      '',
      'worktree /repos/ok',
      'HEAD abc1234',
      'future-attribute value',
      '',
    ].join('\n')
    const worktrees = parseWorktreePorcelain(fixture)
    expect(worktrees).toHaveLength(1)
    expect(worktrees[0].path).toBe('/repos/ok')
    expect(worktrees[0].isMain).toBe(true)
  })

  test('handles crlf line endings and trailing blank lines', () => {
    const fixture = 'worktree /repos/main\r\nHEAD abc\r\nbranch refs/heads/main\r\n\r\n'
    const worktrees = parseWorktreePorcelain(fixture)
    expect(worktrees).toHaveLength(1)
    expect(worktrees[0].branch).toBe('main')
  })
})

describe('parseForEachRefHeads fixtures', () => {
  test('parses revision and short ref name pairs', () => {
    const fixture = [
      '0123456789abcdef0123456789abcdef01234567 main',
      'fedcba9876543210fedcba9876543210fedcba98 feature/add-auth',
      '1234567890123456789012345678901234567890 release/v1.2',
    ].join('\n')
    const branches = parseForEachRefHeads(fixture)
    expect(branches).toEqual([
      { name: 'main', revision: '0123456789abcdef0123456789abcdef01234567' },
      { name: 'feature/add-auth', revision: 'fedcba9876543210fedcba9876543210fedcba98' },
      { name: 'release/v1.2', revision: '1234567890123456789012345678901234567890' },
    ])
  })

  test('skips malformed lines', () => {
    const fixture = ['', 'not-a-ref', 'short rev-only', 'zzzz main', '0123456789abcdef0123456789abcdef01234567 ']
    const branches = parseForEachRefHeads(fixture.join('\n'))
    expect(branches).toEqual([])
  })
})

describe('assignBranches', () => {
  test('annotates assigned branches and leaves unassigned ones bare', () => {
    const worktrees = parseWorktreePorcelain(
      [
        'worktree /repos/main',
        'HEAD aaa',
        'branch refs/heads/main',
        '',
        'worktree /repos/linked',
        'HEAD bbb',
        'branch refs/heads/feat',
        '',
      ].join('\n')
    )
    const assigned = assignBranches(worktrees, [
      { name: 'main', revision: 'aaa' },
      { name: 'feat', revision: 'bbb' },
      { name: 'spare', revision: 'ccc' },
    ])
    expect(assigned).toEqual([
      { name: 'main', revision: 'aaa', assignedWorktreePath: '/repos/main' },
      { name: 'feat', revision: 'bbb', assignedWorktreePath: '/repos/linked' },
      { name: 'spare', revision: 'ccc' },
    ])
  })
})

describe('discoverRepository against real git', () => {
  test('covers linked worktrees, detached HEAD, and packed refs', () => {
    const repo = path.join(tempRoot, 'repo')
    const linked = path.join(tempRoot, 'repo-linked')
    const detached = path.join(tempRoot, 'repo-detached')
    gitInit(repo)

    runGit(['-C', repo, 'branch', 'spare-branch'], { timeoutMs: 5000 })
    runGit(['-C', repo, 'worktree', 'add', linked, '-b', 'linked-branch'], { timeoutMs: 10_000 })
    runGit(['-C', repo, 'worktree', 'add', '--detach', detached], { timeoutMs: 10_000 })
    // Pack refs so branch discovery must handle packed-refs, not just loose.
    runGit(['-C', repo, 'pack-refs', '--all'], { timeoutMs: 5000 })

    const commonDir = path.join(repo, '.git')
    const info = discoverRepository(commonDir)
    expect(info).not.toBeNull()

    const paths = info!.worktrees.map((worktree) => worktree.path)
    expect(paths).toContain(repo)
    expect(paths).toContain(linked)
    expect(paths).toContain(detached)

    const linkedInfo = info!.worktrees.find((worktree) => worktree.path === linked)
    expect(linkedInfo?.branch).toBe('linked-branch')
    expect(linkedInfo?.detached).toBe(false)

    const detachedInfo = info!.worktrees.find((worktree) => worktree.path === detached)
    expect(detachedInfo?.detached).toBe(true)
    expect(detachedInfo?.branch).toBeUndefined()

    const branchNames = info!.branches.map((branch) => branch.name).sort()
    expect(branchNames).toEqual(['linked-branch', 'main', 'spare-branch'])

    const spare = info!.branches.find((branch) => branch.name === 'spare-branch')
    expect(spare?.assignedWorktreePath).toBeUndefined()

    const mainBranch = info!.branches.find((branch) => branch.name === 'main')
    expect(mainBranch?.assignedWorktreePath).toBe(repo)
  })

  test('returns null for an invalid common dir', () => {
    expect(discoverRepository(path.join(tempRoot, 'not-a-git-dir'))).toBeNull()
  })
})
