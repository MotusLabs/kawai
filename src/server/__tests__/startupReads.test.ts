// Startup recovery's real reads (startupReads.ts) keep InspectorReads'
// contract over real git: an answer is a value (null
// only when absent), and a failed read rejects so the inspection is
// undecidable (integration-candidates review F2, L3). gh is a stub on a
// private PATH; never reaches GitHub.
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

test('worktree: a listed worktree whose HEAD cannot be read rejects instead of reading a null head (L3)', async () => {
  const wt = path.join(fs.realpathSync(root), 'wt-gone')
  git(['worktree', 'add', '-q', '-b', 'wt-gone', wt], clone)
  await expect(reads().worktree(clone, wt)).resolves.toEqual({ present: true, head })
  fs.rmSync(wt, { recursive: true, force: true })
  try {
    await expect(reads().worktree(clone, wt)).rejects.toThrow('could not be read')
    await expect(inspectEffect(effect('provision', { repo: clone, path: wt, branch: 'wt-gone' }), reads())).resolves.toMatchObject({ found: 'undecidable' })
  } finally {
    git(['worktree', 'prune'], clone)
  }
})

/** A stub gh on a private PATH: answers from a fixed script, or fails every call while `fail` is set. Never reaches GitHub. */
function stubGh(): { reads: ReturnType<typeof startupReads>; fail: (on: boolean) => void } {
  const bin = path.join(root, 'bin')
  const modeFile = path.join(root, 'gh-mode')
  fs.mkdirSync(bin, { recursive: true })
  fs.writeFileSync(path.join(bin, 'gh'), [
    '#!/bin/sh',
    'if [ "$(cat "$GH_STUB_MODE")" = fail ]; then echo "HTTP 502: Bad Gateway" >&2; exit 1; fi',
    'case "$1 $2" in',
    '  "pr list") echo \'[{"number":7,"url":"https://example.internal/pr/7","state":"OPEN","headRefOid":"h7"}]\' ;;',
    '  "pr view") echo \'{"number":7,"url":"https://example.internal/pr/7","state":"MERGED","headRefOid":"h7","mergeCommit":{"oid":"m7"}}\' ;;',
    '  "api repos/acme/app/actions/runs/11") echo \'{"attempt":2}\' ;;',
    '  *) echo "unexpected gh $*" >&2; exit 1 ;;',
    'esac',
  ].join('\n') + '\n', { mode: 0o755 })
  fs.writeFileSync(modeFile, 'ok')
  return {
    reads: startupReads({ env: { PATH: `${bin}:${process.env.PATH ?? ''}`, GH_STUB_MODE: modeFile } }),
    fail: on => fs.writeFileSync(modeFile, on ? 'fail' : 'ok'),
  }
}

test('prList: an answer lists the pull requests; a failed gh call rejects instead of reading none (L3)', async () => {
  const gh = stubGh()
  await expect(gh.reads.prList('acme/app', 'api', 'master')).resolves.toEqual([{ number: 7, url: 'https://example.internal/pr/7', state: 'OPEN', headRefOid: 'h7' }])
  gh.fail(true)
  await expect(gh.reads.prList('acme/app', 'api', 'master')).rejects.toThrow('could not be listed')
  await expect(inspectEffect(effect('open-pr', { repo: 'acme/app', head: 'api', base: 'master' }), gh.reads)).resolves.toMatchObject({ found: 'undecidable' })
})

test('prView: an answer is the pull request; a failed gh call rejects instead of reading an open one (L3)', async () => {
  const gh = stubGh()
  await expect(gh.reads.prView('acme/app', 7)).resolves.toMatchObject({ state: 'MERGED', mergeCommit: 'm7' })
  gh.fail(true)
  await expect(gh.reads.prView('acme/app', 7)).rejects.toThrow('could not be read')
  await expect(inspectEffect(effect('merge', { repo: 'acme/app', pr: 7 }), gh.reads)).resolves.toMatchObject({ found: 'undecidable' })
})

test('runAttempt: an answer is the attempt; a failed gh call rejects instead of reading attempt 1 (L3)', async () => {
  const gh = stubGh()
  await expect(gh.reads.runAttempt('acme/app', 11)).resolves.toBe(2)
  gh.fail(true)
  await expect(gh.reads.runAttempt('acme/app', 11)).rejects.toThrow('could not be read')
  await expect(inspectEffect(effect('rerun', { repo: 'acme/app', runIds: [11] }), gh.reads)).resolves.toMatchObject({ found: 'undecidable' })
})
