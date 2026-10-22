// The update-branch, round, and execution-level rows of the merge × Retry
// table (effect lifecycle, plan (d) rows 11–13, 17, 19–20): an interrupted
// update re-opened by the Retry decides over the real GitHub head (moved —
// the clean-merge check carries the round; unchanged — GitHub's update runs
// exactly once more; refused — the change returns as an update attempt), a
// superseded round's live push is cancelled and never pushes after the newer
// result, a Stop spares a landing change whose merge then lands through the
// inspection, and the due unknown row is inspected before its backoff peer.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import type { InspectorReads } from '../plans/execution/effectInspectors'
import { mergeAdapter, updateBranchAdapter } from '../plans/execution/executionLanding'
import {
  createMatrixBench, createMatrixWorld, git, onOrigin, originHead, passedChange, pushCommit, removeMatrixWorld,
  review, startedExecution, submitWork, type MatrixBench, type MatrixWorld,
} from './executionMatrixHarness'

let matrix: MatrixWorld
let h: MatrixBench

beforeAll(async () => { matrix = await createMatrixWorld('kawai-resume-rounds-') })
afterAll(() => removeMatrixWorld(matrix))
beforeEach(() => { h = createMatrixBench(matrix) })
afterEach(() => { h.executor.close(); h.bench.db.close() })

const REJECT = (): Promise<never> => Promise.reject(new Error('the read failed'))
const rejecting: InspectorReads = {
  worktree: REJECT, localBranch: REJECT, remoteHead: REJECT,
  prList: REJECT, prView: REJECT, contains: REJECT, runAttempt: REJECT,
}

/** Reads answered through the harness's scripted GitHub, as in the lifecycle table. */
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

/** The matrix origin is a path, so the recorded repo is empty; give the row a real one for the inspection. */
const giveRepo = (effectId: string): void => {
  h.executions.db.prepare(`UPDATE plan_execution_effects SET command_json = json_set(command_json, '$.repo', 'example/kawai') WHERE id = ?`).run(effectId)
}

const rowsOf = (executionId: string, kind: string): EffectRowLike[] =>
  h.executions.effectsOf(executionId).filter(effect => effect.kind === kind)
type EffectRowLike = ReturnType<MatrixBench['executions']['effectsOf']>[number]

/** Recording adapters that must never run: one call is a failed row. */
const RECORDER_KINDS = ['merge', 'update-branch', 'fast-forward', 'push', 'open-pr', 'rerun', 'create-integration', 'provision'] as const
const recorders = (calls: string[]): Record<string, { call: () => Promise<{ ok: false; error: { argv: string[]; exitCode: number; stderr: string } }> }> =>
  Object.fromEntries(RECORDER_KINDS.map(kind => [kind, {
    call: async () => { calls.push(kind); return { ok: false, error: { argv: [kind], exitCode: 1, stderr: `${kind} must not run` } } },
  }]))

/**
 * The base moves and the landing's update-branch adapter is interrupted: the
 * real row exists, pending on the first backoff, the change at its step.
 */
const interruptedUpdate = async (executionId: string, change: string): Promise<EffectRowLike> => {
  await h.tick()
  await submitWork(h, executionId, change, `src/${change}.ts`, `export const ${change.replace(/\W/g, '_')} = 1\n`)
  await h.tick()
  pushCommit(matrix, 'master', `wait-${change}.txt`, 'wait\n')
  await review(h, executionId, change, 'pass')
  const dying = h.makeExecutor({
    adapters: { 'update-branch': { call: async () => ({ ok: false, error: { argv: ['gh', 'api'], exitCode: null, stderr: 'connection reset' } }) } },
  })
  try {
    await h.tick(dying)
    await h.tick(dying)
  } finally { dying.close() }
  expect(h.executions.change(executionId, change)).toMatchObject({ state: 'landing', step: 'updating' })
  const rows = rowsOf(executionId, 'update-branch')
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ state: 'pending', tries: 1 })
  return rows[0]!
}

/** The crash window: the dispatched process is gone, the row awaits its inspection. */
const crashRow = (effectId: string): void => {
  h.executions.markEffectRunning(effectId)
  h.executions.markRunningEffectsUnknown()
}

/**
 * The landing whose merge adapter was interrupted (as in the lifecycle
 * table): the real row exists, pending on the first backoff, the change at
 * its merge step.
 */
const interruptedLandingMerge = async (executionId: string, change: string): Promise<EffectRowLike> => {
  await passedChange(h, executionId, change)
  const dying = h.makeExecutor({
    adapters: { merge: { call: async () => ({ ok: false, error: { argv: ['gh', 'pr', 'merge'], exitCode: null, stderr: 'connection reset' } }) } },
  })
  try {
    await h.tick(dying)
    await h.tick(dying)
  } finally { dying.close() }
  expect(h.executions.change(executionId, change)).toMatchObject({ state: 'landing', step: 'merging' })
  const rows = rowsOf(executionId, 'merge')
  expect(rows).toHaveLength(1)
  return rows[0]!
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
}

describe('update-branch × Retry, decided by the real GitHub head (table rows 11–13)', () => {
  test('a pull request head updated by hand carries the round through the re-opened row; no adapter runs (row 11)', async () => {
    const executionId = await startedExecution(h, [{ change: 'tu-moved' }])
    const update = await interruptedUpdate(executionId, 'tu-moved')
    giveRepo(update.id)
    crashRow(update.id)
    await exhaustUnknown(executionId, 'tu-moved', update.id)
    // GitHub's update-branch happened for real: the head moved past the pin.
    const branch = h.executions.change(executionId, 'tu-moved')!.branch!
    onOrigin(matrix, clone => {
      git(['checkout', '-q', branch], clone)
      git(['-c', 'user.email=gh@e', '-c', 'user.name=GitHub', 'merge', '-q', '--no-ff', '-m', 'Merge base', 'origin/master'], clone)
      git(['push', '-q', 'origin', `HEAD:refs/heads/${branch}`], clone)
    })
    const updates = h.gh.updates.length
    expect(await h.service.retry(h.bench.human, { executionId, change: 'tu-moved', commandId: 'retry-moved' })).toMatchObject({ ok: true })
    expect(h.executions.effect(update.id)).toMatchObject({ state: 'unknown' })
    // The verdict decides: no adapter runs, the clean-merge check carries the
    // round onto the new head, CI re-reads it, and the change lands.
    const calls: string[] = []
    const recorder = h.makeExecutor({ reads: ghReads(), adapters: recorders(calls) })
    try { await h.tick(recorder) } finally { recorder.close() }
    expect(calls).toEqual([])
    expect(h.executions.effect(update.id)).toMatchObject({ state: 'done', outcome: { moved: true } })
    for (let pass = 0; pass < 10; pass++) await h.tick()
    expect(h.executions.change(executionId, 'tu-moved')!.state).toBe('landed')
    expect(h.gh.updates).toHaveLength(updates)
  }, 60_000)

  test('an unmoved head runs GitHub’s update exactly once more, then lands (row 12)', async () => {
    const executionId = await startedExecution(h, [{ change: 'tu-same' }])
    const update = await interruptedUpdate(executionId, 'tu-same')
    giveRepo(update.id)
    crashRow(update.id)
    await exhaustUnknown(executionId, 'tu-same', update.id)
    const updates = h.gh.updates.length
    expect(await h.service.retry(h.bench.human, { executionId, change: 'tu-same', commandId: 'retry-same' })).toMatchObject({ ok: true })
    // The head is where it was: the inspection says not-done, the real
    // update-branch runs exactly once more, and its moved head is consumed.
    // The recording merge delegates: the landing it enables is post-verdict.
    const calls: string[] = []
    const real = mergeAdapter(h.landingAdapters)
    const recorder = h.makeExecutor({
      reads: ghReads(),
      adapters: {
        ...recorders(calls), merge: {
          call: async effect => { calls.push('merge'); return real.call(effect) },
        }, 'update-branch': updateBranchAdapter(h.landingAdapters),
      },
    })
    try { await h.tick(recorder) } finally { recorder.close() }
    expect(calls.every(kind => kind === 'merge')).toBe(true)
    expect(h.gh.updates).toHaveLength(updates + 1)
    for (let pass = 0; pass < 10; pass++) await h.tick()
    expect(h.executions.change(executionId, 'tu-same')!.state).toBe('landed')
  }, 60_000)

  test('a 422 conflict returns the change as an update attempt; nothing else runs (row 13)', async () => {
    const executionId = await startedExecution(h, [{ change: 'tu-conflict' }])
    const update = await interruptedUpdate(executionId, 'tu-conflict')
    giveRepo(update.id)
    crashRow(update.id)
    await exhaustUnknown(executionId, 'tu-conflict', update.id)
    // GitHub refuses the update with 422: the re-opened row's inspection
    // says not-done, the real update-branch runs once, settles the conflict,
    // and the follow-on returns the change to gating with its attempt.
    h.gh.update = () => 'conflict'
    try {
      const updates = h.gh.updates.length
      expect(await h.service.retry(h.bench.human, { executionId, change: 'tu-conflict', commandId: 'retry-conflict' })).toMatchObject({ ok: true })
      const calls: string[] = []
      const recorder = h.makeExecutor({
        reads: ghReads(),
        adapters: { ...recorders(calls), 'update-branch': updateBranchAdapter(h.landingAdapters) },
      })
      try { await h.tick(recorder) } finally { recorder.close() }
      expect(calls).toEqual([])
      // The one refused call is the update that ran; nothing else ran.
      expect(h.gh.updates).toHaveLength(updates + 1)
      expect(h.executions.effect(update.id)).toMatchObject({ state: 'done', outcome: { conflict: true } })
      for (let pass = 0; pass < 4; pass++) await h.tick()
      expect(h.executions.change(executionId, 'tu-conflict')).toMatchObject({ state: 'gating' })
    } finally { h.gh.update = null }
  }, 60_000)
})

describe('round and execution kinds (table rows 17, 19, 20)', () => {
  test('a superseded round’s live push is cancelled and never pushes after the newer result (row 17, A7)', async () => {
    const executionId = await startedExecution(h, [{ change: 'tr-supersede' }])
    await h.tick()
    await submitWork(h, executionId, 'tr-supersede', 'src/tr-supersede.ts', 'one\n')
    // Round 1's push is interrupted: live, pending on its first backoff.
    const dying = h.makeExecutor({ adapters: { push: { call: async () => ({ ok: false, error: { argv: ['git', 'push'], exitCode: null, stderr: 'connection reset' } }) } } })
    try { await h.tick(dying) } finally { dying.close() }
    const rounds = h.executions.rounds(executionId, 'tr-supersede')
    expect(rounds).toHaveLength(1)
    const firstPush = rowsOf(executionId, 'push').at(-1)!
    expect(firstPush).toMatchObject({ state: 'pending', tries: 1, roundId: rounds[0]!.id })
    // A newer result supersedes the open round: its live push is cancelled
    // at the supersession, and round 2's push runs once with round 2's head.
    await submitWork(h, executionId, 'tr-supersede', 'src/tr-supersede.ts', 'two\n')
    await h.tick()
    const roundsAfter = h.executions.rounds(executionId, 'tr-supersede')
    expect(roundsAfter).toHaveLength(2)
    expect(roundsAfter[0]).toMatchObject({ outcome: 'superseded' })
    expect(h.executions.effect(firstPush.id)).toMatchObject({ state: 'cancelled' })
    const pushes = rowsOf(executionId, 'push')
    expect(pushes.filter(effect => effect.state === 'done')).toHaveLength(1)
    // Past the cancelled row's backoff: it never runs; the remote holds
    // round 2's commit only.
    h.clock.now += 31_000
    await h.tick()
    expect(rowsOf(executionId, 'push').filter(effect => effect.state === 'done')).toHaveLength(1)
    expect(h.gh.pushes).toHaveLength(1)
    expect(h.gh.pushes[0]).toContain(originHead(matrix, 'tr-supersede')!.slice(0, 7))
  }, 30_000)

  test('a Stop spares a landing change whose merge the inspection then lands (row 19, A4)', async () => {
    const executionId = await startedExecution(h, [{ change: 'tr-stop' }])
    const merge = await interruptedLandingMerge(executionId, 'tr-stop')
    giveRepo(merge.id)
    // The crash window opens around the Stop: the running row is what the
    // stop spares the landing change for.
    h.executions.markEffectRunning(merge.id)
    expect(await h.service.stop(h.bench.human, { executionId, reason: 'the owner stopped the run', commandId: 'stop-19' })).toMatchObject({ ok: true })
    expect(h.executions.execution(executionId)).toMatchObject({ state: 'finished', outcome: 'stopped' })
    expect(h.executions.change(executionId, 'tr-stop')).toMatchObject({ state: 'landing', step: 'merging' })
    h.executions.markRunningEffectsUnknown()
    // The crash window outlives the dying attempt's first backoff.
    h.clock.now += 31_000
    // GitHub merged the pull request before the stop took hold: the widened
    // inspection settles the row done, and the stopped execution's planner
    // branch lands the change — no merge adapter runs.
    const command = h.executions.effect(merge.id)!.command as { pr: number; head: string }
    expect(await h.landingAdapters.prMerge('example/kawai', command.pr, 'merge', command.head)).toMatchObject({ ok: true })
    const calls: string[] = []
    const recorder = h.makeExecutor({ reads: ghReads(), adapters: recorders(calls) })
    try { await h.tick(recorder) } finally { recorder.close() }
    expect(calls).toEqual([])
    expect(h.executions.effect(merge.id)).toMatchObject({ state: 'done', outcome: { merged: true } })
    for (let pass = 0; pass < 6; pass++) await h.tick()
    expect(h.executions.change(executionId, 'tr-stop')!.state).toBe('landed')
    expect(h.gh.merges).toHaveLength(1)
  }, 30_000)

  test('the due unknown row is inspected before its backoff peer; neither runs first (row 20, A5)', async () => {
    const peerId = await startedExecution(h, [{ change: 'tr-peer' }])
    const lateId = await startedExecution(h, [{ change: 'tr-late' }])
    const peer = await interruptedLandingMerge(peerId, 'tr-peer')
    giveRepo(peer.id)
    // The peer's change leaves the landing slot for a state the planner
    // never revisits — its row stays unknown, a backoff behind — so the
    // second interruption can run its own landing.
    h.executions.transition(peerId, 'tr-peer', h.executions.change(peerId, 'tr-peer')!, { state: 'cancelled' })
    // The second crash happens a backoff later: when the clock reaches it,
    // the first row is due and the second still waits for its next_at.
    h.clock.now += 40_000
    const late = await interruptedLandingMerge(lateId, 'tr-late')
    giveRepo(late.id)
    crashRow(peer.id)
    crashRow(late.id)
    // The due row's pull request is read before the backoff peer's, and no
    // adapter of either change runs before its own row decides.
    const calls: string[] = []
    const viewed: number[] = []
    const reads = ghReads()
    const peerPr = (h.executions.effect(peer.id)!.command as { pr: number }).pr
    const latePr = (h.executions.effect(late.id)!.command as { pr: number }).pr
    const logging: InspectorReads = {
      ...reads,
      prView: async (repo, pr) => { viewed.push(pr); return reads.prView(repo, pr) },
    }
    const recorder = h.makeExecutor({ reads: logging, adapters: recorders(calls) })
    try {
      await h.tick(recorder)
      expect(calls).toEqual([])
      expect(viewed).toEqual([peerPr])
      // When the late row's backoff ends it is inspected in its own turn, and
      // only then may its adapter run (the recording merge fails it back to
      // its backoff). The cancelled peer's row is never inspected again and
      // never runs.
      h.clock.now += 31_000
      await h.tick(recorder)
    } finally { recorder.close() }
    expect(viewed).toEqual([peerPr, latePr])
    expect(calls.every(kind => kind === 'merge')).toBe(true)
    expect(h.executions.effect(peer.id)).toMatchObject({ state: 'pending' })
  }, 30_000)
})
