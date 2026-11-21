// Kawai accepts the authorizing round's own result after a landing
// (execution-landing-result-identity, oracle-binding.md): the production
// executor composition over a real bare origin, direct and integration-
// branch, where two rounds name the same commit, a result is submitted while
// the merge runs, the merge is inspected after a restart, and the landing
// effect's round identity cannot be confirmed.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { logger } from '../logger'
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
})
