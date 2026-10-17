// gitRemote (plan-execution D6/D13/D14) over a local bare `origin` and two
// clones: fast-forward push (a non-fast-forward push is rejected and the
// branch left as it was), ls-remote, fetch, worktree add and remove (never
// forced), ancestry, and merge-tree conflict prediction. The `main` clone
// stands in for the team's main checkout: its HEAD and index stay untouched
// by every operation.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cleanGitEnv } from '../git/gitCommand'
import { gitFetch, isAncestor, lsRemoteHead, mergeTree, pushToRemote, worktreeAdd, worktreeRemove } from '../plans/landing/gitRemote'

// Tests spawn git: cleanGitEnv keeps a hook's GIT_DIR from redirecting them.
function git(args: string[], cwd: string) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: cleanGitEnv() })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout
}
const commitAll = (cwd: string, message: string) => {
  git(['add', '-A'], cwd)
  git(['-c', 'user.email=t@e', '-c', 'user.name=T', 'commit', '-q', '-m', message], cwd)
}

let root: string
let origin: string
let main: string
let scratch: string
beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-git-remote-')))
  origin = path.join(root, 'origin.git')
  main = path.join(root, 'main')
  scratch = path.join(root, 'scratch')
  git(['init', '-q', '--bare', '-b', 'master', origin], root)
  git(['clone', '-q', origin, main], root)
  fs.writeFileSync(path.join(main, 'seed.txt'), 'seed\n')
  commitAll(main, 'seed')
  git(['push', '-q', 'origin', 'master'], main)
  git(['clone', '-q', origin, scratch], root)
})
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

describe('gitRemote', () => {
  test('ls-remote reads a ref head, and null for a missing one', async () => {
    const master = git(['rev-parse', 'master'], main).trim()
    await expect(lsRemoteHead(main, 'refs/heads/master')).resolves.toEqual({ ok: true, sha: master })
    await expect(lsRemoteHead(main, 'refs/heads/no-such')).resolves.toEqual({ ok: true, sha: null })
  })

  test('a fast-forward push lands the commit on origin', async () => {
    fs.writeFileSync(path.join(scratch, 'one.txt'), 'one\n')
    commitAll(scratch, 'one')
    const sha = git(['rev-parse', 'HEAD'], scratch).trim()
    git(['push', '-q', 'origin', 'HEAD:refs/heads/built-elsewhere'], scratch)
    await expect(gitFetch(main)).resolves.toEqual({ ok: true })
    const pushed = await pushToRemote(main, sha, 'feature')
    expect(pushed.ok).toBe(true)
    await expect(lsRemoteHead(main, 'refs/heads/feature')).resolves.toEqual({ ok: true, sha })
  })

  test('a non-fast-forward push is rejected and the branch is left as it was', async () => {
    // Two sibling commits built in `scratch`, both fetched into `main`.
    const siblings: string[] = []
    for (const name of ['sibling-a', 'sibling-b']) {
      git(['checkout', '-q', '-b', name, 'origin/master'], scratch)
      fs.writeFileSync(path.join(scratch, `${name}.txt`), `${name}\n`)
      commitAll(scratch, name)
      siblings.push(git(['rev-parse', 'HEAD'], scratch).trim())
    }
    git(['checkout', '-q', 'master'], scratch)
    git(['push', '-q', 'origin', `${siblings[0]}:refs/heads/moved`], scratch)
    await expect(gitFetch(main)).resolves.toEqual({ ok: true })
    // Pushing the sibling under the same branch is not a fast-forward.
    const rejected = await pushToRemote(main, siblings[1]!, 'moved')
    expect(rejected.ok).toBe(false)
    if (!rejected.ok) {
      expect(rejected.error.exitCode).not.toBe(0)
      expect(rejected.error.stderr).toMatch(/rejected|non-fast-forward/)
    }
    await expect(lsRemoteHead(main, 'refs/heads/moved')).resolves.toEqual({ ok: true, sha: siblings[0] })
  })

  test('fetch brings the remote objects in', async () => {
    fs.writeFileSync(path.join(scratch, 'four.txt'), 'four\n')
    commitAll(scratch, 'four')
    git(['push', '-q', 'origin', 'HEAD:refs/heads/elsewhere'], scratch)
    const remote = git(['rev-parse', 'HEAD'], scratch).trim()
    await expect(gitFetch(main)).resolves.toEqual({ ok: true })
    await expect(isAncestor(main, 'master', remote)).resolves.toEqual({ ok: true, ancestor: true })
  })

  test('worktree add creates a branch, remove takes it away, and neither is forced', async () => {
    const wt = path.join(root, 'wt-api')
    const added = await worktreeAdd({ repo: main, path: wt, branch: 'kawai/api', start: 'origin/master' })
    expect(added.ok).toBe(true)
    expect(fs.existsSync(path.join(wt, 'seed.txt'))).toBe(true)
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'], wt).trim()).toBe('kawai/api')
    // A second add at the same path refuses: no force flag ever.
    const again = await worktreeAdd({ repo: main, path: wt, branch: 'kawai/other', start: 'origin/master' })
    expect(again.ok).toBe(false)
    // A dirty worktree refuses removal: nothing a session wrote is discarded.
    fs.writeFileSync(path.join(wt, 'dirty.txt'), 'dirty\n')
    const dirty = await worktreeRemove(main, wt)
    expect(dirty.ok).toBe(false)
    fs.rmSync(path.join(wt, 'dirty.txt'))
    await expect(worktreeRemove(main, wt)).resolves.toEqual({ ok: true })
    expect(fs.existsSync(wt)).toBe(false)
  })

  test('ancestry and merge-tree: clean merges list no files, conflicts list them', async () => {
    git(['checkout', '-q', '-b', 'left'], scratch)
    fs.writeFileSync(path.join(scratch, 'left.txt'), 'left\n')
    commitAll(scratch, 'left')
    git(['checkout', '-q', '-b', 'right', 'master'], scratch)
    fs.writeFileSync(path.join(scratch, 'right.txt'), 'right\n')
    commitAll(scratch, 'right')
    git(['checkout', '-q', '-b', 'clash-left', 'master'], scratch)
    fs.writeFileSync(path.join(scratch, 'shared.txt'), 'left version\n')
    commitAll(scratch, 'clash-left')
    git(['checkout', '-q', '-b', 'clash-right', 'master'], scratch)
    fs.writeFileSync(path.join(scratch, 'shared.txt'), 'right version\n')
    commitAll(scratch, 'clash-right')
    git(['checkout', '-q', 'master'], scratch)

    const clean = await mergeTree(scratch, 'left', 'right')
    expect(clean.ok).toBe(true)
    if (clean.ok) {
      expect(clean.conflicts).toEqual([])
      expect(clean.tree).toMatch(/^[0-9a-f]{40}$/)
    }
    const clash = await mergeTree(scratch, 'clash-left', 'clash-right')
    expect(clash.ok).toBe(true)
    if (clash.ok) expect(clash.conflicts).toEqual(['shared.txt'])

    const master = git(['rev-parse', 'master'], scratch).trim()
    const left = git(['rev-parse', 'left'], scratch).trim()
    await expect(isAncestor(scratch, master, left)).resolves.toEqual({ ok: true, ancestor: true })
    await expect(isAncestor(scratch, left, master)).resolves.toEqual({ ok: true, ancestor: false })
  })

  test("the main checkout's HEAD and index are untouched by every operation", () => {
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'], main).trim()).toBe('master')
    expect(git(['status', '--porcelain'], main).trim()).toBe('')
  })
})
