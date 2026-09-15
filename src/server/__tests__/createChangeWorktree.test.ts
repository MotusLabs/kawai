// createChangeWorktree.test.ts - Task 7.2/7.3 coverage: real-git integration
// tests for the seeded change-worktree operation — success from HEAD and from
// an existing branch, existing destinations, concurrently assigned branches
// (the race window), missing artifacts with cleanup, command failure, invalid
// repositories, injection-like change names, and proof that the main
// worktree's checkout and index are never touched. No force flags,
// argument-array invocation only.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runGit } from '../git/gitCommand'
import { createChangeWorktree } from '../git/createChangeWorktree'
import { discoverRepository } from '../git/worktreeList'

const COMMIT_ENV = {
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
}

interface RepoFixture {
  /** Repository id (canonical common Git directory). */
  commonDir: string
  /** Canonical main worktree root. */
  main: string
  git: (args: string[]) => ReturnType<typeof runGit>
}

let tempRoot: string

/** Fresh repository per test — no ordering coupling between scenarios. */
function makeRepo(
  options: {
    change?: string
    existingBranch?: string
    committedGitignore?: string
  } = {}
): RepoFixture {
  const name = `repo-${Math.random().toString(36).slice(2, 10)}`
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(tempRoot, `${name}-`)))
  runGit(['init', '--initial-branch=main', dir], { timeoutMs: 10_000 })
  const git = (args: string[]) => runGit(['-C', dir, ...args], { timeoutMs: 10_000, env: COMMIT_ENV })
  fs.writeFileSync(path.join(dir, 'README.md'), '# test\n')
  git(['add', '--', 'README.md'])
  git(['commit', '-m', 'init'])
  if (options.committedGitignore !== undefined) {
    fs.writeFileSync(path.join(dir, '.gitignore'), options.committedGitignore)
    git(['add', '--', '.gitignore'])
    git(['commit', '-m', 'gitignore'])
  }
  if (options.existingBranch) {
    git(['branch', options.existingBranch])
  }
  if (options.change) {
    const changeDir = path.join(dir, 'openspec', 'changes', options.change)
    fs.mkdirSync(changeDir, { recursive: true })
    fs.writeFileSync(path.join(changeDir, 'proposal.md'), '## Why\n\nTest change.\n')
    fs.writeFileSync(path.join(changeDir, 'tasks.md'), '## 1. Group\n\n- [ ] 1.1 Do it\n')
  }
  return { commonDir: `${dir}/.git`, main: dir, git }
}

function worktreesDir(repo: RepoFixture): string {
  return path.join(repo.main, '.worktrees')
}

beforeAll(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-create-change-'))
})

afterAll(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true })
})

describe('createChangeWorktree operation', () => {
  test('creates, seeds, and commits a new branch from HEAD; main stays untouched', () => {
    const repo = makeRepo({ change: 'add-auth' })
    const porcelainBefore = repo.git(['status', '--porcelain']).stdout.trim().split('\n').sort()
    expect(porcelainBefore).toEqual(['?? openspec/'])

    const result = createChangeWorktree(
      { repositoryId: repo.commonDir, change: 'add-auth' },
      { env: COMMIT_ENV }
    )

    const destination = fs.realpathSync(path.join(worktreesDir(repo), 'add-auth'))
    expect(result).toEqual({
      operation: 'create-change-worktree',
      ok: true,
      repositoryId: repo.commonDir,
      change: 'add-auth',
      branch: 'add-auth',
      path: destination,
      commit: runGit(['-C', destination, 'rev-parse', 'HEAD']).stdout.trim(),
      gitignoreUpdated: true,
    })

    // The worktree exists on the new branch with a clean tree — the artifacts
    // are committed, not left untracked.
    expect(repo.git(['-C', destination, 'branch', '--show-current']).stdout.trim()).toBe('add-auth')
    expect(repo.git(['-C', destination, 'status', '--porcelain']).stdout).toBe('')
    expect(
      fs.existsSync(path.join(destination, 'openspec', 'changes', 'add-auth', 'proposal.md'))
    ).toBe(true)
    // The seed commit touches exactly the copied artifacts and .gitignore.
    const files = repo.git(['-C', destination, 'show', '--name-only', '--pretty=format:']).stdout
    expect(files).toContain('openspec/changes/add-auth/proposal.md')
    expect(files).toContain('openspec/changes/add-auth/tasks.md')
    expect(files).toContain('.gitignore')
    expect(fs.readFileSync(path.join(destination, '.gitignore'), 'utf8')).toContain('.worktrees/')

    // The main worktree's checkout and index are untouched: nothing staged,
    // no file modified — only the new untracked .worktrees/ directory (which
    // the ignore entry in the new branch will cover once merged).
    const porcelainAfter = repo.git(['status', '--porcelain']).stdout.trim().split('\n').sort()
    expect(porcelainAfter).toEqual(['?? .worktrees/', '?? openspec/'])
  })

  test('seeds the commit with a fallback identity when git has none configured', () => {
    // Hide any global/system git identity the host happens to have — a bare
    // CI runner is exactly this state, and `git commit` refuses without it.
    // Git also exports GIT_AUTHOR_*/GIT_COMMITTER_* to hooks, and env vars
    // outrank `-c`; scrub them so this test means the same thing whether it
    // runs standalone or under the repo's pre-commit hook.
    const noIdentityEnv = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }
    const authorEnvKeys = [
      'GIT_AUTHOR_NAME',
      'GIT_AUTHOR_EMAIL',
      'GIT_COMMITTER_NAME',
      'GIT_COMMITTER_EMAIL',
    ]
    const savedAuthorEnv = authorEnvKeys.map((key) => [key, process.env[key]] as const)
    for (const key of authorEnvKeys) delete process.env[key]
    try {
      const repo = makeRepo({ change: 'add-auth' })

      const result = createChangeWorktree(
        { repositoryId: repo.commonDir, change: 'add-auth' },
        { env: noIdentityEnv }
      )

      expect(result.ok).toBe(true)
      if (!result.ok || result.operation !== 'create-change-worktree') throw new Error('unreachable')
      const destination = fs.realpathSync(path.join(worktreesDir(repo), 'add-auth'))
      const author = runGit(['-C', destination, 'log', '-1', '--pretty=%an <%ae>'], {
        env: noIdentityEnv,
      }).stdout.trim()
      expect(author).toBe('Kawai <kawai@localhost>')
    } finally {
      for (const [key, value] of savedAuthorEnv) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })

  test('prefers a configured identity over the seed fallback', () => {
    const repo = makeRepo({ change: 'add-auth' })
    const noGlobalConfig = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }

    const result = createChangeWorktree(
      { repositoryId: repo.commonDir, change: 'add-auth' },
      { env: { ...noGlobalConfig, ...COMMIT_ENV } }
    )

    expect(result.ok).toBe(true)
    if (!result.ok || result.operation !== 'create-change-worktree') throw new Error('unreachable')
    const destination = fs.realpathSync(path.join(worktreesDir(repo), 'add-auth'))
    const author = runGit(['-C', destination, 'log', '-1', '--pretty=%an <%ae>'], {
      env: noGlobalConfig,
    }).stdout.trim()
    expect(author).toBe('test <test@example.com>')
  })

  test('checks out an existing unassigned branch and commits onto it', () => {
    const repo = makeRepo({ change: 'add-auth', existingBranch: 'add-auth' })
    const branchTipBefore = repo.git(['rev-parse', 'add-auth']).stdout.trim()

    const result = createChangeWorktree(
      { repositoryId: repo.commonDir, change: 'add-auth' },
      { env: COMMIT_ENV }
    )

    expect(result.ok).toBe(true)
    if (!result.ok || result.operation !== 'create-change-worktree') throw new Error('unreachable')
    const destination = fs.realpathSync(path.join(worktreesDir(repo), 'add-auth'))
    expect(repo.git(['-C', destination, 'branch', '--show-current']).stdout.trim()).toBe('add-auth')
    // The seed commit advanced the pre-existing branch.
    expect(result.commit).not.toBe(branchTipBefore)
    expect(repo.git(['rev-parse', 'add-auth']).stdout.trim()).toBe(result.commit)
  })

  test('leaves an existing .gitignore entry alone and reports it', () => {
    const repo = makeRepo({ change: 'add-auth', committedGitignore: 'node_modules/\n.worktrees/\n' })

    const result = createChangeWorktree(
      { repositoryId: repo.commonDir, change: 'add-auth' },
      { env: COMMIT_ENV }
    )

    expect(result).toMatchObject({ ok: true, gitignoreUpdated: false })
    const destination = fs.realpathSync(path.join(worktreesDir(repo), 'add-auth'))
    expect(fs.readFileSync(path.join(destination, '.gitignore'), 'utf8')).toBe(
      'node_modules/\n.worktrees/\n'
    )
  })

  test('rejects an existing destination without modifying it', () => {
    const repo = makeRepo({ change: 'add-auth' })
    const destination = path.join(worktreesDir(repo), 'add-auth')
    fs.mkdirSync(destination, { recursive: true })
    fs.writeFileSync(path.join(destination, 'marker.txt'), 'keep')

    const result = createChangeWorktree(
      { repositoryId: repo.commonDir, change: 'add-auth' },
      { env: COMMIT_ENV }
    )

    expect(result).toMatchObject({ ok: false, code: 'ERR_WORKTREE_DESTINATION_EXISTS' })
    expect(result).toMatchObject({ error: expect.stringContaining(destination) })
    expect(fs.readFileSync(path.join(destination, 'marker.txt'), 'utf8')).toBe('keep')
  })

  test('rejects a branch already assigned in another worktree (race window)', () => {
    const repo = makeRepo({ change: 'add-auth', existingBranch: 'add-auth' })
    const holder = path.join(tempRoot, `holder-${Math.random().toString(36).slice(2, 8)}`)
    repo.git(['worktree', 'add', holder, 'add-auth'])

    const result = createChangeWorktree(
      { repositoryId: repo.commonDir, change: 'add-auth' },
      { env: COMMIT_ENV }
    )

    expect(result).toMatchObject({ ok: false, code: 'ERR_WORKTREE_BRANCH_ASSIGNED' })
    // Actionable: the error names where the branch is checked out.
    expect(result).toMatchObject({ error: expect.stringContaining(fs.realpathSync(holder)) })
    expect(fs.existsSync(path.join(worktreesDir(repo), 'add-auth'))).toBe(false)
  })

  test('missing artifacts fail cleanly and clean the fresh worktree up', () => {
    const repo = makeRepo({ change: 'add-auth' })

    const result = createChangeWorktree(
      { repositoryId: repo.commonDir, change: 'no-such-change' },
      { env: COMMIT_ENV }
    )

    expect(result).toMatchObject({ ok: false, code: 'ERR_CHANGE_MISSING_ARTIFACTS' })
    expect(result).toMatchObject({
      error: expect.stringContaining(path.join(repo.main, 'openspec', 'changes', 'no-such-change')),
    })
    // The half-seeded worktree is removed again (non-forced remove works:
    // nothing was written into it).
    expect(fs.existsSync(path.join(worktreesDir(repo), 'no-such-change'))).toBe(false)
    // The `-b` branch is deliberately left behind — branch deletion is out
    // of scope — and a retry reuses it via the existing-branch path.
    expect(repo.git(['branch', '--list', 'no-such-change']).stdout.trim()).toBe('no-such-change')
  })

  test('surfaces command failure when the worktrees dir is blocked by a file', () => {
    const repo = makeRepo({ change: 'add-auth' })
    fs.writeFileSync(worktreesDir(repo), 'file, not directory')

    const result = createChangeWorktree(
      { repositoryId: repo.commonDir, change: 'add-auth' },
      { env: COMMIT_ENV }
    )

    expect(result).toMatchObject({ ok: false, code: 'ERR_WORKTREE_CREATE_FAILED' })
    expect(result).toMatchObject({ error: expect.stringContaining(worktreesDir(repo)) })
    expect(fs.readFileSync(worktreesDir(repo), 'utf8')).toBe('file, not directory')
  })

  test('rejects invalid repositories', () => {
    const notARepo = fs.realpathSync(fs.mkdtempSync(path.join(tempRoot, 'not-a-repo-')))

    const result = createChangeWorktree(
      { repositoryId: `${notARepo}/.git`, change: 'add-auth' },
      { env: COMMIT_ENV }
    )

    expect(result).toMatchObject({ ok: false, code: 'ERR_WORKSPACE_UNKNOWN_REPOSITORY' })
  })

  test('rejects injection-like change names before touching git', () => {
    const repo = makeRepo({ change: 'add-auth' })
    for (const change of ['--force', '-b', 'a/b', '..', '.', 'a b', 'bad..name', 'evil\nname']) {
      const result = createChangeWorktree(
        { repositoryId: repo.commonDir, change },
        { env: COMMIT_ENV }
      )
      expect(result.ok).toBe(false)
      expect(result).toMatchObject({ code: 'ERR_CHANGE_INVALID_NAME' })
    }
    expect(fs.existsSync(worktreesDir(repo))).toBe(false)
    expect(repo.git(['for-each-ref', '--format=%(refname:short)', 'refs/heads']).stdout.trim())
      .toBe('main')
  })

  test('creates literal names containing shell metacharacters verbatim', () => {
    // A legal single-segment ref with shell metacharacters proves
    // argument-array invocation: the name reaches git and the filesystem
    // byte-for-byte, with no shell interpretation.
    const repo = makeRepo({ change: 'evil;rm' })

    const result = createChangeWorktree(
      { repositoryId: repo.commonDir, change: 'evil;rm' },
      { env: COMMIT_ENV }
    )

    expect(result.ok).toBe(true)
    const destination = fs.realpathSync(path.join(worktreesDir(repo), 'evil;rm'))
    expect(result).toMatchObject({ path: destination })
    expect(repo.git(['-C', destination, 'branch', '--show-current']).stdout.trim()).toBe('evil;rm')
  })

  test('the created worktree is discoverable as the convention worktree', () => {
    const repo = makeRepo({ change: 'add-auth' })

    const result = createChangeWorktree(
      { repositoryId: repo.commonDir, change: 'add-auth' },
      { env: COMMIT_ENV }
    )
    expect(result.ok).toBe(true)

    const info = discoverRepository(repo.commonDir)
    const destination = fs.realpathSync(path.join(worktreesDir(repo), 'add-auth'))
    const created = info?.worktrees.find((worktree) => worktree.path === destination)
    expect(created).toMatchObject({ branch: 'add-auth', detached: false })
  })
})
