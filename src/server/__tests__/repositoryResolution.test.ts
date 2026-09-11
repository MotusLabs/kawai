// repositoryResolution.test.ts - Task 2.1 coverage: canonicalizes known local
// project paths, resolves worktree/common Git directories, and deduplicates
// repositories. Uses real git repositories in temp directories.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  canonicalizePath,
  resolveGitDirs,
  resolveSeedRepositories,
} from '../git/repositoryResolution'
import { runGit } from '../git/gitCommand'

let tempRoot: string

function gitInit(dir: string): void {
  fs.mkdirSync(dir, { recursive: true })
  runGit(['init', '--initial-branch=main', dir], { timeoutMs: 5000 })
  runGit(['-C', dir, 'commit', '--allow-empty', '-m', 'init'], {
    timeoutMs: 5000,
    env: {
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  })
}

beforeAll(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-repores-'))
})

afterAll(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true })
})

describe('canonicalizePath', () => {
  test('resolves symlinks on existing paths', () => {
    const real = path.join(tempRoot, 'real-dir')
    fs.mkdirSync(real, { recursive: true })
    const link = path.join(tempRoot, 'link-dir')
    try {
      fs.symlinkSync(real, link)
      expect(canonicalizePath(path.join(link, 'sub'))).toBe(path.join(real, 'sub'))
    } finally {
      fs.rmSync(link, { force: true })
    }
  })

  test('preserves deleted tails on the longest existing ancestor', () => {
    const existing = path.join(tempRoot, 'exists')
    fs.mkdirSync(existing, { recursive: true })
    const deleted = path.join(existing, 'deleted', 'leaf')
    expect(canonicalizePath(deleted)).toBe(deleted)
  })

  test('returns absolute resolved input unchanged when it exists', () => {
    const dir = path.join(tempRoot, 'plain')
    fs.mkdirSync(dir, { recursive: true })
    expect(canonicalizePath(dir)).toBe(fs.realpathSync(dir))
  })
})

describe('resolveGitDirs', () => {
  test('resolves a repository root', () => {
    const repo = path.join(tempRoot, 'repo-a')
    gitInit(repo)
    const dirs = resolveGitDirs(repo)
    expect(dirs).not.toBeNull()
    const canonical = canonicalizePath(repo)
    expect(dirs?.toplevel).toBe(canonical)
    expect(dirs?.gitDir).toBe(path.join(canonical, '.git'))
    expect(dirs?.commonDir).toBe(path.join(canonical, '.git'))
  })

  test('resolves linked worktrees to a shared common dir', () => {
    const repo = path.join(tempRoot, 'repo-linked')
    gitInit(repo)
    const worktree = path.join(tempRoot, 'repo-linked-wt')
    runGit(['-C', repo, 'worktree', 'add', worktree, '-b', 'linked-branch'], { timeoutMs: 10_000 })
    const dirs = resolveGitDirs(worktree)
    expect(dirs?.toplevel).toBe(canonicalizePath(worktree))
    expect(dirs?.commonDir).toBe(path.join(canonicalizePath(repo), '.git'))
    expect(dirs?.gitDir).not.toBe(dirs?.commonDir)
    fs.rmSync(worktree, { recursive: true, force: true })
  })

  test('resolves paths beneath the worktree root to the same repository', () => {
    const repo = path.join(tempRoot, 'repo-b')
    gitInit(repo)
    const nested = path.join(repo, 'src', 'deep')
    fs.mkdirSync(nested, { recursive: true })
    const dirs = resolveGitDirs(nested)
    expect(dirs?.toplevel).toBe(canonicalizePath(repo))
  })

  test('returns null for non-Git paths', () => {
    const plain = path.join(tempRoot, 'plain-dir')
    fs.mkdirSync(plain, { recursive: true })
    expect(resolveGitDirs(plain)).toBeNull()
  })

  test('returns null for deleted paths', () => {
    expect(resolveGitDirs(path.join(tempRoot, 'never-existed'))).toBeNull()
  })
})

describe('resolveSeedRepositories', () => {
  test('deduplicates duplicate seeds into one repository', () => {
    const repo = path.join(tempRoot, 'repo-c')
    gitInit(repo)
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true })
    const seeds = [
      repo,
      path.join(repo, 'src'),
      repo + '/',
      canonicalizePath(repo),
    ]
    const result = resolveSeedRepositories(seeds)
    expect(result.repositories.size).toBe(1)
    const id = path.join(canonicalizePath(repo), '.git')
    expect(result.repositories.get(id)?.toplevel).toBe(canonicalizePath(repo))
  })

  test('keeps nested repositories distinct', () => {
    const outer = path.join(tempRoot, 'outer')
    gitInit(outer)
    const inner = path.join(outer, 'inner')
    gitInit(inner)
    const result = resolveSeedRepositories([outer, inner])
    expect(result.repositories.size).toBe(2)
  })

  test('skips relative and empty seeds', () => {
    const result = resolveSeedRepositories(['', 'relative/path'])
    expect(result.seeds).toHaveLength(0)
    expect(result.repositories.size).toBe(0)
  })

  test('records non-Git seeds without creating repositories', () => {
    const plain = path.join(tempRoot, 'non-git')
    fs.mkdirSync(plain, { recursive: true })
    const result = resolveSeedRepositories([plain])
    expect(result.seeds).toHaveLength(1)
    expect(result.seeds[0].dirs).toBeNull()
    expect(result.repositories.size).toBe(0)
  })

  test('deduplicates repositories reached via symlinked seed paths', () => {
    const repo = path.join(tempRoot, 'repo-d')
    gitInit(repo)
    const link = path.join(tempRoot, 'repo-d-link')
    try {
      fs.symlinkSync(repo, link)
      const result = resolveSeedRepositories([repo, link])
      expect(result.repositories.size).toBe(1)
    } finally {
      fs.rmSync(link, { force: true })
    }
  })
})
