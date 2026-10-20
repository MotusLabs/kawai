// The merge × Retry table (effect lifecycle, plan (d) rows 1–10): after an
// effect-unknown stop, the Retry's re-opened row decides over the real
// GitHub truth — a pull request merged by any method lands with zero
// adapter calls, a closed one stops as pr-closed, an open one runs the
// merge exactly once (under the slot, never against a base the clean-merge
// check did not see), and an undecidable world stops again on a fresh
// budget. Over the matrix world's real bare origin; the scripted gh is the
// GitHub side, so a "hand merge" goes through its real prMerge.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import type { InspectorReads } from '../plans/execution/effectInspectors'
import { mergeAdapter } from '../plans/execution/executionLanding'
import type { EffectAdapter } from '../plans/execution/effects'
import type { EffectRow } from '../plans/execution/executionRows'
import {
  createMatrixBench, createMatrixWorld, git, onOrigin, originHead, passedChange, pushCommit, removeMatrixWorld, review,
  startedExecution, submitWork, type MatrixBench, type MatrixWorld,
} from './executionMatrixHarness'

let matrix: MatrixWorld
let h: MatrixBench

beforeAll(async () => { matrix = await createMatrixWorld('kawai-lifecycle-') })
afterAll(() => removeMatrixWorld(matrix))
beforeEach(() => { h = createMatrixBench(matrix) })
afterEach(() => { h.executor.close(); h.bench.db.close() })

const REJECT = (): Promise<never> => Promise.reject(new Error('the read failed'))
const rejecting: InspectorReads = {
  worktree: REJECT, localBranch: REJECT, remoteHead: REJECT,
  prList: REJECT, prView: REJECT, contains: REJECT, runAttempt: REJECT,
}

/**
 * Reads answered through the harness's scripted GitHub: the inspection
 * decides over the same pull-request truth the adapters act on, as the
 * production reads and adapters both reach GitHub.
 */
const ghReads = (): InspectorReads => {
  const landing = h.landingAdapters
  return {
    worktree: async () => ({ present: true, head: null }),
    localBranch: async () => null,
    remoteHead: async () => null,
    prList: async () => [],
    prView: async (repo, pr) => {
      const view = await landing.prView(repo, pr)
      if (!view.ok) throw new Error('the pull request could not be read')
      return view.data
    },
    contains: async () => false,
    runAttempt: async () => 1,
  }
}

/** The matrix origin is a path, so the recorded repo is empty; give the row a real one so `text('repo')` can answer. */
const giveRepo = (effectId: string): void => {
  h.executions.db.prepare(`UPDATE plan_execution_effects SET command_json = json_set(command_json, '$.repo', 'example/kawai') WHERE id = ?`).run(effectId)
}

const mergeRows = (executionId: string): EffectRow[] =>
  h.executions.effectsOf(executionId).filter(effect => effect.kind === 'merge')

/** Recording adapters that must never run: one call is a failed row. */
const RECORDER_KINDS = ['merge', 'update-branch', 'fast-forward', 'push', 'open-pr', 'rerun', 'create-integration', 'provision'] as const
const recorders = (calls: string[]): Record<string, EffectAdapter> =>
  Object.fromEntries(RECORDER_KINDS.map(kind => [kind, {
    call: async () => { calls.push(kind); return { ok: false, error: { argv: [kind], exitCode: 1, stderr: `${kind} must not run` } } },
  }]))

/**
 * The landing whose merge adapter was interrupted: the real row exists,
 * nothing merged. One tick moves the change to the merge step (the stage
 * converges one step per tick); the second inserts the row, runs it, and
 * the dying adapter leaves it pending on the first backoff.
 */
const interruptedLanding = async (executionId: string, change: string): Promise<EffectRow> => {
  await passedChange(h, executionId, change)
  const dying = h.makeExecutor({
    adapters: { merge: { call: async () => ({ ok: false, error: { argv: ['gh', 'pr', 'merge'], exitCode: null, stderr: 'connection reset' } }) } },
  })
  try {
    await h.tick(dying)
    await h.tick(dying)
  } finally { dying.close() }
  expect(h.executions.change(executionId, change)).toMatchObject({ state: 'landing', step: 'merging' })
  const rows = mergeRows(executionId)
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ state: 'pending', tries: 1 })
  return rows[0]!
}

/** The crash window: the dispatched process is gone, the row awaits its inspection. */
const crashRow = (effectId: string): void => {
  h.executions.markEffectRunning(effectId)
  h.executions.markRunningEffectsUnknown()
}

/** Three undecidable inspection passes over D14's backoffs exhaust into the production stop. */
const exhaustUnknown = async (executionId: string, change: string, effectId: string): Promise<void> => {
  const blocked = h.makeExecutor({ reads: rejecting })
  try {
    for (const step of [31_000, 121_000, 601_000]) {
      await h.tick(blocked)
      h.clock.now += step
    }
    await h.tick(blocked)
  } finally { blocked.close() }
  expect(h.executions.effect(effectId)).toMatchObject({ state: 'failed' })
  expect(h.executions.change(executionId, change)).toMatchObject({ state: 'stopped', stopReason: 'effect-unknown' })
  expect(h.executions.change(executionId, change)!.stopDetail?.effectId).toBe(effectId)
}

describe('merge × Retry, decided by the real GitHub truth (table rows 1–10)', () => {
  test('a pull request merged on GitHub lands through the re-opened row; no adapter runs (rows 1–3)', async () => {
    for (const method of ['merge', 'squash', 'rebase'] as const) {
      const executionId = await startedExecution(h, [{ change: `tb-${method}` }])
      const merge = await interruptedLanding(executionId, `tb-${method}`)
      giveRepo(merge.id)
      crashRow(merge.id)
      await exhaustUnknown(executionId, `tb-${method}`, merge.id)
      // GitHub merged the pull request for real, by this method.
      const before = h.gh.merges.length
      const command = h.executions.effect(merge.id)!.command as { pr: number; head: string }
      expect(await h.landingAdapters.prMerge('example/kawai', command.pr, method, command.head)).toMatchObject({ ok: true })
      expect(h.gh.merges).toHaveLength(before + 1)
      expect(await h.service.retry(h.bench.human, { executionId, change: `tb-${method}`, commandId: `retry-${method}` })).toMatchObject({ ok: true })
      expect(h.executions.effect(merge.id)).toMatchObject({ state: 'unknown' })
      expect(h.executions.change(executionId, `tb-${method}`)).toMatchObject({ state: 'landing', step: 'merging' })
      // The settled verdict decides: every adapter stays silent, the change lands.
      const calls: string[] = []
      const recorder = h.makeExecutor({ reads: ghReads(), adapters: recorders(calls) })
      try { await h.tick(recorder) } finally { recorder.close() }
      expect(calls).toEqual([])
      expect(h.executions.effect(merge.id)).toMatchObject({ state: 'done', outcome: { merged: true } })
      for (let pass = 0; pass < 4; pass++) await h.tick()
      expect(h.executions.change(executionId, `tb-${method}`)!.state).toBe('landed')
      expect(h.gh.merges).toHaveLength(before + 1)
    }
  }, 60_000)

  test('a merged pull request whose head branch was auto-deleted lands all the same (row 4)', async () => {
    const executionId = await startedExecution(h, [{ change: 'tb-del' }])
    const merge = await interruptedLanding(executionId, 'tb-del')
    giveRepo(merge.id)
    crashRow(merge.id)
    await exhaustUnknown(executionId, 'tb-del', merge.id)
    const command = h.executions.effect(merge.id)!.command as { pr: number; head: string }
    expect(await h.landingAdapters.prMerge('example/kawai', command.pr, 'merge', command.head)).toMatchObject({ ok: true })
    // GitHub's auto-delete: the head branch is gone from origin.
    onOrigin(matrix, clone => { git(['push', '-q', 'origin', ':refs/heads/tb-del'], clone) })
    expect(await h.service.retry(h.bench.human, { executionId, change: 'tb-del', commandId: 'retry-del' })).toMatchObject({ ok: true })
    const calls: string[] = []
    const recorder = h.makeExecutor({ reads: ghReads(), adapters: recorders(calls) })
    try { await h.tick(recorder) } finally { recorder.close() }
    expect(calls).toEqual([])
    expect(h.executions.effect(merge.id)).toMatchObject({ state: 'done', outcome: { merged: true } })
    for (let pass = 0; pass < 4; pass++) await h.tick()
    expect(h.executions.change(executionId, 'tb-del')!.state).toBe('landed')
  }, 30_000)

  test('a pull request closed unmerged stops the change as pr-closed; no adapter runs (row 6)', async () => {
    const executionId = await startedExecution(h, [{ change: 'tb-closed' }])
    const merge = await interruptedLanding(executionId, 'tb-closed')
    giveRepo(merge.id)
    crashRow(merge.id)
    await exhaustUnknown(executionId, 'tb-closed', merge.id)
    const pull = h.gh.pulls.find(entry => entry.branch === 'tb-closed')!
    pull.state = 'CLOSED'
    pull.mergeCommit = null
    expect(await h.service.retry(h.bench.human, { executionId, change: 'tb-closed', commandId: 'retry-closed' })).toMatchObject({ ok: true })
    const calls: string[] = []
    const recorder = h.makeExecutor({ reads: ghReads(), adapters: recorders(calls) })
    try {
      await h.tick(recorder)
      await h.tick(recorder)
    } finally { recorder.close() }
    expect(calls).toEqual([])
    expect(h.executions.effect(merge.id)).toMatchObject({ state: 'failed' })
    expect((h.executions.effect(merge.id)!.outcome as { stop?: string } | null)?.stop).toBe('pr-closed')
    expect(h.executions.change(executionId, 'tb-closed')).toMatchObject({ state: 'stopped', stopReason: 'pr-closed' })
  }, 30_000)

  test('a not-done merge waits for the slot without running, then runs exactly once under it (row 8)', async () => {
    const executionId = await startedExecution(h, [{ change: 'tb-hold' }, { change: 'tb-eight' }])
    await h.tick()
    await submitWork(h, executionId, 'tb-hold', 'src/tb-hold.ts', 'h\n')
    await submitWork(h, executionId, 'tb-eight', 'src/tb-eight.ts', 'e\n')
    await h.tick()
    // The base moves and GitHub's update never comes through: tb-hold holds
    // the slot while updating, so tb-eight waits outside it.
    pushCommit(matrix, 'master', 'wait8.txt', 'wait\n')
    h.gh.update = () => {}
    try {
      await review(h, executionId, 'tb-hold', 'pass')
      await h.tick()
      await review(h, executionId, 'tb-eight', 'pass')
      await h.tick()
      expect(h.executions.change(executionId, 'tb-eight')).toMatchObject({ state: 'gating', step: 'awaiting-slot' })
      // A merge effect of tb-eight's round stopped as effect-unknown; the
      // Retry falls back to waiting — the slot is taken — with the row live.
      const row = h.executions.change(executionId, 'tb-eight')!
      const round = h.executions.rounds(executionId, 'tb-eight').at(-1)!
      const merge = h.executions.insertEffect({
        executionId, change: 'tb-eight', roundId: round.id, kind: 'merge',
        effectKey: `${executionId}:tb-eight:merge:${round.number}:${row.generation}`,
        command: {
          repo: 'example/kawai', pr: row.prNumber ?? 0, head: originHead(matrix, 'tb-eight') ?? '',
          base: originHead(matrix, 'master') ?? '', baseBranch: 'master', method: 'merge', cwd: row.worktree ?? '',
        },
      })
      h.executions.setEffectOutcome(merge.id, { state: 'failed', error: 'the outcome could not be decided' })
      h.executions.transition(executionId, 'tb-eight', row, {
        state: 'stopped', stopReason: 'effect-unknown', step: null,
        stopDetail: { message: 'the outcome could not be determined', effectId: merge.id },
      })
      expect(await h.service.retry(h.bench.human, { executionId, change: 'tb-eight', commandId: 'retry-eight' })).toMatchObject({ ok: true })
      expect(h.executions.effect(merge.id)).toMatchObject({ state: 'unknown' })
      expect(h.executions.change(executionId, 'tb-eight')).toMatchObject({ state: 'gating', step: 'awaiting-slot' })
      // The pull request is unmerged: the inspection puts the row back to
      // pending — and the slot rule keeps every landing adapter silent while
      // tb-hold holds the slot (its own update keeps backing off below).
      const eightPr = row.prNumber!
      const reads: InspectorReads = {
        worktree: async () => ({ present: true, head: null }),
        localBranch: async () => null,
        remoteHead: async () => null,
        prList: async () => [],
        prView: async (_repo, pr) => {
          if (pr !== eightPr) throw new Error('the pull request could not be read')
          return { number: pr, url: `https://example.invalid/pr/${pr}`, state: 'OPEN', headRefOid: row.branch ?? '', mergeCommit: null }
        },
        contains: async () => false,
        runAttempt: async () => 1,
      }
      const calls: string[] = []
      // Only the merge-family adapters are recorded: tb-hold's live
      // update-branch belongs to the slot holder and keeps backing off
      // through the real (stubbed) adapter.
      const recorder = h.makeExecutor({ reads, adapters: {
        merge: recorders(calls).merge!, 'fast-forward': recorders(calls)['fast-forward']!,
      } })
      try {
        await h.tick(recorder)
        await h.tick(recorder)
      } finally { recorder.close() }
      expect(calls).toEqual([])
      expect(h.executions.effect(merge.id)).toMatchObject({ state: 'pending' })
      // The base reaches tb-hold's branch and it merges: the slot frees, and
      // tb-eight's pending row runs exactly once under it.
      h.gh.update = null
      const holdPull = h.gh.pulls.find(entry => entry.branch === 'tb-hold')!
      onOrigin(matrix, clone => {
        git(['checkout', '-q', holdPull.branch], clone)
        git(['-c', 'user.email=gh@e', '-c', 'user.name=GitHub', 'merge', '-q', '--no-ff', '-m', 'Merge base', 'origin/master'], clone)
        git(['push', '-q', 'origin', `HEAD:refs/heads/${holdPull.branch}`], clone)
      })
      for (let pass = 0; pass < 10; pass++) await h.tick()
      expect(h.executions.change(executionId, 'tb-hold')!.state).toBe('landed')
      expect(h.executions.change(executionId, 'tb-eight')!.state).toBe('landed')
      expect(h.gh.merges.filter(entry => entry.pr === eightPr)).toHaveLength(1)
    } finally {
      h.gh.update = null
    }
  }, 60_000)


  test('a base rewritten past the pinned base never merges; the change re-checks under the slot (row 9)', async () => {
    const executionId = await startedExecution(h, [{ change: 'tb-pin' }])
    const merge = await interruptedLanding(executionId, 'tb-pin')
    giveRepo(merge.id)
    crashRow(merge.id)
    await exhaustUnknown(executionId, 'tb-pin', merge.id)
    // The base moved BACKWARD on origin — to the commit before the pinned
    // one: still an ancestor of the head, so only the pin distinguishes it
    // (A8(ii)'s exact case).
    const baseline = h.executions.change(executionId, 'tb-pin')!.baselineCommit!
    onOrigin(matrix, clone => {
      git(['checkout', '-q', '-B', 'master', `${baseline}^`], clone)
      git(['push', '-q', '-f', 'origin', 'master'], clone)
    })
    expect(await h.service.retry(h.bench.human, { executionId, change: 'tb-pin', commandId: 'retry-pin' })).toMatchObject({ ok: true })
    // The one adapter call refuses at the pin (no prMerge) and reports the
    // move; the stage re-checks from the up-to-date step, re-pins, and the
    // second call merges.
    const outcomes: string[] = []
    const real = mergeAdapter(h.landingAdapters)
    const watching = h.makeExecutor({
      reads: ghReads(),
      adapters: { merge: { call: async effect => {
        const result = await real.call(effect)
        const outcome = result.ok ? result.outcome as { merged?: boolean } : null
        outcomes.push(outcome?.merged === true ? 'merged' : 'refused')
        return result
      } } },
    })
    try {
      await h.tick(watching)
      await h.tick(watching)
    } finally { watching.close() }
    expect(outcomes).toEqual(['refused', 'merged'])
    expect(h.gh.merges.filter(entry => entry.pr === (h.executions.effect(merge.id)!.command as { pr: number }).pr)).toHaveLength(1)
    expect(h.executions.change(executionId, 'tb-pin')!.state).toBe('landed')
  }, 30_000)

  test('the re-opened row carries a fresh budget: three more undecidables stop it again (row 10, A3)', async () => {
    const executionId = await startedExecution(h, [{ change: 'tb-again' }])
    const merge = await interruptedLanding(executionId, 'tb-again')
    giveRepo(merge.id)
    crashRow(merge.id)
    await exhaustUnknown(executionId, 'tb-again', merge.id)
    expect(await h.service.retry(h.bench.human, { executionId, change: 'tb-again', commandId: 'retry-again' })).toMatchObject({ ok: true })
    const calls: string[] = []
    const recorder = h.makeExecutor({ reads: rejecting, adapters: recorders(calls) })
    try {
      for (const step of [31_000, 121_000, 601_000]) {
        await h.tick(recorder)
        expect(h.executions.effect(merge.id)).toMatchObject({ state: 'unknown' })
        h.clock.now += step
      }
      await h.tick(recorder)
    } finally { recorder.close() }
    expect(calls).toEqual([])
    expect(h.executions.effect(merge.id)).toMatchObject({ state: 'failed' })
    expect(h.executions.change(executionId, 'tb-again')).toMatchObject({ state: 'stopped', stopReason: 'effect-unknown' })
    expect(h.executions.change(executionId, 'tb-again')!.stopDetail?.effectId).toBe(merge.id)
  }, 30_000)

  test('a live merge row of the round blocks the landing stage’s update insert (F5 pre-guard)', async () => {
    const executionId = await startedExecution(h, [{ change: 'tb-guard' }])
    const merge = await interruptedLanding(executionId, 'tb-guard')
    crashRow(merge.id)
    // The change sits at the up-to-date step with the merge row still live
    // (the crash window), and the base has moved: the stage wants to insert
    // the base update — the live row of the round settles first instead.
    h.executions.transition(executionId, 'tb-guard', h.executions.change(executionId, 'tb-guard')!, { step: 'up-to-date' })
    pushCommit(matrix, 'master', 'guard.txt', 'guard\n')
    const calls: string[] = []
    const recorder = h.makeExecutor({ reads: ghReads(), adapters: recorders(calls) })
    try {
      await h.tick(recorder)
      await h.tick(recorder)
    } finally { recorder.close() }
    expect(calls).toEqual([])
    expect(h.executions.effectsOf(executionId).filter(effect => effect.kind === 'update-branch')).toHaveLength(0)
    expect(h.executions.effect(merge.id)).toMatchObject({ state: 'unknown' })
    expect(h.executions.change(executionId, 'tb-guard')).toMatchObject({ state: 'landing', step: 'up-to-date' })
  }, 30_000)

  test('a live update-branch of the change blocks the landing stage’s merge insert (the merge step’s guard)', async () => {
    const executionId = await startedExecution(h, [{ change: 'tb-mguard' }])
    await passedChange(h, executionId, 'tb-mguard')
    // The crash window: a live update-branch row of the change, parked past
    // its inspection, while the change is still gating. The base is up to
    // date, so the stage reaches the merge step — the live row settles
    // first (A1 is kind-scoped, so the store predicate alone does not
    // substitute: the guard is what keeps the merge row out here).
    const live = h.executions.insertEffect({
      executionId, change: 'tb-mguard', roundId: null, kind: 'update-branch',
      effectKey: `${executionId}:tb-mguard:update-branch:mguard:0`,
      command: { repo: 'o/r', pr: 1, head: 'stale-head' },
    })
    h.executions.scheduleInspectionRetry(live.id, '2099-01-01T00:00:00.000Z', null)
    const calls: string[] = []
    const recorder = h.makeExecutor({ reads: ghReads(), adapters: recorders(calls) })
    try {
      await h.tick(recorder)
      await h.tick(recorder)
    } finally { recorder.close() }
    expect(calls).toEqual([])
    expect(mergeRows(executionId)).toHaveLength(0)
    expect(h.executions.effect(live.id)).toMatchObject({ state: 'unknown' })
    expect(h.executions.change(executionId, 'tb-mguard')).toMatchObject({ state: 'landing', step: 'up-to-date' })
  }, 30_000)
})

describe('mergeAdapter refuses a base the clean-merge check did not see (F2/A8ii unit)', () => {
  const T = '2026-10-20T00:00:00.000Z'
  const world = (baseNow: string, ancestor: boolean) => {
    const calls: string[] = []
    const adapters = {
      fetch: async () => { calls.push('fetch'); return { ok: true as const } },
      isAncestor: async () => { calls.push('isAncestor'); return { ok: true as const, ancestor } },
      mergeTree: async () => { calls.push('mergeTree'); return { ok: true as const, tree: 't', conflicts: [] as string[] } },
      lsRemoteHead: async (_cwd: string, ref: string) => {
        calls.push(`lsRemoteHead:${ref}`)
        return { ok: true as const, sha: ref.includes('master') ? baseNow : 'head-sha' }
      },
      prMerge: async () => { calls.push('prMerge'); return { ok: true as const, data: null } },
      prView: async () => { calls.push('prView'); return { ok: true as const, data: { state: 'open' } } },
      updateBranch: async () => { calls.push('updateBranch'); return { ok: true as const, data: null } },
    } as unknown as Parameters<typeof mergeAdapter>[0]
    return { calls, adapter: mergeAdapter(adapters) }
  }
  const effect = (base: string): EffectRow => ({
    id: 'fx1', executionId: 'e1', change: 'api', roundId: 'r1', kind: 'merge', effectKey: 'e1:api:merge:1:0',
    command: { repo: 'example/kawai', pr: 7, head: 'head-sha', base, baseBranch: 'master', method: 'merge', cwd: '/tmp/x' },
    state: 'running', tries: 1, nextAt: null, outcome: null, error: null, createdAt: T, startedAt: T, finishedAt: null,
  })

  test('the base moved past the pin but is contained in the head: no merge runs', async () => {
    const { calls, adapter } = world('base-moved', true)
    const result = await adapter.call(effect('base-pinned'))
    expect(result).toMatchObject({ ok: true, outcome: { merged: false, baseMoved: true, base: 'base-moved' } })
    expect(calls).toEqual(['lsRemoteHead:refs/heads/master', 'fetch', 'isAncestor'])
  })

  test('the base is the pin: the merge runs', async () => {
    const { calls, adapter } = world('base-pinned', true)
    const result = await adapter.call(effect('base-pinned'))
    expect(result).toMatchObject({ ok: true, outcome: { merged: false, baseMoved: false } })
    expect(calls).toContain('prMerge')
  })
})
