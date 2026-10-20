// §5.3 (codex-chat-sessions D5): the one Codex sandbox — workspace-write, the
// repository's git common directory as the absolute extra writable root
// (from a main checkout, a subdirectory, or a linked worktree; none outside
// a repository), and network access following the profile.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { codexSandbox, gitCommonDir } from '../chat/codex/codexSandbox'
import { cleanGitEnv } from '../git/gitCommand'

let dir: string
let repo: string
let worktree: string

const git = (cwd: string, ...args: string[]) => {
  const result = Bun.spawnSync(['git', ...args], { cwd, env: { ...cleanGitEnv(), GIT_CONFIG_NOSYSTEM: '1' } })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr.toString()}`)
}

beforeAll(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-codex-sandbox-')))
  repo = path.join(dir, 'repo')
  worktree = path.join(dir, 'wt')
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true })
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'init')
  git(repo, 'worktree', 'add', '-q', worktree, '-b', 'feature')
})

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

test('a main checkout and its subdirectory resolve the absolute .git directory', async () => {
  expect(await gitCommonDir(repo)).toBe(path.join(repo, '.git'))
  expect(await gitCommonDir(path.join(repo, 'src'))).toBe(path.join(repo, '.git'))
})

test("a linked worktree resolves the main checkout's .git, not its own gitdir file", async () => {
  expect(await gitCommonDir(worktree)).toBe(path.join(repo, '.git'))
})

test('outside a repository there is no common directory and no writable-roots override', async () => {
  const plain = path.join(dir, 'plain')
  fs.mkdirSync(plain)
  expect(await gitCommonDir(plain)).toBeNull()
  expect(codexSandbox({ network: true, commonDir: null })).toEqual({
    sandbox: 'workspace-write',
    config: { 'sandbox_workspace_write.network_access': true },
  })
})

test('the sandbox is workspace-write with the common dir writable; network follows the profile', () => {
  const commonDir = path.join(repo, '.git')
  expect(codexSandbox({ network: true, commonDir })).toEqual({
    sandbox: 'workspace-write',
    config: { 'sandbox_workspace_write.writable_roots': [commonDir], 'sandbox_workspace_write.network_access': true },
  })
  expect(codexSandbox({ network: false, commonDir }).config['sandbox_workspace_write.network_access']).toBe(false)
})
