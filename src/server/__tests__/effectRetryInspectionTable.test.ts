// The retry/inspection table (plan-execution 13.3, review N1/N2/N3): an
// effect whose outcome may have happened is never run again before an
// inspection answered it. Each effect kind gets its real path back to
// `unknown` — the human Retry after an `effect-unknown` stop for the
// change-level kinds (the stop names its effect, review N2), the startup
// mark for the execution-level kinds (integration-candidates D4) — and each
// row proves the gate: an unanswered inspection runs nothing, an answered
// one runs the effect at most once, after the read. Over the matrix world's
// real bare origin with scripted reads and adapters.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import type { EffectKind } from '../../shared/planExecution'
import type { PrDetail } from '../plans/landing/github'
import type { EffectAdapter } from '../plans/execution/effects'
import type { InspectorReads } from '../plans/execution/effectInspectors'
import {
  createMatrixBench, createMatrixWorld, removeMatrixWorld, startedExecution,
  type MatrixBench, type MatrixWorld,
} from './executionMatrixHarness'

let matrix: MatrixWorld
let h: MatrixBench

beforeAll(async () => { matrix = await createMatrixWorld('kawai-retry-table-') })
afterAll(() => removeMatrixWorld(matrix))
beforeEach(() => { h = createMatrixBench(matrix) })
afterEach(() => { h.executor.close(); h.bench.db.close() })

const REJECT = (): Promise<never> => Promise.reject(new Error('the read failed'))
/** Every read rejects: an inspection over these is undecidable, retried under the backoff. */
const rejecting: InspectorReads = {
  worktree: REJECT, localBranch: REJECT, remoteHead: REJECT,
  prList: REJECT, prView: REJECT, contains: REJECT, runAttempt: REJECT,
}

/** Counting reads whose `answers` slot overrides the default (absent ⇒ absent/not-done). */
const answering = (log: string[], answers: Partial<InspectorReads>): InspectorReads => ({
  worktree: async () => { log.push('worktree'); return { present: true, head: null } },
  localBranch: async () => { log.push('localBranch'); return null },
  remoteHead: async (cwd, ref) => {
    log.push(`remoteHead ${ref}`)
    return answers.remoteHead ? answers.remoteHead(cwd, ref) : null
  },
  prList: async () => { log.push('prList'); return [] },
  prView: async (repo, pr) => {
    log.push(`prView ${pr}`)
    if (!answers.prView) throw new Error('the pull request could not be read')
    return answers.prView(repo, pr)
  },
  contains: async (cwd, ref, ancestor, descendant) => {
    log.push('contains')
    return answers.contains ? answers.contains(cwd, ref, ancestor, descendant) : false
  },
  runAttempt: async () => { log.push('runAttempt'); return 1 },
})

const openPull = (pr: number, head: string): PrDetail => ({ number: pr, url: `https://example.invalid/pr/${pr}`, state: 'OPEN', headRefOid: head, mergeCommit: null })

/** A scripted effect adapter recording its calls and failing permanently — the effect runs, and does not happen. */
const recording = (calls: string[], kind: string): EffectAdapter => ({
  call: async effect => {
    calls.push(effect.effectKey)
    return { ok: false, error: { argv: [kind], exitCode: 1, stderr: ` ! [rejected] ${kind} (non-fast-forward)` } }
  },
})

/** One tick through a bespoke executor, closed even when an assertion throws. */
const tickWith = async (build: () => ExecutionExecutorLike): Promise<void> => {
  const executor = build()
  try {
    await h.tick(executor)
  } finally {
    executor.close()
  }
}
type ExecutionExecutorLike = ReturnType<MatrixBench['makeExecutor']>

/** Seed the state an exhausted inspection leaves: the effect failed, the change stopped as effect-unknown, naming it. */
const seedUnknownStop = (executionId: string, change: string, kind: EffectKind, command: Record<string, unknown>, named: boolean) => {
  const effect = h.executions.insertEffect({ executionId, change, roundId: null, kind, effectKey: `${executionId}:${change}:${kind}:seed:0`, command })
  h.executions.setEffectOutcome(effect.id, { state: 'failed', error: 'the outcome could not be decided' })
  const row = h.executions.change(executionId, change)!
  h.executions.transition(executionId, change, row, {
    state: 'stopped', stopReason: 'effect-unknown', step: null,
    stopDetail: { message: 'the outcome could not be determined', ...(named ? { effectId: effect.id } : {}) },
  })
  return effect
}

/** Seed the execution-level state a restart leaves: the effect was running, the process is gone. */
const seedInterrupted = (executionId: string, kind: EffectKind, command: Record<string, unknown>) => {
  const effect = h.executions.insertEffect({ executionId, change: null, roundId: null, kind, effectKey: `${executionId}::${kind}:seed`, command })
  expect(h.executions.markEffectRunning(effect.id)).toBe(true)
  expect(h.executions.markRunningEffectsUnknown().map(row => row.id)).toContain(effect.id)
  return effect
}

/** The gate, per kind: Retry (or the restart mark) → unknown; an undecidable inspection runs nothing; an answered one runs it once, after the read. */
async function expectInspectedBeforeRun(change: string, kind: EffectKind, command: Record<string, unknown>, answers: Partial<InspectorReads>, options: { executionLevel?: boolean } = {}) {
  const executionId = await startedExecution(h, [{ change }])
  await h.tick()
  const effect = options.executionLevel === true
    ? seedInterrupted(executionId, kind, command)
    : seedUnknownStop(executionId, change, kind, command, true)
  if (options.executionLevel !== true) {
    expect(await h.service.retry(h.bench.human, { executionId, change, commandId: `retry-${change}` })).toMatchObject({ ok: true })
    expect(h.executions.effect(effect.id)).toMatchObject({ state: 'unknown' })
  }
  const calls: string[] = []
  await tickWith(() => h.makeExecutor({ reads: rejecting, adapters: { [kind]: recording(calls, kind) } }))
  expect(calls).toEqual([])
  expect(h.executions.effect(effect.id)).toMatchObject({ state: 'unknown' })
  h.clock.now += 31_000
  const log: string[] = []
  await tickWith(() => h.makeExecutor({ reads: answering(log, answers), adapters: { [kind]: recording(calls, kind) } }))
  expect(log.length).toBeGreaterThan(0)
  return { effect, calls, log }
}

describe('the human Retry path (change-level kinds)', () => {
  test('push: inspected before it runs again', async () => {
    // origin has no branch: the push never happened, so the inspection
    // answers not-done and the effect runs once, after the read.
    const { effect, calls } = await expectInspectedBeforeRun('tb-push', 'push', { cwd: matrix.origin, commit: 'abc', branch: 'tb-push' }, {})
    expect(calls).toEqual([effect.effectKey])
    expect(h.executions.effect(effect.id)).toMatchObject({ state: 'failed' })
  })

  test('merge: an unmerged pull request is inspected before the merge runs again', async () => {
    const { effect, calls } = await expectInspectedBeforeRun(
      'tb-merge', 'merge',
      { repo: 'acme/app', pr: 7, head: 'head1', base: 'master', baseBranch: 'master', method: 'merge', cwd: matrix.origin },
      { prView: async () => openPull(7, 'head1') },
    )
    expect(calls).toEqual([effect.effectKey])
    expect(h.executions.effect(effect.id)).toMatchObject({ state: 'failed' })
  })

  test('update-branch: a pull request whose head moved is settled done, never run again', async () => {
    const { effect, calls } = await expectInspectedBeforeRun(
      'tb-update', 'update-branch',
      { repo: 'acme/app', pr: 8, head: 'head1' },
      { prView: async () => openPull(8, 'head2') },
    )
    expect(calls).toEqual([])
    expect(h.executions.effect(effect.id)).toMatchObject({ state: 'done' })
  })
})

describe('the recovery path (execution-level kinds)', () => {
  test('create-integration: a missing branch is inspected before the create runs again', async () => {
    const { effect, calls } = await expectInspectedBeforeRun(
      'tb-create', 'create-integration',
      { cwd: matrix.origin, branch: 'wave/tb', sha: 'abc' },
      {}, { executionLevel: true },
    )
    expect(calls).toEqual([effect.effectKey])
    expect(h.executions.effect(effect.id)).toMatchObject({ state: 'failed' })
  })

  test('fast-forward: a head the candidate does not reach is inspected before the fast-forward runs again', async () => {
    // The ref is at r1; the candidate (abc) does not contain r1, but r1
    // contains the candidate: not-done, it runs again.
    const { effect, calls } = await expectInspectedBeforeRun(
      'tb-ff', 'fast-forward',
      { cwd: matrix.origin, branch: 'wave/tb2', sha: 'abc' },
      {
        remoteHead: async () => 'r1',
        contains: async (_cwd, _ref, ancestor) => ancestor === 'abc' ? false : true,
      },
      { executionLevel: true },
    )
    expect(calls).toEqual([effect.effectKey])
    expect(h.executions.effect(effect.id)).toMatchObject({ state: 'failed' })
  })
})

describe('the stop names its effect (review N2)', () => {
  test('Retry re-opens the effect the stop names, not the change\'s oldest failed one', async () => {
    const executionId = await startedExecution(h, [{ change: 'tb-named' }])
    await h.tick()
    const push = h.executions.insertEffect({ executionId, change: 'tb-named', roundId: null, kind: 'push', effectKey: `${executionId}:tb-named:push:seed:0`, command: {} })
    h.executions.setEffectOutcome(push.id, { state: 'failed', error: 'undecidable' })
    h.clock.now += 1000
    const merge = h.executions.insertEffect({ executionId, change: 'tb-named', roundId: null, kind: 'merge', effectKey: `${executionId}:tb-named:merge:seed:0`, command: {} })
    h.executions.setEffectOutcome(merge.id, { state: 'failed', error: 'undecidable' })
    const row = h.executions.change(executionId, 'tb-named')!
    h.executions.transition(executionId, 'tb-named', row, {
      state: 'stopped', stopReason: 'effect-unknown', step: null,
      stopDetail: { message: 'the merge could not be determined', effectId: merge.id },
    })
    expect(await h.service.retry(h.bench.human, { executionId, change: 'tb-named', commandId: 'retry-tb-named' })).toMatchObject({ ok: true })
    expect(h.executions.effect(merge.id)).toMatchObject({ state: 'unknown' })
    expect(h.executions.effect(push.id)).toMatchObject({ state: 'failed' })
  })

  test('a stop written before the id existed falls back to the oldest failed effect', async () => {
    const executionId = await startedExecution(h, [{ change: 'tb-legacy' }])
    await h.tick()
    const push = seedUnknownStop(executionId, 'tb-legacy', 'push', { cwd: matrix.origin, commit: 'abc', branch: 'tb-legacy' }, false)
    h.clock.now += 1000
    const merge = h.executions.insertEffect({ executionId, change: 'tb-legacy', roundId: null, kind: 'merge', effectKey: `${executionId}:tb-legacy:merge:seed:0`, command: {} })
    h.executions.setEffectOutcome(merge.id, { state: 'failed', error: 'undecidable' })
    expect(await h.service.retry(h.bench.human, { executionId, change: 'tb-legacy', commandId: 'retry-tb-legacy' })).toMatchObject({ ok: true })
    expect(h.executions.effect(push.id)).toMatchObject({ state: 'unknown' })
    expect(h.executions.effect(merge.id)).toMatchObject({ state: 'failed' })
  })
})
