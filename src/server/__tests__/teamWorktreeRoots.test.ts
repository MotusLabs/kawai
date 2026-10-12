import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cleanGitEnv } from '../git/gitCommand'
import { TeamWorktrees, worktreeRootOf } from '../team/worktreeRoots'

// cleanGitEnv: under the pre-commit hook git exports GIT_DIR/GIT_INDEX_FILE,
// and a raw spawn would run these commands against the hook's repository.
function git(args: string[], cwd?: string) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: cleanGitEnv() })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
}

describe('worktree roots', () => {
  let root: string
  let repo: string
  let feature: string
  let teamId: string
  let plain: string

  beforeAll(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-worktrees-')))
    repo = path.join(root, 'repo')
    feature = path.join(root, 'repo-feature')
    plain = path.join(root, 'plain')
    git(['init', '-q', repo])
    git(['-c', 'user.email=t@e', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'init'], repo)
    git(['worktree', 'add', '-q', '-b', 'feature', feature], repo)
    fs.mkdirSync(path.join(repo, 'src', 'deep'), { recursive: true })
    fs.mkdirSync(path.join(feature, 'src'), { recursive: true })
    fs.mkdirSync(plain)
    fs.symlinkSync(feature, path.join(root, 'feature-link'))
    teamId = path.join(repo, '.git')
  })
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

  test('a member resolves to its enclosing worktree root from any subdirectory', () => {
    expect(worktreeRootOf(repo)).toBe(repo)
    expect(worktreeRootOf(path.join(repo, 'src', 'deep'))).toBe(repo)
    expect(worktreeRootOf(feature)).toBe(feature)
    expect(worktreeRootOf(path.join(feature, 'src'))).toBe(feature)
  })

  test('symlinked paths resolve to the real root; a moved member follows its new path', () => {
    expect(worktreeRootOf(path.join(root, 'feature-link', 'src'))).toBe(feature)
    // The member's recorded path moved from the main checkout into the worktree.
    expect(worktreeRootOf(path.join(repo, 'src'))).not.toBe(worktreeRootOf(path.join(feature, 'src')))
  })

  test('a path in no repository resolves to its realpath', () => {
    expect(worktreeRootOf(plain)).toBe(plain)
  })

  test('main checkout and linked worktree targets normalize to the listed roots', async () => {
    const worktrees = new TeamWorktrees()
    expect(await worktrees.resolveTarget(teamId, repo)).toEqual({ ok: true, root: repo })
    expect(await worktrees.resolveTarget(teamId, `${feature}/`)).toEqual({ ok: true, root: feature })
    expect(await worktrees.resolveTarget(teamId, path.join(root, 'feature-link'))).toEqual({ ok: true, root: feature })
  })

  test('subdirectories, other directories, and plain-directory teams are refused by name', async () => {
    const worktrees = new TeamWorktrees()
    for (const target of [path.join(repo, 'src'), plain, '/nowhere/at/all']) {
      const result = await worktrees.resolveTarget(teamId, target)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toContain(target)
    }
    expect((await worktrees.resolveTarget(plain, plain)).ok).toBe(false)
  })

  test('a worktree added after the listing was cached is found on the miss refresh', async () => {
    const worktrees = new TeamWorktrees({ ttlMs: 60_000 })
    await worktrees.list(teamId)
    const late = path.join(root, 'repo-late')
    git(['worktree', 'add', '-q', '-b', 'late', late], repo)
    expect(await worktrees.resolveTarget(teamId, late)).toEqual({ ok: true, root: late })
    git(['worktree', 'remove', late], repo)
  })

  test('a removed worktree stops existing and stops validating', async () => {
    const worktrees = new TeamWorktrees({ ttlMs: 60_000 })
    const doomed = path.join(root, 'repo-doomed')
    git(['worktree', 'add', '-q', '-b', 'doomed', doomed], repo)
    expect(await worktrees.exists(teamId, doomed)).toBe(true)
    // Deleted without `git worktree remove`: git still lists it as prunable.
    fs.rmSync(doomed, { recursive: true, force: true })
    expect(await worktrees.exists(teamId, doomed)).toBe(false)
    expect((await worktrees.resolveTarget(teamId, doomed)).ok).toBe(false)
  })
})
