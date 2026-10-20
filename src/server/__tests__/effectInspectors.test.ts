// Startup recovery and the per-kind inspections (plan-execution D14's
// table, §10.2): a `running` effect becomes `unknown` at startup and is
// inspected before anything else for its change runs. One test per kind
// for found done and not done, undecidable reads retried under the backoff
// and then settling as effect-unknown, and a merge that completed before
// the restart.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Database } from 'bun:sqlite'
import { schemaDb } from './schemaDb'
import { ExecutionStore } from '../plans/execution/executionStore'
import type { EffectRow } from '../plans/execution/executionRows'
import { inspectEffect, inspectUnknownEffects, type InspectionVerdict, type InspectorReads } from '../plans/execution/effectInspectors'

const FLOOR = { lint: ['ci'], typecheck: ['ci'], 'unit-tests': ['ci'], 'ci-e2e': ['e2e'] }

let dir: string
let db: Database
let store: ExecutionStore
let executionId: string
let clock: number
const CLOCK0 = Date.parse('2026-10-17T10:00:00.000Z')

/** Reads scripted per test; anything undefined rejects like a failed adapter call. */
let reads: Record<string, unknown>

beforeEach(() => {
  clock = CLOCK0
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-inspect-'))
  db = schemaDb(path.join(dir, 'exec.db'))
  store = new ExecutionStore(db, () => new Date(clock))
  executionId = store.insertExecution({
    teamId: 'team', planId: 'plan-1', revision: 1, contentHash: 'h', reportId: 'r', inputHash: 'i',
    landingMode: 'direct', baseBranch: 'master', baseCommit: 'abc', floor: { version: 1, map: FLOOR },
    maxParallel: 3, mergeMethod: 'merge', changes: [{ change: 'api', landed: false }],
  }).id
  reads = {}
})
afterEach(() => {
  db.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

const adapters = (): InspectorReads => ({
  worktree: async (repo, wt) => {
    const result = (reads.worktree as Record<string, { present: boolean; head: string | null }> | undefined)?.[wt]
    if (result === undefined) throw new Error('worktree list failed')
    return result
  },
  localBranch: async (repo, branch) => {
    const result = (reads.localBranch as Record<string, string | null> | undefined)?.[branch]
    if (result === undefined && !(reads.localBranch as Record<string, unknown>)) throw new Error('rev-parse failed')
    return result ?? null
  },
  remoteHead: async (cwd, ref) => {
    const result = (reads.remoteHead as Record<string, string | null> | undefined)?.[ref]
    if (result === undefined && !(reads.remoteHead as Record<string, unknown>)) throw new Error('ls-remote failed')
    return result ?? null
  },
  prList: async (repo, head) => {
    const result = (reads.prList as Record<string, Array<{ number: number; url: string; state: string; headRefOid: string }> | undefined>)?.[head]
    if (result === undefined) throw new Error('pr list failed')
    return result
  },
  prView: async (repo, pr) => {
    const result = (reads.prView as Record<string, { number: number; url: string; state: string; headRefOid: string; mergeCommit: string | null }> | undefined)?.[String(pr)]
    if (result === undefined) throw new Error('pr view failed')
    return result
  },
  contains: async (_cwd, _ref, ancestor, descendant) => {
    const result = (reads.contains as Record<string, boolean> | undefined)?.[`${ancestor}..${descendant}`]
    if (result === undefined) throw new Error('ancestry read failed')
    return result
  },
  runAttempt: async (repo, runId) => {
    const result = (reads.runAttempt as Record<string, number> | undefined)?.[String(runId)]
    if (result === undefined) throw new Error('run view failed')
    return result
  },
})

const effectOf = (kind: string, command: Record<string, unknown>, roundId: string | null = null): EffectRow =>
  store.insertEffect({ executionId, change: 'api', roundId, kind: kind as EffectRow['kind'], effectKey: `exec:1:api:${kind}:${roundId ?? 1}:0`, command })

// An optional round id gives a scenario its own identity (A1): same kind,
// different command, is a new effect, not a re-issue of the last one.
const inspect = async (kind: string, command: Record<string, unknown>, roundId: string | null = null): Promise<InspectionVerdict> =>
  inspectEffect(effectOf(kind, command, roundId), adapters())

describe('the per-kind inspections (D14 table)', () => {
  test('provision: a worktree or branch that exists records its head; neither does runs again', async () => {
    reads.worktree = { '/repo/.worktrees/api': { present: true, head: 'head-1' } }
    await expect(inspect('provision', { repo: '/repo', path: '/repo/.worktrees/api', branch: 'api' })).resolves.toEqual({ found: 'done', outcome: { head: 'head-1' } })
    reads.worktree = { '/repo/.worktrees/api': { present: false, head: null } }
    reads.localBranch = { api: 'branch-head' }
    await expect(inspect('provision', { repo: '/repo', path: '/repo/.worktrees/api', branch: 'api' })).resolves.toEqual({ found: 'done', outcome: { head: 'branch-head' } })
    reads.localBranch = { api: null }
    await expect(inspect('provision', { repo: '/repo', path: '/repo/.worktrees/api', branch: 'api' })).resolves.toEqual({ found: 'not-done' })
  })

  test('push: origin containing the commit is done; a head without it runs again', async () => {
    reads.remoteHead = { 'refs/heads/api': 'abc123' }
    await expect(inspect('push', { cwd: '/repo/.worktrees/api', commit: 'abc123', branch: 'api' })).resolves.toEqual({ found: 'done', outcome: { head: 'abc123' } })
    reads.remoteHead = { 'refs/heads/api': 'other999' }
    await expect(inspect('push', { cwd: '/repo/.worktrees/api', commit: 'abc123', branch: 'api' })).resolves.toMatchObject({ found: 'not-done' })
    reads.remoteHead = { 'refs/heads/api': null }
    await expect(inspect('push', { cwd: '/repo/.worktrees/api', commit: 'abc123', branch: 'api' })).resolves.toEqual({ found: 'not-done' })
  })

  test('open-pr: the open PR is recorded; a closed one stops as pr-closed; none runs again', async () => {
    reads.prList = { api: [{ number: 7, url: 'https://example.internal/pr/7', state: 'OPEN', headRefOid: 'h7' }] }
    await expect(inspect('open-pr', { repo: 'acme/app', head: 'api', base: 'master' })).resolves.toEqual({
      found: 'done', outcome: { number: 7, url: 'https://example.internal/pr/7', head: 'h7' },
    })
    reads.prList = { api: [{ number: 7, url: 'https://example.internal/pr/7', state: 'CLOSED', headRefOid: 'h7' }] }
    await expect(inspect('open-pr', { repo: 'acme/app', head: 'api', base: 'master' })).resolves.toMatchObject({ found: 'stop', reason: 'pr-closed' })
    reads.prList = { api: [] }
    await expect(inspect('open-pr', { repo: 'acme/app', head: 'api', base: 'master' })).resolves.toEqual({ found: 'not-done' })
  })

  test('rerun: every run above attempt 1 is done with the adapter\'s { at, runIds }; any run at attempt 1 runs again', async () => {
    // The adapter's command carries `runIds` (review L3: the inspector once read a `runId` it never got).
    // Each scenario is its own round (A1): same kind, different command, is another identity.
    reads.runAttempt = { '11': 2, '12': 3 }
    await expect(inspect('rerun', { repo: 'acme/app', runIds: [11, 12] }, 'r1')).resolves.toEqual({ found: 'done', outcome: { at: new Date(CLOCK0).toISOString(), runIds: [11, 12] } })
    reads.runAttempt = { '11': 2, '12': 1 }
    await expect(inspect('rerun', { repo: 'acme/app', runIds: [11, 12] }, 'r2')).resolves.toEqual({ found: 'not-done' })
    reads.runAttempt = {}
    await expect(inspect('rerun', { repo: 'acme/app', runIds: [11] }, 'r3')).resolves.toMatchObject({ found: 'undecidable' })
  })

  test('update-branch: a moved head is done; an unmoved head is not-done and runs again (row 12)', async () => {
    reads.prView = { '7': { number: 7, url: 'u', state: 'OPEN', headRefOid: 'new-head', mergeCommit: null } }
    await expect(inspect('update-branch', { repo: 'acme/app', pr: 7, head: 'old-head' })).resolves.toEqual({
      found: 'done', outcome: { requested: true, head: expect.any(String), newHead: 'new-head', moved: true, state: 'OPEN' },
    })
    reads.prView = { '7': { number: 7, url: 'u', state: 'OPEN', headRefOid: 'old-head', mergeCommit: null } }
    await expect(inspect('update-branch', { repo: 'acme/app', pr: 7, head: 'old-head' })).resolves.toEqual({ found: 'not-done' })
  })

  test('merge: a merge completed before the restart records the merge commit; open runs again; closed stops', async () => {
    reads.prView = { '7': { number: 7, url: 'u', state: 'MERGED', headRefOid: 'h7', mergeCommit: 'm1' } }
    await expect(inspect('merge', { repo: 'acme/app', pr: 7, head: 'h7' })).resolves.toEqual({
      found: 'done', outcome: { merged: true, mergeCommit: 'm1', head: 'h7' },
    })
    reads.prView = { '7': { number: 7, url: 'u', state: 'OPEN', headRefOid: 'h7', mergeCommit: null } }
    await expect(inspect('merge', { repo: 'acme/app', pr: 7, head: 'h7' })).resolves.toEqual({ found: 'not-done' })
    reads.prView = { '7': { number: 7, url: 'u', state: 'CLOSED', headRefOid: 'h7', mergeCommit: null } }
    await expect(inspect('merge', { repo: 'acme/app', pr: 7, head: 'h7' })).resolves.toMatchObject({ found: 'stop', reason: 'pr-closed' })
  })

  test('remove-worktree: gone is done, present runs again; an unknown kind is undecidable', async () => {
    reads.worktree = { '/repo/.worktrees/api': { present: false, head: null } }
    await expect(inspect('remove-worktree', { repo: '/repo', path: '/repo/.worktrees/api' })).resolves.toEqual({ found: 'done', outcome: null })
    reads.worktree = { '/repo/.worktrees/api': { present: true, head: 'h' } }
    await expect(inspect('remove-worktree', { repo: '/repo', path: '/repo/.worktrees/api' })).resolves.toEqual({ found: 'not-done' })
    await expect(inspect('future-kind', {})).resolves.toMatchObject({ found: 'undecidable' })
  })

  test('create-integration: a ref at the requested commit is done; missing runs again; elsewhere stops as a foreign branch (integration-candidates D6)', async () => {
    const command = { cwd: '/repo', repo: 'acme/app', branch: 'wave/int', sha: 'def1' }
    reads.remoteHead = { 'refs/heads/wave/int': 'def1' }
    await expect(inspect('create-integration', command)).resolves.toEqual({ found: 'done', outcome: { created: true, sha: 'def1' } })
    reads.remoteHead = { 'refs/heads/wave/int': null }
    await expect(inspect('create-integration', command)).resolves.toEqual({ found: 'not-done' })
    reads.remoteHead = { 'refs/heads/wave/int': 'foreign9' }
    const foreign = await inspect('create-integration', command)
    expect(foreign).toMatchObject({ found: 'stop', reason: 'effect-failed', detail: { names: ['wave/int'] } })
    expect(foreign.found === 'stop' && foreign.detail.message).toContain('foreign-branch')
  })

  test('fast-forward: R contains C is done; C contains R runs again; otherwise refused with R (integration-candidates D6)', async () => {
    const command = { cwd: '/repo', repo: 'acme/app', branch: 'wave/int', sha: 'c1', base: 'r0' }
    reads.remoteHead = { 'refs/heads/wave/int': 'c1' }
    reads.contains = { 'c1..c1': true }
    await expect(inspect('fast-forward', command)).resolves.toEqual({ found: 'done', outcome: { fastForwarded: true, head: 'c1' } })
    reads.remoteHead = { 'refs/heads/wave/int': 'r0' }
    reads.contains = { 'c1..r0': false, 'r0..c1': true }
    await expect(inspect('fast-forward', command)).resolves.toEqual({ found: 'not-done' })
    reads.remoteHead = { 'refs/heads/wave/int': 'moved' }
    reads.contains = { 'c1..moved': false, 'moved..c1': false }
    await expect(inspect('fast-forward', command)).resolves.toEqual({ found: 'done', outcome: { fastForwarded: false, refused: true, head: 'moved' } })
    reads.remoteHead = { 'refs/heads/wave/int': null }
    await expect(inspect('fast-forward', command)).resolves.toEqual({ found: 'done', outcome: { fastForwarded: false, refused: true, head: null } })
    // A failed ancestry read is undecidable, never a guess.
    reads.remoteHead = { 'refs/heads/wave/int': 'moved' }
    reads.contains = {}
    await expect(inspect('fast-forward', command)).resolves.toMatchObject({ found: 'undecidable' })
  })
})

describe('startup recovery', () => {
  test('running becomes unknown; a done inspection records; not-done returns to pending', async () => {
    const effect = store.insertEffect({ executionId, change: 'api', roundId: null, kind: 'push', effectKey: 'k1', command: { cwd: '/w', commit: 'abc', branch: 'api' } })
    store.markEffectRunning(effect.id)
    const unknown = store.markRunningEffectsUnknown()
    expect(unknown.map(row => row.id)).toEqual([effect.id])
    reads.remoteHead = { 'refs/heads/api': 'abc' }
    await inspectUnknownEffects({ store, reads: adapters(), now: () => new Date(clock) })
    expect(store.effect(effect.id)).toMatchObject({ state: 'done', outcome: { head: 'abc' } })
    // Not-done: back to pending, ready for the runner.
    const second = store.insertEffect({ executionId, change: 'api', roundId: null, kind: 'remove-worktree', effectKey: 'k2', command: { repo: '/repo', path: '/repo/.worktrees/api' } })
    store.markEffectRunning(second.id)
    store.markRunningEffectsUnknown()
    reads.worktree = { '/repo/.worktrees/api': { present: true, head: 'h' } }
    await inspectUnknownEffects({ store, reads: adapters(), now: () => new Date(clock) })
    expect(store.effect(second.id)).toMatchObject({ state: 'pending' })
  })

  test('an undecidable inspection retries under the backoff, then settles as effect-unknown', async () => {
    const effect = store.insertEffect({ executionId, change: 'api', roundId: null, kind: 'merge', effectKey: 'k3', command: { repo: 'acme/app', pr: 7, head: 'h' } })
    store.markEffectRunning(effect.id)
    store.markRunningEffectsUnknown()
    reads.prView = {} // every read fails
    const settled: string[] = []
    for (let pass = 0; pass < 4; pass++) {
      await inspectUnknownEffects({
        store, reads: adapters(), backoffsMs: [10_000, 10_000, 10_000], now: () => new Date(clock),
        onUnknownSettled: (row, error) => settled.push(`${row.effectKey}: ${error}`),
      })
      clock += 10_000
    }
    const final = store.effect(effect.id)!
    expect(final).toMatchObject({ state: 'failed' })
    expect(final.error).toContain('pr view failed')
    expect(settled).toHaveLength(1)
  })
})
