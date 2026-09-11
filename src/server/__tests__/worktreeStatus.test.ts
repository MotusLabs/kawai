// worktreeStatus.test.ts - Task 2.3 coverage: bounded dirty-state discovery
// (tracked/untracked changes, clean worktrees) and deepest-worktree path
// matching (path-boundary safety, nested matches).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runGit } from '../git/gitCommand'
import { deepestWorktreeMatch, isWorktreeDirty } from '../git/worktreeStatus'

const COMMIT_ENV = {
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
}

let tempRoot: string

beforeAll(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-wtstatus-'))
})

afterAll(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true })
})

function gitInit(dir: string): void {
  fs.mkdirSync(dir, { recursive: true })
  runGit(['init', '--initial-branch=main', dir], { timeoutMs: 5000 })
  fs.writeFileSync(path.join(dir, 'file.txt'), 'initial\n')
  runGit(['-C', dir, 'add', 'file.txt'], { timeoutMs: 5000 })
  runGit(['-C', dir, 'commit', '-m', 'init'], { timeoutMs: 5000, env: COMMIT_ENV })
}

describe('isWorktreeDirty', () => {
  test('reports clean worktree as not dirty', () => {
    const repo = path.join(tempRoot, 'clean')
    gitInit(repo)
    expect(isWorktreeDirty(repo)).toBe(false)
  })

  test('detects tracked modifications', () => {
    const repo = path.join(tempRoot, 'tracked')
    gitInit(repo)
    fs.writeFileSync(path.join(repo, 'file.txt'), 'modified\n')
    expect(isWorktreeDirty(repo)).toBe(true)
  })

  test('detects untracked files', () => {
    const repo = path.join(tempRoot, 'untracked')
    gitInit(repo)
    fs.writeFileSync(path.join(repo, 'new-file.txt'), 'untracked\n')
    expect(isWorktreeDirty(repo)).toBe(true)
  })

  test('returns false for a missing worktree', () => {
    expect(isWorktreeDirty(path.join(tempRoot, 'missing'))).toBe(false)
  })

  test('detects dirty state in linked worktrees independently', () => {
    const repo = path.join(tempRoot, 'multi')
    const linked = path.join(tempRoot, 'multi-linked')
    gitInit(repo)
    runGit(['-C', repo, 'worktree', 'add', linked, '-b', 'linked'], { timeoutMs: 10_000 })
    expect(isWorktreeDirty(repo)).toBe(false)
    expect(isWorktreeDirty(linked)).toBe(false)
    fs.writeFileSync(path.join(linked, 'linked-file.txt'), 'untracked\n')
    expect(isWorktreeDirty(repo)).toBe(false)
    expect(isWorktreeDirty(linked)).toBe(true)
  })
})

describe('deepestWorktreeMatch', () => {
  test('matches the worktree root exactly', () => {
    expect(deepestWorktreeMatch('/repo', ['/repo'])).toBe('/repo')
  })

  test('matches paths beneath the root', () => {
    expect(deepestWorktreeMatch('/repo/src/deep', ['/repo'])).toBe('/repo')
  })

  test('respects path boundaries', () => {
    expect(deepestWorktreeMatch('/repo-x/file', ['/repo'])).toBeNull()
    expect(deepestWorktreeMatch('/repository', ['/repo'])).toBeNull()
    expect(deepestWorktreeMatch('/rep', ['/repo'])).toBeNull()
  })

  test('returns null for paths outside every worktree', () => {
    expect(deepestWorktreeMatch('/elsewhere', ['/repo', '/other'])).toBeNull()
  })

  test('prefers the deepest nested match', () => {
    const worktrees = ['/repo', '/repo/inner-wt', '/repo/inner-wt/deeper-wt']
    expect(deepestWorktreeMatch('/repo/inner-wt/deeper-wt/src', worktrees)).toBe(
      '/repo/inner-wt/deeper-wt'
    )
    expect(deepestWorktreeMatch('/repo/inner-wt/src', worktrees)).toBe('/repo/inner-wt')
    expect(deepestWorktreeMatch('/repo/src', worktrees)).toBe('/repo')
  })

  test('exact nested root wins over containing worktree', () => {
    expect(deepestWorktreeMatch('/repo/inner-wt', ['/repo', '/repo/inner-wt'])).toBe(
      '/repo/inner-wt'
    )
  })
})
