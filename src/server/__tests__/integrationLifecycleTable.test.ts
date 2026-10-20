// The fast-forward × Retry table (effect lifecycle, plan (d) rows 14–15):
// after an effect-unknown stop the Retry's re-opened row decides over the
// real origin truth — a branch already at the candidate lands with zero
// adapter calls, a branch moved past it supersedes the candidate and returns
// the change to the up-to-date step — plus A7's landing-kind half: a landed
// change's live landing-kind rows are cancelled at afterLanded.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { afterLanded, type LandingDeps } from '../plans/execution/executionLanding'
import type { EffectRow } from '../plans/execution/executionRows'
import {
  createMatrixBench, createMatrixWorld, git, originHead, passedChange, pushCommit, removeMatrixWorld,
  type MatrixBench, type MatrixWorld,
} from './executionMatrixHarness'
import { createIntegrationBench, startedIntegration, type IntegrationBench } from './integrationMatrixHarness'

let matrix: MatrixWorld
let h: MatrixBench
let i: IntegrationBench
let n = 0

beforeAll(async () => { matrix = await createMatrixWorld('kawai-ff-retry-') })
afterAll(() => removeMatrixWorld(matrix))
beforeEach(() => { h = createMatrixBench(matrix); i = createIntegrationBench(h); n += 1 })
afterEach(() => { i.executor.close(); h.executor.close(); h.bench.db.close() })

const branchName = () => `wave/ffr-${n}`
const change = (executionId: string, name: string) => h.executions.change(executionId, name)!
const passed = async (executionId: string, name: string) => {
  const real = h.tick
  h.tick = () => i.tick()
  try {
    return await passedChange(h, executionId, name)
  } finally {
    h.tick = real
  }
}

const REJECT = (): Promise<never> => Promise.reject(new Error('the read failed'))

/** Every A6 adapter surface, so the Retry's window can assert zero calls of every kind. */
const adapterSurfaces = (executionId: string) => ({
  merge: h.gh.merges.length,
  'update-branch': h.gh.updates.length,
  'fast-forward': i.refs.fastForwards.length,
  push: h.gh.pushes.length,
  'open-pr': h.gh.prCreates + h.gh.pulls.length,
  rerun: h.gh.reruns.length,
  'create-integration': i.refs.creates.length,
  provision: h.executions.effectsOf(executionId).filter(effect => effect.kind === 'provision').length,
})

/** The crash window: the dispatched process is gone, the row awaits its inspection. */
const crashRow = (effectId: string): void => {
  h.executions.markEffectRunning(effectId)
  h.executions.markRunningEffectsUnknown()
}

/** Three undecidable inspection passes over D14's backoffs exhaust into the production stop. */
const exhaustUnknown = async (executionId: string, name: string, effectId: string): Promise<void> => {
  const blocked = i.makeExecutor({ reads: { worktree: REJECT, localBranch: REJECT, remoteHead: REJECT, prList: REJECT, prView: REJECT, contains: REJECT, runAttempt: REJECT } })
  try {
    for (const step of [31_000, 121_000, 601_000]) {
      await i.tick(blocked)
      h.clock.now += step
    }
    await i.tick(blocked)
  } finally { blocked.close() }
  expect(h.executions.effect(effectId)).toMatchObject({ state: 'failed' })
  expect(change(executionId, name)).toMatchObject({ state: 'stopped', stopReason: 'effect-unknown' })
  expect(change(executionId, name)!.stopDetail?.effectId).toBe(effectId)
}

/**
 * The landing whose fast-forward was interrupted: the real row exists,
 * nothing moved. The stage converges one step per tick; the tick that
 * inserts the row runs it, and the dying adapter leaves it pending on the
 * first backoff.
 */
const interruptedFastForward = async (executionId: string, name: string): Promise<EffectRow> => {
  await passed(executionId, name)
  const dying = i.makeExecutor({ adapters: { 'fast-forward': { call: async () => ({ ok: false, error: { argv: ['gh', 'api', 'git/refs/heads/x'], exitCode: null, stderr: 'connection reset' } }) } } })
  try {
    for (let tick = 0; tick < 3 && h.executions.effectsOf(executionId).every(effect => effect.kind !== 'fast-forward'); tick++) {
      await i.tick(dying)
    }
    await i.tick(dying)
  } finally { dying.close() }
  expect(change(executionId, name)).toMatchObject({ state: 'landing', step: 'merging' })
  const rows = h.executions.effectsOf(executionId).filter(effect => effect.kind === 'fast-forward')
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ state: 'pending', tries: 1 })
  return rows[0]!
}

describe('fast-forward × Retry, decided by the real origin truth (table rows 14–15)', () => {
  test('a branch already at the candidate lands through the re-opened row; no adapter runs (row 14)', async () => {
    const branch = branchName()
    const name = `at${n}`
    const executionId = await startedIntegration(h, i, branch, [{ change: name }])
    const ff = await interruptedFastForward(executionId, name)
    crashRow(ff.id)
    await exhaustUnknown(executionId, name, ff.id)
    const commit = i.store.candidateOf(executionId, name)!.commitSha
    // GitHub applied the lost fast-forward: the branch already sits at the
    // candidate, so the inspection — never a re-run — records it done.
    git(['update-ref', `refs/heads/${branch}`, commit], matrix.origin)
    // The Retry's wake reaches the bench's default executor too; this window
    // is the integration executor's alone.
    h.executor.close()
    const before = adapterSurfaces(executionId)
    expect(await h.service.retry(h.bench.human, { executionId, change: name, commandId: `retry-at-${n}` })).toMatchObject({ ok: true })
    expect(h.executions.effect(ff.id)).toMatchObject({ state: 'unknown', tries: 0 })
    expect(change(executionId, name)).toMatchObject({ state: 'landing', step: 'merging' })
    await i.tick()
    expect(h.executions.effect(ff.id)).toMatchObject({ state: 'done', outcome: { fastForwarded: true, head: commit } })
    expect(adapterSurfaces(executionId)).toEqual(before)
    await i.tick()
    expect(adapterSurfaces(executionId)).toEqual(before)
    expect(change(executionId, name)).toMatchObject({ state: 'landed' })
    expect(i.store.candidateOf(executionId, name)).toMatchObject({ state: 'landed', commitSha: commit })
    expect(originHead(matrix, branch)).toBe(commit)
  }, 30_000)

  test('a branch moved past the candidate supersedes it and returns to the up-to-date step; no adapter runs (row 15)', async () => {
    const branch = branchName()
    const name = `past${n}`
    const executionId = await startedIntegration(h, i, branch, [{ change: name }])
    const ff = await interruptedFastForward(executionId, name)
    crashRow(ff.id)
    await exhaustUnknown(executionId, name, ff.id)
    // The owner moved the branch past the candidate while the row was live:
    // the inspection reads the refused outcome, and the follow-on applies
    // D6's moved rule — never a re-run.
    const moved = pushCommit(matrix, branch, `owner-${n}.txt`, 'owner\n')
    h.executor.close()
    const before = adapterSurfaces(executionId)
    expect(await h.service.retry(h.bench.human, { executionId, change: name, commandId: `retry-past-${n}` })).toMatchObject({ ok: true })
    expect(h.executions.effect(ff.id)).toMatchObject({ state: 'unknown', tries: 0 })
    expect(change(executionId, name)).toMatchObject({ state: 'landing', step: 'merging' })
    await i.tick()
    expect(h.executions.effect(ff.id)).toMatchObject({ state: 'done', outcome: { fastForwarded: false, refused: true, head: moved } })
    expect(adapterSurfaces(executionId)).toEqual(before)
    // The re-planned stage holds at its base read, so the moved rule's
    // up-to-date step stays observable after the verdict is applied.
    const real = h.landingAdapters.lsRemoteHead
    h.landingAdapters.lsRemoteHead = async () => { throw new Error('frozen for the verdict window') }
    try {
      await i.tick()
      expect(adapterSurfaces(executionId)).toEqual(before)
      expect(i.store.candidateOf(executionId, name)).toMatchObject({ state: 'superseded' })
      expect(change(executionId, name)).toMatchObject({ state: 'landing', step: 'up-to-date' })
    } finally {
      h.landingAdapters.lsRemoteHead = real
    }
  }, 30_000)
})

describe('afterLanded cancels the landed change\'s live landing-kind rows (A7, O1)', () => {
  test('a live landing-kind row of the change is cancelled; the settled row that landed it is untouched', async () => {
    const branch = branchName()
    const name = `o1-${n}`
    const executionId = await startedIntegration(h, i, branch, [{ change: name }])
    const commit = await passed(executionId, name)
    for (let tick = 0; tick < 4 && change(executionId, name).state !== 'landed'; tick++) await i.tick()
    expect(change(executionId, name)).toMatchObject({ state: 'landed' })
    const row = change(executionId, name)!
    const ffRow = h.executions.effectsOf(executionId).find(effect => effect.kind === 'fast-forward')!
    expect(ffRow).toMatchObject({ state: 'done' })
    // A crash window's leftover: a live landing-kind row of the change at
    // the moment the landing fact is written. The end-to-end window is
    // closed by the stage's pre-guards, so the backstop is pinned directly.
    const live = h.executions.insertEffect({
      executionId, change: name, roundId: null, kind: 'update-branch',
      effectKey: `${executionId}:${name}:update-branch:o1:0`,
      command: { repo: 'o/r', pr: 1, head: 'stale-head' },
    })
    h.executions.scheduleInspectionRetry(live.id, '2099-01-01T00:00:00.000Z', null)
    const deps: LandingDeps = {
      team: h.matrix.world.team, repo: h.matrix.world.repo, executions: h.executions,
      plans: h.bench.plans, results: h.results, plansService: h.plansService,
      conditionsOf: () => [], records: () => h.bench.records.values(),
      now: () => new Date(h.clock.now).toISOString(), revisionAttempt: async () => false,
      taskStatusOf: taskId => h.tasks.store.get(taskId)?.status ?? null,
    }
    await afterLanded(deps, row, executionId, commit)
    expect(h.executions.effect(live.id)).toMatchObject({ state: 'cancelled' })
    expect(h.executions.effect(ffRow.id)).toMatchObject({ state: 'done' })
  }, 30_000)
})
