// The resumed landing end to end (effect lifecycle): a merge whose
// inspection was exhausted stops its change, and the Retry's re-opened row —
// never a re-derived effect — decides what happens: an unmerged pull request
// runs once and lands, and a pull request merged while the change waited for
// the slot lands it once the slot frees, without a second merge.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import type { InspectorReads } from '../plans/execution/effectInspectors'
import type { PrDetail } from '../plans/landing/github'
import {
  createMatrixBench, createMatrixWorld, git, onOrigin, originHead, pushCommit, removeMatrixWorld, review, startedExecution, submitWork,
  type MatrixBench, type MatrixWorld,
} from './executionMatrixHarness'

let matrix: MatrixWorld
let h: MatrixBench

beforeAll(async () => { matrix = await createMatrixWorld('kawai-resume-land-') })
afterAll(() => removeMatrixWorld(matrix))
beforeEach(() => { h = createMatrixBench(matrix) })
afterEach(() => { h.executor.close(); h.bench.db.close() })

const REJECT = (): Promise<never> => Promise.reject(new Error('the read failed'))
const rejecting: InspectorReads = {
  worktree: REJECT, localBranch: REJECT, remoteHead: REJECT,
  prList: REJECT, prView: REJECT, contains: REJECT, runAttempt: REJECT,
}
/** Counting reads whose `prView` slot answers the merge inspection. */
const answering = (log: string[], prView: () => PrDetail): InspectorReads => ({
  worktree: async () => { log.push('worktree'); return { present: true, head: null } },
  localBranch: async () => { log.push('localBranch'); return null },
  remoteHead: async () => { log.push('remoteHead'); return null },
  prList: async () => { log.push('prList'); return [] },
  prView: async (_repo, pr) => { log.push(`prView ${pr}`); return prView() },
  contains: async () => { log.push('contains'); return false },
  runAttempt: async () => { log.push('runAttempt'); return 1 },
})
const openPull = (pr: number, head: string): PrDetail => ({ number: pr, url: `https://example.invalid/pr/${pr}`, state: 'OPEN', headRefOid: head, mergeCommit: null })

const tickWith = async (build: () => ReturnType<MatrixBench['makeExecutor']>): Promise<void> => {
  const executor = build()
  try {
    await h.tick(executor)
  } finally {
    executor.close()
  }
}

/** Exhausts one change's unknown merge effect over rejecting reads: failed, the stop names it. */
const exhaustUnknownMerge = async (executionId: string, change: string, mergeId: string): Promise<void> => {
  const blocked = h.makeExecutor({ reads: rejecting })
  try {
    for (const step of [31_000, 121_000, 601_000]) {
      await h.tick(blocked)
      h.clock.now += step
    }
    await h.tick(blocked)
  } finally {
    blocked.close()
  }
  expect(h.executions.effect(mergeId)).toMatchObject({ state: 'failed' })
  const stopped = h.executions.change(executionId, change)!
  expect(stopped).toMatchObject({ state: 'stopped', stopReason: 'effect-unknown' })
  expect(stopped.stopDetail?.effectId).toBe(mergeId)
}

describe('a resumed landing decided by its re-opened row', () => {
  test('an exhausted merge runs once more through the re-opened row and lands', async () => {
    const executionId = await startedExecution(h, [{ change: 'tb-land' }])
    await h.tick()
    await submitWork(h, executionId, 'tb-land', 'src/tb-land.ts', 'land\n')
    await h.tick()
    await review(h, executionId, 'tb-land', 'pass')
    // The merge was dispatched and the executor died before it ran: the row
    // is live (running) and the change already sits at its step, so the
    // landing stage — seeing `merging` — neither runs nor re-issues it (A1).
    const row = h.executions.change(executionId, 'tb-land')!
    const execution = h.executions.execution(executionId)!
    const round = h.executions.rounds(executionId, 'tb-land').at(-1)!
    const merge = h.executions.insertEffect({
      executionId, change: 'tb-land', roundId: round.id, kind: 'merge',
      effectKey: `${executionId}:tb-land:merge:${round.number}:${row.generation}`,
      command: {
        repo: 'example/kawai', pr: row.prNumber ?? 0, head: originHead(matrix, 'tb-land') ?? '',
        base: originHead(matrix, 'master') ?? '', baseBranch: execution.baseBranch,
        method: execution.mergeMethod, cwd: row.worktree ?? '',
      },
    })
    h.executions.transition(executionId, 'tb-land', row, { state: 'landing', step: 'merging' })
    h.executions.markEffectRunning(merge.id)
    await h.tick()
    expect(h.executions.change(executionId, 'tb-land')).toMatchObject({ state: 'landing', step: 'merging' })
    expect(h.executions.effect(merge.id)).toMatchObject({ state: 'running' })
    h.executions.markRunningEffectsUnknown()
    const pr = row.prNumber!
    await exhaustUnknownMerge(executionId, 'tb-land', merge.id)
    // Retry: landing/merging again, the row re-opened with a fresh budget.
    expect(await h.service.retry(h.bench.human, { executionId, change: 'tb-land', commandId: 'retry-tb-land' })).toMatchObject({ ok: true })
    expect(h.executions.change(executionId, 'tb-land')).toMatchObject({ state: 'landing', step: 'merging' })
    expect(h.executions.effect(merge.id)).toMatchObject({ state: 'unknown', tries: 0 })
    // An undecidable inspection still runs nothing; the answered one finds
    // the pull request unmerged, the row runs once, the change lands.
    const log: string[] = []
    await tickWith(() => h.makeExecutor({ reads: rejecting }))
    h.clock.now += 31_000
    await tickWith(() => h.makeExecutor({ reads: answering(log, () => openPull(pr, originHead(matrix, 'tb-land') ?? '')) }))
    expect(log.join(' ')).toContain(`prView ${pr}`)
    for (let pass = 0; pass < 6; pass++) await h.tick()
    expect(h.executions.change(executionId, 'tb-land')!.state).toBe('landed')
    expect(h.executions.execution(executionId)).toMatchObject({ state: 'finished', outcome: 'completed' })
    expect(h.gh.merges.filter(entry => entry.pr === pr)).toHaveLength(1)
  }, 30_000)

  test('a pull request merged while the change waited for the slot lands it once the slot frees', async () => {
    const executionId = await startedExecution(h, [{ change: 'tb-wa' }, { change: 'tb-wb' }])
    await h.tick()
    await submitWork(h, executionId, 'tb-wa', 'src/tb-wa.ts', 'a\n')
    await submitWork(h, executionId, 'tb-wb', 'src/tb-wb.ts', 'b\n')
    await h.tick()
    // The base moves and GitHub's update never comes through: tb-wa holds
    // the slot while updating, so tb-wb's pass waits outside it.
    pushCommit(matrix, 'master', 'wait.txt', 'wait\n')
    h.gh.update = () => {}
    try {
      await review(h, executionId, 'tb-wa', 'pass')
      await h.tick()
      await review(h, executionId, 'tb-wb', 'pass')
      await h.tick()
      expect(h.executions.change(executionId, 'tb-wb')).toMatchObject({ state: 'gating', step: 'awaiting-slot' })
      // A merge effect of tb-wb's round stopped as effect-unknown; the Retry
      // falls back to waiting — the slot is taken — with the row re-opened.
      const row = h.executions.change(executionId, 'tb-wb')!
      const round = h.executions.rounds(executionId, 'tb-wb').at(-1)!
      const merge = h.executions.insertEffect({
        executionId, change: 'tb-wb', roundId: round.id, kind: 'merge',
        effectKey: `${executionId}:tb-wb:merge:${round.number}:${row.generation}`,
        command: {
          repo: 'example/kawai', pr: row.prNumber ?? 0, head: originHead(matrix, 'tb-wb') ?? '',
          base: originHead(matrix, 'master') ?? '', baseBranch: 'master', method: 'merge',
          cwd: row.worktree ?? '',
        },
      })
      h.executions.setEffectOutcome(merge.id, { state: 'failed', error: 'the outcome could not be decided' })
      h.executions.transition(executionId, 'tb-wb', row, {
        state: 'stopped', stopReason: 'effect-unknown', step: null,
        stopDetail: { message: 'the outcome could not be determined', effectId: merge.id },
      })
      expect(await h.service.retry(h.bench.human, { executionId, change: 'tb-wb', commandId: 'retry-tb-wb' })).toMatchObject({ ok: true })
      expect(h.executions.effect(merge.id)).toMatchObject({ state: 'unknown' })
      expect(h.executions.change(executionId, 'tb-wb')).toMatchObject({ state: 'gating', step: 'awaiting-slot' })
      // The pull request was merged by hand while the change waited: the
      // inspection settles the row done — and the slot keeps the verdict
      // waiting with the change.
      onOrigin(matrix, clone => {
        git(['checkout', '-q', 'master'], clone)
        git(['-c', 'user.email=gh@e', '-c', 'user.name=GitHub', 'merge', '-q', '--no-ff', '-m', 'Merge pull request by hand', originHead(matrix, 'tb-wb') ?? ''], clone)
        git(['push', '-q', 'origin', 'master'], clone)
      })
      const pr = row.prNumber!
      const log: string[] = []
      await tickWith(() => h.makeExecutor({
        reads: answering(log, () => ({
          number: pr, url: `https://example.invalid/pr/${pr}`, state: 'MERGED' as const,
          headRefOid: originHead(matrix, 'tb-wb') ?? '', mergeCommit: originHead(matrix, 'master'),
        })),
      }))
      expect(h.executions.effect(merge.id)).toMatchObject({ state: 'done', outcome: { merged: true } })
      expect(h.executions.change(executionId, 'tb-wb')).toMatchObject({ state: 'gating', step: 'awaiting-slot' })
      // tb-wa's update comes through, it merges, and the slot frees: the
      // waiting verdict lands tb-wb — no second merge is issued for it.
      h.gh.update = null
      const pull = h.gh.pulls.find(entry => entry.branch === 'tb-wa')!
      onOrigin(matrix, clone => {
        git(['checkout', '-q', pull.branch], clone)
        git(['-c', 'user.email=gh@e', '-c', 'user.name=GitHub', 'merge', '-q', '--no-ff', '-m', 'Merge base', 'origin/master'], clone)
        git(['push', '-q', 'origin', `HEAD:refs/heads/${pull.branch}`], clone)
      })
      for (let pass = 0; pass < 5; pass++) await h.tick()
      expect(h.executions.change(executionId, 'tb-wa')!.state).toBe('landed')
      expect(h.executions.change(executionId, 'tb-wb')!.state).toBe('landed')
      expect(h.executions.execution(executionId)).toMatchObject({ state: 'finished', outcome: 'completed' })
      expect(h.gh.merges.filter(entry => entry.pr === pr)).toHaveLength(0)
    } finally {
      h.gh.update = null
    }
  }, 30_000)
})
