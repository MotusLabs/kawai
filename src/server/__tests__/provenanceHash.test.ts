// Agent-start provenance hashing (team-process-metrics D2): equal content
// hashes equal, the memory manifest tracks files individually, a worktree
// member resolves to the main checkout's memory directory, CLAUDE_CONFIG_DIR
// is honoured, and unreadable inputs are reported as unavailable.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cleanGitEnv } from '../git/gitCommand'
import { clearTeamCache, resolveTeam } from '../team/teamIdentity'
import { computeProvenance, memoryDirFor, memoryManifest, sanitizeProjectPath, sha256 } from '../metrics/provenanceHash'

let root: string
beforeAll(() => { root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-provenance-'))) })
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

const write = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

test('the memory path follows the observed CLI layout and honours CLAUDE_CONFIG_DIR', () => {
  expect(sanitizeProjectPath('/home/coder/kawai')).toBe('-home-coder-kawai')
  expect(sanitizeProjectPath('/home/coder/my_repo.v2')).toBe('-home-coder-my-repo-v2')
  expect(memoryDirFor('/home/coder/kawai', { HOME: '/home/coder' })).toBe('/home/coder/.claude/projects/-home-coder-kawai/memory')
  expect(memoryDirFor('/home/coder/kawai', { HOME: '/home/coder', CLAUDE_CONFIG_DIR: '/cfg/alt' })).toBe('/cfg/alt/projects/-home-coder-kawai/memory')
})

test('the manifest hashes each file; an added file changes the directory hash, a changed file only its own entry', () => {
  const dir = path.join(root, 'memory-a')
  write(path.join(dir, 'MEMORY.md'), '- index')
  write(path.join(dir, 'feedback-reviews.md'), 'v1')
  const first = memoryManifest(dir)!
  expect(Object.keys(first.files)).toEqual(['MEMORY.md', 'feedback-reviews.md'])
  expect(first.files['MEMORY.md']).toBe(sha256('- index'))
  expect(memoryManifest(dir)).toEqual(first)

  write(path.join(dir, 'nested', 'extra.md'), 'new')
  const added = memoryManifest(dir)!
  expect(added.hash).not.toBe(first.hash)
  expect(Object.keys(added.files)).toEqual(['MEMORY.md', 'feedback-reviews.md', 'nested/extra.md'])

  write(path.join(dir, 'feedback-reviews.md'), 'v2')
  const changed = memoryManifest(dir)!
  expect(changed.files['feedback-reviews.md']).not.toBe(added.files['feedback-reviews.md'])
  expect(changed.files['MEMORY.md']).toBe(added.files['MEMORY.md'])
  expect(changed.files['nested/extra.md']).toBe(added.files['nested/extra.md'])
  expect(memoryManifest(path.join(root, 'no-such-dir'))).toBeNull()
})

test('a worktree member resolves to the main checkout memory directory through its team', async () => {
  const repo = path.join(root, 'repo')
  const git = (args: string[], cwd: string) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: cleanGitEnv() })
    if (result.status !== 0) throw new Error(result.stderr)
  }
  fs.mkdirSync(repo)
  git(['init', '-q'], repo)
  git(['-c', 'user.email=t@e', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'init'], repo)
  const worktree = path.join(repo, '.worktrees', 'feature')
  git(['worktree', 'add', '-q', '-b', 'feature', worktree], repo)
  clearTeamCache()
  const main = await resolveTeam(repo)
  const member = await resolveTeam(worktree)
  const env = { HOME: root }
  expect(memoryDirFor(member.groupsRoot, env)).toBe(memoryDirFor(main.groupsRoot, env))
  expect(memoryDirFor(member.groupsRoot, env)).toBe(path.join(root, '.claude', 'projects', sanitizeProjectPath(repo), 'memory'))
})

test('computeProvenance: equal inputs hash equal; absent inputs read null; unreadable ones are unavailable', () => {
  const home = path.join(root, 'home-b')
  const main = '/work/repo'
  const worktreeRoot = path.join(root, 'wt-b')
  const groupFile = path.join(root, 'groups', 'reviewers.md')
  write(groupFile, '---\neffort: high\n---\nReview.')
  write(path.join(worktreeRoot, 'CLAUDE.md'), '# Rules')
  write(path.join(memoryDirFor(main, { HOME: home }), 'MEMORY.md'), 'm')
  const input = { groupFile, promptAppend: 'append', mainCheckout: main, worktreeRoot, env: { HOME: home } }
  const first = computeProvenance(input)
  expect(first).toEqual(computeProvenance(input))
  expect(first).toMatchObject({ groupFileHash: sha256('---\neffort: high\n---\nReview.'), promptAppendHash: sha256('append'), instructionsHash: sha256('# Rules'), unavailable: [] })
  expect(first.memory?.files).toEqual({ 'MEMORY.md': sha256('m') })

  write(groupFile, '---\neffort: low\n---\nReview.')
  expect(computeProvenance(input).groupFileHash).not.toBe(first.groupFileHash)

  const bare = computeProvenance({ ...input, groupFile: null, worktreeRoot: path.join(root, 'empty'), env: { HOME: path.join(root, 'nobody') } })
  expect(bare).toMatchObject({ groupFileHash: null, memory: null, instructionsHash: null, unavailable: [] })

  // A directory where a file is expected cannot be read as one.
  const odd = path.join(root, 'odd')
  fs.mkdirSync(path.join(odd, 'CLAUDE.md'), { recursive: true })
  const unreadable = computeProvenance({ ...input, groupFile: odd, worktreeRoot: odd })
  expect(unreadable).toMatchObject({ groupFileHash: null, instructionsHash: null, unavailable: ['group_file', 'instructions'] })
})
