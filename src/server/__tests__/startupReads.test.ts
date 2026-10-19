// Startup recovery's real reads (startupReads.ts) keep InspectorReads'
// contract over real git: an answer is a value (null
// only when absent), and a failed read rejects so the inspection is
// undecidable (integration-candidates review F2). Never reaches GitHub.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cleanGitEnv } from '../git/gitCommand'
import { inspectEffect } from '../plans/execution/effectInspectors'
import type { EffectRow } from '../plans/execution/executionRows'
import { startupReads } from '../plans/execution/startupReads'

let root: string
let origin: string
let clone: string
let head: string

const git = (args: string[], cwd: string) => {
  const result = Bun.spawnSync(['git', ...args], { cwd, env: cleanGitEnv(), stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr.toString()}`)
  return result.stdout.toString().trim()
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-startup-reads-'))
  origin = path.join(root, 'origin.git')
  clone = path.join(root, 'clone')
  git(['init', '-q', '--bare', '-b', 'master', origin], root)
  git(['clone', '-q', origin, clone], root)
  fs.writeFileSync(path.join(clone, 'a.txt'), 'a\n')
  git(['add', 'a.txt'], clone)
  git(['-c', 'user.email=t@e', '-c', 'user.name=T', 'commit', '-q', '-m', 'a'], clone)
  git(['push', '-q', 'origin', 'HEAD:refs/heads/master'], clone)
  head = git(['rev-parse', 'HEAD'], clone)
})
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

const reads = () => startupReads()
const effect = (kind: string, command: Record<string, unknown>): EffectRow => ({ id: 'e1', executionId: 'x', change: 'c', roundId: null, kind, effectKey: 'k', command, state: 'unknown', attempts: 0, outcome: null, error: null } as unknown as EffectRow)

test('remoteHead: a present ref is its head, an absent one null, and a failed ls-remote rejects', async () => {
  await expect(reads().remoteHead(clone, 'refs/heads/master')).resolves.toBe(head)
  await expect(reads().remoteHead(clone, 'refs/heads/missing')).resolves.toBeNull()
  git(['remote', 'set-url', 'origin', path.join(root, 'gone.git')], clone)
  try {
    await expect(reads().remoteHead(clone, 'refs/heads/master')).rejects.toThrow('ls-remote')
  } finally {
    git(['remote', 'set-url', 'origin', origin], clone)
  }
})

test('the push and fast-forward inspectors read a failed ls-remote as undecidable, never as absent', async () => {
  git(['remote', 'set-url', 'origin', path.join(root, 'gone.git')], clone)
  try {
    await expect(inspectEffect(effect('push', { cwd: clone, branch: 'master', commit: head }), reads())).resolves.toMatchObject({ found: 'undecidable' })
    await expect(inspectEffect(effect('fast-forward', { cwd: clone, branch: 'master', sha: head }), reads())).resolves.toMatchObject({ found: 'undecidable' })
    await expect(inspectEffect(effect('create-integration', { cwd: clone, branch: 'wave/int', sha: head }), reads())).resolves.toMatchObject({ found: 'undecidable' })
  } finally {
    git(['remote', 'set-url', 'origin', origin], clone)
  }
  // Reachable again: the push is found done, and a missing integration branch runs again.
  await expect(inspectEffect(effect('push', { cwd: clone, branch: 'master', commit: head }), reads())).resolves.toEqual({ found: 'done', outcome: { head } })
  await expect(inspectEffect(effect('create-integration', { cwd: clone, branch: 'wave/int', sha: head }), reads())).resolves.toEqual({ found: 'not-done' })
})

test('localBranch and worktree: absent answers null or not present; a repository that cannot be read rejects', async () => {
  await expect(reads().localBranch(clone, 'master')).resolves.toBe(head)
  await expect(reads().localBranch(clone, 'missing')).resolves.toBeNull()
  await expect(reads().worktree(clone, path.join(root, 'elsewhere'))).resolves.toEqual({ present: false, head: null })
  const notRepo = path.join(root, 'not-a-repo')
  fs.mkdirSync(notRepo, { recursive: true })
  await expect(reads().localBranch(notRepo, 'master')).rejects.toThrow()
  await expect(reads().worktree(notRepo, clone)).rejects.toThrow()
})
