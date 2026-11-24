// Kawai accepts the authorizing round's own result after a landing
// (execution-landing-result-identity, oracle-binding.md): the production
// executor composition over a real bare origin, direct and integration-
// branch, where one round lands alone, two rounds name the same commit, a
// result is submitted while the merge runs, the merge is inspected after a
// restart, and the landing effect's round identity cannot be confirmed.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { logger } from '../logger'
import type { InspectorReads } from '../plans/execution/effectInspectors'
import {
  createMatrixBench, createMatrixWorld, originHead, removeMatrixWorld, review, startedExecution, submitWork,
  type MatrixBench, type MatrixWorld,
} from './executionMatrixHarness'
import { createIntegrationBench, startedIntegration, type IntegrationBench } from './integrationMatrixHarness'

let matrix: MatrixWorld
let h: MatrixBench
let i: IntegrationBench
let n = 0
let warn: ReturnType<typeof spyOn<typeof logger, 'warn'>>

beforeAll(async () => { matrix = await createMatrixWorld('kawai-landing-identity-') })
afterAll(() => removeMatrixWorld(matrix))
beforeEach(() => { h = createMatrixBench(matrix); i = createIntegrationBench(h); n += 1; warn = spyOn(logger, 'warn') })
afterEach(() => { warn.mockRestore(); i.executor.close(); h.executor.close(); h.bench.db.close() })

type Mechanism = 'direct' | 'integration'
const row = (executionId: string, change: string) => h.executions.change(executionId, change)!
const ticker = (mechanism: Mechanism) => (mechanism === 'direct' ? () => h.tick() : () => i.tick())

/** The task's acceptances as (result id, acceptor kind), in result order. */
const acceptances = (taskId: string) => h.tasks.store.results.listByTask(taskId)
  .filter(result => result.acceptedBy !== null).map(result => ({ id: result.id, by: result.acceptedBy!.kind }))
const identityRefusals = () => warn.mock.calls.filter(call => call[0] === 'plan_execution_accept_identity_refused')

/** A started execution of one change on the mechanism. */
async function started(mechanism: Mechanism, change: string): Promise<string> {
  return mechanism === 'direct' ? startedExecution(h, [{ change }]) : startedIntegration(h, i, `wave/id-${n}`, [{ change }])
}

/**
 * Two results on one commit: R1 opens round 1 on C; R2, submitted on the same
 * C before any verdict, supersedes it and opens round 2 on C. Round 2 passes.
 */
async function twoResultsOneCommit(mechanism: Mechanism, executionId: string, change: string): Promise<{ commit: string; r1: string; r2: string }> {
  const tick = ticker(mechanism)
  await tick()
  const commit = await submitWork(h, executionId, change, `src/${change}.ts`, `export const v${n} = 1\n`)
  await tick()
  const taskId = row(executionId, change).taskId!
  const r1 = h.executions.rounds(executionId, change).at(-1)!.resultId
  const r2 = (await h.results.submit(h.bench.agent('dev'), taskId, { summary: 'same commit again', commit, tests: [{ description: 'unit', outcome: 'pass' }] })).id
  await tick()
  const rounds = h.executions.rounds(executionId, change)
  expect(rounds.map(round => [round.resultId, round.commitSha, round.outcome])).toEqual([[r1, commit, 'superseded'], [r2, commit, null]])
  await review(h, executionId, change, 'pass')
  return { commit, r1, r2 }
}

/** One result on one commit, its round passed. */
async function oneResult(mechanism: Mechanism, executionId: string, change: string): Promise<{ commit: string; result: string }> {
  const tick = ticker(mechanism)
  await tick()
  const commit = await submitWork(h, executionId, change, `src/${change}.ts`, `export const v${n} = 1\n`)
  await tick()
  const result = h.executions.rounds(executionId, change).at(-1)!.resultId
  await review(h, executionId, change, 'pass')
  return { commit, result }
}

/** The landed change's single landing fact, Kawai's acceptance of `result` alone, the task done, no refusal. */
function acceptedAlone(executionId: string, change: string, result: string): void {
  expect(row(executionId, change).state).toBe('landed')
  const taskId = row(executionId, change).taskId!
  expect(acceptances(taskId)).toEqual([{ id: result, by: 'system' }])
  expect(h.tasks.store.get(taskId)!.status).toBe('done')
  expect(h.executions.landings(h.executions.execution(executionId)!.planId).filter(fact => fact.change === change)).toHaveLength(1)
  expect(identityRefusals()).toEqual([])
}

async function tickUntilLanded(mechanism: Mechanism, executionId: string, change: string, passes = 6): Promise<void> {
  const tick = ticker(mechanism)
  for (let pass = 0; pass < passes && row(executionId, change).state !== 'landed'; pass++) await tick()
}

/** The landing step's effect row: the merge (direct) or the fast-forward (integration). */
const landingEffect = (mechanism: Mechanism, executionId: string) =>
  h.executions.effectsOf(executionId).find(effect => effect.kind === (mechanism === 'direct' ? 'merge' : 'fast-forward'))!

/**
 * O9 through the composition: store-level corruption between authorization
 * and the follow-on makes the landing effect's round reference name no round,
 * while the same-commit rounds remain.
 */
async function missingRoundCase(mechanism: Mechanism): Promise<void> {
  const change = `o9${mechanism[0]}-${n}`
  const executionId = await started(mechanism, change)
  await twoResultsOneCommit(mechanism, executionId, change)
  const taskId = row(executionId, change).taskId!
  const statusBefore = h.tasks.store.get(taskId)!.status
  const rewrite = () => {
    const effect = landingEffect(mechanism, executionId)
    h.executions.db.prepare('UPDATE plan_execution_effects SET round_id = ? WHERE id = ?').run('round-missing', effect.id)
  }
  if (mechanism === 'direct') h.gh.beforeMerge = () => { h.gh.beforeMerge = null; rewrite() }
  else i.refs.beforeFastForward = () => { i.refs.beforeFastForward = null; rewrite() }
  await tickUntilLanded(mechanism, executionId, change)
  expect(row(executionId, change).state).toBe('landed')
  expect(h.executions.landings(h.executions.execution(executionId)!.planId)).toHaveLength(1)
  expect(acceptances(taskId)).toEqual([])
  expect(h.tasks.store.get(taskId)!.status).toBe(statusBefore)
  expect(identityRefusals()).toHaveLength(1)
  expect(identityRefusals()[0]![1]).toMatchObject({ executionId, change, roundId: 'round-missing', reason: 'round-missing' })
}

describe('production composition: the authorizing round decides', () => {
  // @covers: plan-landing › Kawai accepts the authorizing round's own result › Two results share the landed commit
  test('O2 direct: the later same-commit round lands and its result R2 is accepted by Kawai; R1 stays unaccepted', async () => {
    const change = `o2-${n}`
    const executionId = await started('direct', change)
    const { commit, r1, r2 } = await twoResultsOneCommit('direct', executionId, change)
    await tickUntilLanded('direct', executionId, change)
    expect(row(executionId, change).state).toBe('landed')
    expect(h.gh.merges.at(-1)!.head).toBe(commit)
    expect(landingEffect('direct', executionId).roundId).toBe(h.executions.rounds(executionId, change)[1]!.id)
    const taskId = row(executionId, change).taskId!
    expect(acceptances(taskId)).toEqual([{ id: r2, by: 'system' }])
    expect(acceptances(taskId).some(entry => entry.id === r1)).toBe(false)
    expect(h.tasks.store.get(taskId)!.status).toBe('done')
    expect(h.executions.landings(h.executions.execution(executionId)!.planId)).toHaveLength(1)
    expect(identityRefusals()).toEqual([])
  }, 30_000)

  // @covers: plan-landing › Kawai accepts the authorizing round's own result › Integration-branch landing names the same result
  test('O3 integration: the later same-commit round fast-forwards and its result R2 is accepted by Kawai; R1 stays unaccepted', async () => {
    const change = `o3-${n}`
    const executionId = await started('integration', change)
    const { commit, r1, r2 } = await twoResultsOneCommit('integration', executionId, change)
    await tickUntilLanded('integration', executionId, change)
    expect(row(executionId, change).state).toBe('landed')
    expect(originHead(matrix, `wave/id-${n}`)).toBe(commit)
    expect(landingEffect('integration', executionId).roundId).toBe(h.executions.rounds(executionId, change)[1]!.id)
    const taskId = row(executionId, change).taskId!
    expect(acceptances(taskId)).toEqual([{ id: r2, by: 'system' }])
    expect(acceptances(taskId).some(entry => entry.id === r1)).toBe(false)
    expect(h.tasks.store.get(taskId)!.status).toBe('done')
    expect(h.executions.landings(h.executions.execution(executionId)!.planId)).toHaveLength(1)
    expect(identityRefusals()).toEqual([])
  }, 30_000)

  // @covers: plan-landing › Kawai accepts the authorizing round's own result › The authorizing round cannot be confirmed
  test('O9 direct: a merge effect naming a missing round lands the change, accepts nothing, keeps the task open and logs the refusal', async () => {
    await missingRoundCase('direct')
  }, 30_000)

  // @covers: plan-landing › Kawai accepts the authorizing round's own result › The authorizing round cannot be confirmed
  test('O9 integration: a fast-forward effect naming a missing round lands the change, accepts nothing, keeps the task open and logs the refusal', async () => {
    await missingRoundCase('integration')
  }, 30_000)

  // @covers: plan-landing › Kawai accepts the authorizing round's own result › Two results share the landed commit
  test('O1 direct: a single passed round lands and Kawai accepts its result', async () => {
    const change = `o1-${n}`
    const executionId = await started('direct', change)
    const { commit, result } = await oneResult('direct', executionId, change)
    await tickUntilLanded('direct', executionId, change)
    expect(h.gh.merges.at(-1)!.head).toBe(commit)
    acceptedAlone(executionId, change, result)
  }, 30_000)

  // @covers: plan-landing › Kawai accepts the authorizing round's own result › Integration-branch landing names the same result
  test('integration without siblings: a single passed round fast-forwards and Kawai accepts its result', async () => {
    const change = `oi-${n}`
    const executionId = await started('integration', change)
    const { commit, result } = await oneResult('integration', executionId, change)
    await tickUntilLanded('integration', executionId, change)
    expect(originHead(matrix, `wave/id-${n}`)).toBe(commit)
    acceptedAlone(executionId, change, result)
  }, 30_000)

  // @covers: plan-landing › Kawai accepts the authorizing round's own result › A result submitted while the merge runs
  test('O6 direct: a result submitted on the same commit while the merge runs stays unaccepted; the authorizing result is accepted', async () => {
    const change = `o6-${n}`
    const executionId = await started('direct', change)
    const { commit, result } = await oneResult('direct', executionId, change)
    const taskId = row(executionId, change).taskId!
    let late = ''
    let refused = ''
    h.gh.beforeMerge = async () => {
      h.gh.beforeMerge = null
      // The result service refuses a submission while Kawai writes the branch,
      // so the result submitted after the merge started is written at the
      // store level, as a submission would write it, with no round.
      await h.results.submit(h.bench.agent('dev'), taskId, { summary: 'late', commit, tests: [{ description: 'unit', outcome: 'pass' }] })
        .catch(error => { refused = String(error) })
      const task = h.tasks.store.get(taskId)!
      late = h.tasks.store.results.insert({
        teamId: task.teamId, taskId, summary: 'late', commit, diff: null, worktree: null, tests: [{ description: 'unit', outcome: 'pass' }],
        limitations: null, coverage: null, taskRevision: task.revision, submittedBy: { kind: 'agent', sessionId: 'dev' },
      }).id
    }
    await tickUntilLanded('direct', executionId, change)
    expect(refused).toContain("Kawai is writing the change's branch (merging)")
    expect(late).not.toBe('')
    expect(h.executions.rounds(executionId, change).some(entry => entry.resultId === late)).toBe(false)
    expect(h.tasks.store.results.listByTask(taskId).map(entry => entry.id)).toContain(late)
    acceptedAlone(executionId, change, result)
  }, 30_000)

  // @covers: plan-landing › Kawai accepts the authorizing round's own result › The follow-on is replayed
  // @covers: plan-landing › Kawai accepts the authorizing round's own result › Two results share the landed commit
  test('O16 direct: after a restart with the merge effect running, the inspection lands the later same-commit round and Kawai accepts R2 once', async () => {
    const change = `o16-${n}`
    const executionId = await started('direct', change)
    const { r2 } = await twoResultsOneCommit('direct', executionId, change)
    const dying = h.makeExecutor({ adapters: { merge: { call: async () => ({ ok: false, error: { argv: ['gh', 'pr', 'merge'], exitCode: null, stderr: 'connection reset' } }) } } })
    try { await h.tick(dying); await h.tick(dying) } finally { dying.close() }
    expect(row(executionId, change)).toMatchObject({ state: 'landing', step: 'merging' })
    const merge = landingEffect('direct', executionId)
    h.executions.db.prepare(`UPDATE plan_execution_effects SET command_json = json_set(command_json, '$.repo', 'example/kawai') WHERE id = ?`).run(merge.id)
    // The crash: the dispatched merge was running; at startup it is unknown and awaits its inspection.
    h.executions.markEffectRunning(merge.id)
    h.executions.markRunningEffectsUnknown()
    h.clock.now += 31_000
    // GitHub merged the pull request before the crash.
    const command = h.executions.effect(merge.id)!.command as { pr: number; head: string }
    expect(await h.landingAdapters.prMerge('example/kawai', command.pr, 'merge', command.head)).toMatchObject({ ok: true })
    const landing = h.landingAdapters
    const reads: InspectorReads = {
      worktree: async () => ({ present: true, head: null }), localBranch: async () => null, remoteHead: async () => null, prList: async () => [],
      prView: async (repo, pr) => { const view = await landing.prView(repo, pr); if (!view.ok) throw new Error('unreadable'); return view.data },
      contains: async () => false, runAttempt: async () => 1,
    }
    const inspector = h.makeExecutor({ reads })
    try { await h.tick(inspector) } finally { inspector.close() }
    expect(h.executions.effect(merge.id)).toMatchObject({ state: 'done', outcome: { merged: true } })
    await tickUntilLanded('direct', executionId, change)
    expect(h.gh.merges).toHaveLength(1)
    expect(merge.roundId).toBe(h.executions.rounds(executionId, change)[1]!.id)
    acceptedAlone(executionId, change, r2)
    expect(h.tasks.store.journal(row(executionId, change).taskId!).filter(entry => entry.text.startsWith('Accepted result'))).toHaveLength(1)
  }, 30_000)
})
