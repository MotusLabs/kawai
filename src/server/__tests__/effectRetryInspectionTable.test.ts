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
import type { EffectRow } from '../plans/execution/executionRows'
import type { PrDetail } from '../plans/landing/github'
import type { EffectAdapter } from '../plans/execution/effects'
import type { InspectorReads } from '../plans/execution/effectInspectors'
import {
  createMatrixBench, createMatrixWorld, pushCommit, removeMatrixWorld, review, startedExecution, submitWork,
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

  test('an exhausted inspection stops the change naming its effect, and its Retry re-opens that one', async () => {
    const executionId = await startedExecution(h, [{ change: 'tb-exhaust' }])
    await h.tick()
    const effect = h.executions.insertEffect({ executionId, change: 'tb-exhaust', roundId: null, kind: 'push', effectKey: `${executionId}:tb-exhaust:push:seed:0`, command: { cwd: matrix.origin, commit: 'abc', branch: 'tb-exhaust' } })
    h.executions.markEffectRunning(effect.id)
    h.executions.markRunningEffectsUnknown()
    // Three undecidable passes over D14's backoffs exhaust the inspection:
    // the production recovery writes the stop, naming the effect.
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
    expect(h.executions.effect(effect.id)).toMatchObject({ state: 'failed' })
    const stopped = h.executions.change(executionId, 'tb-exhaust')!
    expect(stopped).toMatchObject({ state: 'stopped', stopReason: 'effect-unknown' })
    expect(stopped.stopDetail?.effectId).toBe(effect.id)
    expect(await h.service.retry(h.bench.human, { executionId, change: 'tb-exhaust', commandId: 'retry-tb-exhaust' })).toMatchObject({ ok: true })
    expect(h.executions.effect(effect.id)).toMatchObject({ state: 'unknown' })
  })
})

describe('the retry resumes at the stopped effect\'s step (A2)', () => {
  test('a landing-kind stop re-enters landing at its own step; a push stop stays at gating', async () => {
    const executionId = await startedExecution(h, [{ change: 'tb-rm' }, { change: 'tb-ru' }, { change: 'tb-rf' }, { change: 'tb-rp' }])
    await h.tick()
    // Each resumed change holds the team's one landing slot, so each is
    // cancelled again before the next kind's retry — a resumed stage keeps
    // the slot until it leaves landing, like any landing change.
    const resume = async (change: string, kind: EffectKind, command: Record<string, unknown>): Promise<EffectRow> => {
      const effect = seedUnknownStop(executionId, change, kind, command, true)
      expect(await h.service.retry(h.bench.human, { executionId, change, commandId: `retry-${change}` })).toMatchObject({ ok: true })
      return effect
    }
    const free = (change: string): void => {
      h.executions.transition(executionId, change, h.executions.change(executionId, change)!, { state: 'cancelled' })
    }
    const merge = await resume('tb-rm', 'merge', { repo: 'acme/app', pr: 7, head: 'head1' })
    expect(h.executions.change(executionId, 'tb-rm')).toMatchObject({ state: 'landing', step: 'merging' })
    expect(h.executions.slot(matrix.world.team.teamId)?.holderId).toContain(':tb-rm')
    free('tb-rm')
    const update = await resume('tb-ru', 'update-branch', { repo: 'acme/app', pr: 8, head: 'head1' })
    expect(h.executions.change(executionId, 'tb-ru')).toMatchObject({ state: 'landing', step: 'updating' })
    free('tb-ru')
    const forward = await resume('tb-rf', 'fast-forward', { cwd: matrix.origin, branch: 'wave/tb', sha: 'abc' })
    expect(h.executions.change(executionId, 'tb-rf')).toMatchObject({ state: 'landing', step: 'merging' })
    free('tb-rf')
    // A push is not a landing kind: the retry keeps the gating default.
    const push = await resume('tb-rp', 'push', { cwd: matrix.origin, commit: 'abc', branch: 'tb-rp' })
    expect(h.executions.change(executionId, 'tb-rp')).toMatchObject({ state: 'gating', step: null })
    // Nothing runs before the re-opened rows are inspected (I-A): one tick
    // over rejecting reads runs no adapter and leaves every row unknown,
    // each one try spent on its undecidable inspection.
    const calls: string[] = []
    await tickWith(() => h.makeExecutor({
      reads: rejecting,
      adapters: {
        merge: recording(calls, 'merge'), 'update-branch': recording(calls, 'update-branch'),
        'fast-forward': recording(calls, 'fast-forward'), push: recording(calls, 'push'),
      },
    }))
    expect(calls).toEqual([])
    for (const effect of [merge, update, forward, push]) {
      expect(h.executions.effect(effect.id)).toMatchObject({ state: 'unknown' })
      expect(h.executions.effect(effect.id)!.tries).toBe(1)
    }
  })

  test('a landing-kind stop whose slot is taken waits at gating; the re-opened row is still the one that decides', async () => {
    const executionId = await startedExecution(h, [{ change: 'tb-sa' }, { change: 'tb-sb' }])
    await h.tick()
    await submitWork(h, executionId, 'tb-sa', 'src/tb-sa.ts', 'a\n')
    await submitWork(h, executionId, 'tb-sb', 'src/tb-sb.ts', 'b\n')
    await h.tick()
    // The base moves and GitHub's update never comes through: tb-sa holds
    // the slot while updating, so tb-sb's pass waits outside it.
    pushCommit(matrix, 'master', 'slot.txt', 'slot\n')
    h.gh.update = () => {}
    try {
      await review(h, executionId, 'tb-sa', 'pass')
      await h.tick()
      expect(h.executions.change(executionId, 'tb-sa')).toMatchObject({ state: 'landing', step: 'updating' })
      await review(h, executionId, 'tb-sb', 'pass')
      await h.tick()
      expect(h.executions.change(executionId, 'tb-sb')).toMatchObject({ state: 'gating', step: 'awaiting-slot' })
      const merge = seedUnknownStop(executionId, 'tb-sb', 'merge', { repo: 'acme/app', pr: 999, head: 'head' }, true)
      expect(await h.service.retry(h.bench.human, { executionId, change: 'tb-sb', commandId: 'retry-tb-sb' })).toMatchObject({ ok: true })
      // The slot was taken: the retry waits at gating like applyLanding's
      // step 2, and the re-opened row — not a re-derived effect — decides.
      expect(h.executions.effect(merge.id)).toMatchObject({ state: 'unknown' })
      expect(h.executions.change(executionId, 'tb-sb')).toMatchObject({ state: 'gating', step: 'awaiting-slot' })
      expect(h.executions.slot(matrix.world.team.teamId)?.holderId).toContain(':tb-sa')
      const calls: string[] = []
      await tickWith(() => h.makeExecutor({ reads: rejecting, adapters: { merge: recording(calls, 'merge') } }))
      expect(calls).toEqual([])
      expect(h.executions.effect(merge.id)).toMatchObject({ state: 'unknown' })
      expect(h.executions.change(executionId, 'tb-sb')).toMatchObject({ state: 'gating', step: 'awaiting-slot' })
    } finally {
      h.gh.update = null
    }
  })

  test('the re-opened effect gets a fresh inspection budget (A3)', async () => {
    const executionId = await startedExecution(h, [{ change: 'tb-budget' }])
    await h.tick()
    const effect = h.executions.insertEffect({ executionId, change: 'tb-budget', roundId: null, kind: 'push', effectKey: `${executionId}:tb-budget:push:seed:0`, command: { cwd: matrix.origin, commit: 'abc', branch: 'tb-budget' } })
    h.executions.markEffectRunning(effect.id)
    h.executions.markRunningEffectsUnknown()
    // Three undecidable passes exhaust the inspection: failed, tries spent.
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
    expect(h.executions.effect(effect.id)).toMatchObject({ state: 'failed' })
    expect(h.executions.effect(effect.id)!.tries).toBe(3)
    expect(await h.service.retry(h.bench.human, { executionId, change: 'tb-budget', commandId: 'retry-tb-budget' })).toMatchObject({ ok: true })
    expect(h.executions.effect(effect.id)).toMatchObject({ state: 'unknown' })
    expect(h.executions.effect(effect.id)!.tries).toBe(0)
    // The retry's own inspection gets the same three tries before it may
    // settle the row effect-unknown again.
    const retry = h.makeExecutor({ reads: rejecting })
    try {
      for (const step of [31_000, 121_000, 601_000]) {
        await h.tick(retry)
        expect(h.executions.effect(effect.id)).toMatchObject({ state: 'unknown' })
        h.clock.now += step
      }
      await h.tick(retry)
    } finally {
      retry.close()
    }
    expect(h.executions.effect(effect.id)).toMatchObject({ state: 'failed' })
  })
})
