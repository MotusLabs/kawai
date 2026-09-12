// createWorktree.test.ts - Task 8.3 coverage: real-git integration tests for
// the server create-worktree operation — success, existing destinations,
// assigned branches (concurrent assignment), invalid repositories, git
// command failure, containment, and injection-like inputs. No force flags,
// argument-array invocation only.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runGit } from '../git/gitCommand'
import { createWorktree } from '../git/createWorktree'
import { discoverRepository } from '../git/worktreeList'

const COMMIT_ENV = {
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
}

let tempRoot: string
let repoDir: string
let repoCommonDir: string

function gitInRepo(args: string[]) {
  return runGit(['-C', repoDir, ...args], { timeoutMs: 10_000, env: COMMIT_ENV })
}

beforeAll(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-create-wt-'))
  fs.mkdirSync(path.join(tempRoot, 'repo'), { recursive: true })
  repoDir = fs.realpathSync(path.join(tempRoot, 'repo'))
  runGit(['init', '--initial-branch=main', repoDir], { timeoutMs: 10_000 })
  gitInRepo(['commit', '--allow-empty', '-m', 'init'])
  gitInRepo(['branch', 'feat-x'])
  gitInRepo(['branch', 'spare'])
  repoCommonDir = `${fs.realpathSync(repoDir)}/.git`
})

afterAll(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true })
})

describe('createWorktree operation', () => {
  test('creates a worktree for an unassigned branch at an absolute destination', () => {
    const destination = path.join(tempRoot, 'repo-feat-x')

    const result = createWorktree({
      repositoryId: repoCommonDir,
      branch: 'feat-x',
      destination,
    })

    expect(result).toEqual({
      operation: 'create-worktree',
      ok: true,
      repositoryId: repoCommonDir,
      branch: 'feat-x',
      path: fs.realpathSync(destination),
    })
    expect(fs.existsSync(path.join(destination, '.git'))).toBe(true)

    // The branch is now checked out in the new worktree.
    const info = discoverRepository(repoCommonDir)
    const created = info?.worktrees.find((worktree) => worktree.path === fs.realpathSync(destination))
    expect(created).toMatchObject({ branch: 'feat-x', detached: false })

    // And re-creating the same branch is refused as assigned.
    const duplicate = createWorktree({
      repositoryId: repoCommonDir,
      branch: 'feat-x',
      destination: path.join(tempRoot, 'repo-feat-x-2'),
    })
    expect(duplicate).toMatchObject({
      ok: false,
      code: 'ERR_WORKTREE_BRANCH_ASSIGNED',
    })
    expect(fs.existsSync(path.join(tempRoot, 'repo-feat-x-2'))).toBe(false)
  })

  test('rejects an existing destination without modifying it', () => {
    const existing = path.join(tempRoot, 'existing-dir')
    fs.mkdirSync(existing)
    fs.writeFileSync(path.join(existing, 'marker.txt'), 'keep')

    const result = createWorktree({
      repositoryId: repoCommonDir,
      branch: 'spare',
      destination: existing,
    })

    expect(result).toMatchObject({
      ok: false,
      code: 'ERR_WORKTREE_DESTINATION_EXISTS',
    })
    expect(fs.readFileSync(path.join(existing, 'marker.txt'), 'utf8')).toBe('keep')
    expect(fs.readdirSync(existing)).toEqual(['marker.txt'])
  })

  test('rejects a branch already assigned in a linked worktree (concurrent assignment)', () => {
    // feat-x was checked out by the success test — the immediate
    // revalidation must catch the assignment before any git mutation.
    const result = createWorktree({
      repositoryId: repoCommonDir,
      branch: 'feat-x',
      destination: path.join(tempRoot, 'late-attempt'),
    })

    expect(result).toMatchObject({ ok: false, code: 'ERR_WORKTREE_BRANCH_ASSIGNED' })
    expect(result).toMatchObject({ error: expect.stringContaining('feat-x') })
    expect(fs.existsSync(path.join(tempRoot, 'late-attempt'))).toBe(false)
  })

  test('rejects invalid repositories and unknown branches', () => {
    const notARepo = path.join(tempRoot, 'not-a-repo')
    fs.mkdirSync(notARepo)

    expect(
      createWorktree({
        repositoryId: `${notARepo}/.git`,
        branch: 'spare',
        destination: path.join(tempRoot, 'n/a'),
      })
    ).toMatchObject({ ok: false, code: 'ERR_WORKSPACE_UNKNOWN_REPOSITORY' })

    expect(
      createWorktree({
        repositoryId: repoCommonDir,
        branch: 'does-not-exist',
        destination: path.join(tempRoot, 'unknown-branch-dest'),
      })
    ).toMatchObject({ ok: false, code: 'ERR_WORKTREE_UNKNOWN_BRANCH' })
    expect(fs.existsSync(path.join(tempRoot, 'unknown-branch-dest'))).toBe(false)
  })

  test('surfaces git command failure without partial destinations', () => {
    // A file occupies the parent directory level git needs to create.
    const blocker = path.join(tempRoot, 'blocker')
    fs.writeFileSync(blocker, 'file, not directory')

    const result = createWorktree({
      repositoryId: repoCommonDir,
      branch: 'spare',
      destination: path.join(blocker, 'child'),
    })

    expect(result).toMatchObject({ ok: false, code: 'ERR_WORKTREE_CREATE_FAILED' })
    expect(result).toMatchObject({
      error: expect.stringContaining('git worktree add failed'),
    })
    // The blocker file is untouched.
    expect(fs.readFileSync(blocker, 'utf8')).toBe('file, not directory')
  })

  test('rejects destinations overlapping existing worktrees', () => {
    const insideMain = path.join(repoDir, 'nested-worktree')
    expect(
      createWorktree({
        repositoryId: repoCommonDir,
        branch: 'spare',
        destination: insideMain,
      })
    ).toMatchObject({ ok: false, code: 'ERR_WORKTREE_INVALID_DESTINATION' })
    expect(fs.existsSync(insideMain)).toBe(false)

    // A destination that would CONTAIN the main worktree necessarily exists
    // already, so the stronger existence guard refuses it first.
    expect(
      createWorktree({
        repositoryId: repoCommonDir,
        branch: 'spare',
        destination: path.dirname(repoDir),
      })
    ).toMatchObject({ ok: false, code: 'ERR_WORKTREE_DESTINATION_EXISTS' })
  })

  test('rejects injection-like branch names and relative destinations', () => {
    // Option-like and malformed branch names never reach git.
    for (const branch of ['--force', '-b', 'bad..name', 'a b']) {
      const result = createWorktree({
        repositoryId: repoCommonDir,
        branch,
        destination: path.join(tempRoot, 'inject'),
      })
      expect(result.ok).toBe(false)
      expect(result).toMatchObject({ code: 'ERR_WORKTREE_INVALID_DESTINATION' })
      expect(fs.existsSync(path.join(tempRoot, 'inject'))).toBe(false)
    }

    // Shell metacharacters inside an otherwise-valid ref name are passed as
    // one literal argv element — git simply reports the unknown branch.
    const shellish = createWorktree({
      repositoryId: repoCommonDir,
      branch: 'evil;rm',
      destination: path.join(tempRoot, 'inject'),
    })
    expect(shellish).toMatchObject({ ok: false, code: 'ERR_WORKTREE_UNKNOWN_BRANCH' })
    expect(fs.existsSync(path.join(tempRoot, 'inject'))).toBe(false)

    // Relative destinations are refused outright.
    expect(
      createWorktree({
        repositoryId: repoCommonDir,
        branch: 'spare',
        destination: 'relative/dest',
      })
    ).toMatchObject({ ok: false, code: 'ERR_WORKTREE_INVALID_DESTINATION' })
  })

  test('creates literal destinations containing shell metacharacters verbatim', () => {
    // A legal-but-weird absolute path is created byte-for-byte — proof of
    // argument-array invocation (no shell interpretation).
    const weird = path.join(tempRoot, 'dest $(rm -rf /) `whoami`; echo hi')
    const result = createWorktree({
      repositoryId: repoCommonDir,
      branch: 'spare',
      destination: weird,
    })

    expect(result.ok).toBe(true)
    expect(fs.existsSync(path.join(weird, '.git'))).toBe(true)
  })
})
