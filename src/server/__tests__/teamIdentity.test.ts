import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cleanGitEnv } from '../git/gitCommand'
import { clearTeamCache, resolveTeam } from '../team/teamIdentity'

// cleanGitEnv: under the pre-commit hook git exports GIT_DIR/GIT_INDEX_FILE,
// and a raw spawn would run these commands against the hook's repository.
function git(args: string[], cwd?: string) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: cleanGitEnv() })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
}

describe('resolveTeam', () => {
  let root: string
  let repo: string
  let worktree: string
  let other: string
  let plain: string

  beforeAll(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-team-')))
    repo = path.join(root, 'repo')
    worktree = path.join(root, 'repo-feature')
    other = path.join(root, 'other')
    plain = path.join(root, 'plain')
    for (const dir of [repo, other]) {
      git(['init', '-q', dir])
      git(['-c', 'user.email=t@e', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'init'], dir)
    }
    git(['worktree', 'add', '-q', '-b', 'feature', worktree], repo)
    fs.mkdirSync(path.join(repo, 'src'))
    fs.mkdirSync(plain)
  })
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }))
  beforeEach(() => clearTeamCache())

  test('the main checkout, a subdirectory, and a linked worktree share one team', async () => {
    const main = await resolveTeam(repo)
    expect(main).toEqual({ teamId: path.join(repo, '.git'), groupsRoot: repo })
    expect(await resolveTeam(path.join(repo, 'src'))).toEqual(main)
    // Groups resolve from the main working tree, not the worktree.
    expect(await resolveTeam(worktree)).toEqual(main)
  })

  test('different repositories are different teams', async () => {
    expect((await resolveTeam(other)).teamId).not.toBe((await resolveTeam(repo)).teamId)
  })

  test('a directory outside any repository is a team of its own', async () => {
    expect(await resolveTeam(plain)).toEqual({ teamId: plain, groupsRoot: plain })
  })

  test('a bare repository reads groups from the worktree itself', async () => {
    const bare = path.join(root, 'bare.git')
    const linked = path.join(root, 'bare-wt')
    git(['clone', '-q', '--bare', repo, bare])
    git(['worktree', 'add', '-q', linked, 'feature'], bare)
    expect(await resolveTeam(linked)).toEqual({ teamId: bare, groupsRoot: linked })
  })

  test('repository answers are cached; plain directories are re-checked', async () => {
    const first = await resolveTeam(repo)
    expect(await resolveTeam(repo)).toBe(first)
    expect(await resolveTeam(plain)).not.toBe(await resolveTeam(plain))
  })
})
