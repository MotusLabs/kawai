// Integration landing (integration-candidates 3.3, 4.1-4.3) through the
// executor over a real bare origin: the create-integration effect before
// any provision, reuse, recreation, its 422 read-back and failures, Retry;
// exact candidates, the non-forced fast-forward and its landing fact,
// dependents provisioned from the new integration head; a branch moved by
// hand, a refused fast-forward, and a rewritten branch.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { createMatrixBench, createMatrixWorld, git, originHead, passedChange, pushCommit, removeMatrixWorld, type MatrixBench, type MatrixWorld } from './executionMatrixHarness'
import { createIntegrationBench, startedIntegration, type IntegrationBench } from './integrationMatrixHarness'
import { candidatePromoted, promotedThrough } from '../../shared/planIntegration'

let matrix: MatrixWorld
let h: MatrixBench
let i: IntegrationBench
let n = 0

beforeAll(async () => { matrix = await createMatrixWorld('kawai-integration-landing-') })
afterAll(() => removeMatrixWorld(matrix))
beforeEach(() => { h = createMatrixBench(matrix); i = createIntegrationBench(h); n += 1 })
afterEach(() => { i.executor.close(); h.executor.close(); h.bench.db.close() })

const branchName = () => `wave/int-${n}`
const change = (executionId: string, name: string) => h.executions.change(executionId, name)!
const setup = (executionId: string) => h.executions.effectsOf(executionId).filter(effect => effect.change === null)
/** Provision, implement, CI, review pass — through the integration executor. */
const passed = async (executionId: string, name: string) => {
  const real = h.tick
  h.tick = () => i.tick()
  try {
    return await passedChange(h, executionId, name)
  } finally {
    h.tick = real
  }
}

describe('create-integration (3.3, D4)', () => {
  test('the first execution creates the branch at the default head before any provision effect runs', async () => {
    const branch = branchName()
    const executionId = await startedIntegration(h, i, branch, [{ change: `api${n}` }])
    const master = originHead(matrix, 'master')!
    expect(setup(executionId).map(effect => effect.effectKey)).toEqual([`${executionId}::create-integration:1`])
    await i.tick()
    expect(i.refs.creates).toEqual([{ branch, sha: master }])
    expect(originHead(matrix, branch)).toBe(master)
    const created = setup(executionId)[0]!
    const provision = h.executions.effectsOf(executionId).find(effect => effect.kind === 'provision')!
    expect(created.finishedAt! <= provision.startedAt!).toBe(true)
    const record = i.store.branch(h.matrix.world.team.teamId, branch)!
    expect(record).toMatchObject({ planId: h.executions.execution(executionId)!.planId, targetBranch: 'master', createdBy: executionId, createdSha: master })
    // The worktree starts from the integration head (D2).
    expect(change(executionId, `api${n}`).baselineCommit).toBe(master)
  })

  test('a later execution reuses the branch at its head: no create effect', async () => {
    const branch = branchName()
    const first = await startedIntegration(h, i, branch, [{ change: `one${n}` }])
    await i.tick()
    const moved = pushCommit(matrix, branch, `owner-${n}.txt`, 'owner\n')
    h.executions.finishExecution(first, 'stopped')
    const second = await startedIntegration(h, i, branch, [{ change: `two${n}` }])
    expect(setup(second)).toEqual([])
    await i.tick()
    expect(i.refs.creates.length).toBe(1)
    expect(change(second, `two${n}`).baselineCommit).toBe(moved)
  })

  test('a creation again keeps the record and updates its creation fields', async () => {
    const branch = branchName()
    const first = await startedIntegration(h, i, branch, [{ change: `a${n}` }])
    await i.tick()
    const before = i.store.branch(h.matrix.world.team.teamId, branch)!
    h.executions.finishExecution(first, 'stopped')
    git(['update-ref', '-d', `refs/heads/${branch}`], matrix.origin)
    pushCommit(matrix, 'master', `next-${n}.txt`, 'next\n')
    h.clock.now += 60_000
    const second = await startedIntegration(h, i, branch, [{ change: `b${n}` }])
    await i.tick()
    const after = i.store.branch(h.matrix.world.team.teamId, branch)!
    expect(after.createdBy).toBe(second)
    expect(after.createdSha).toBe(originHead(matrix, 'master')!)
    expect(after.createdSha).not.toBe(before.createdSha)
  })

  test('a 422 for a ref at the requested commit is our own lost success', async () => {
    const branch = branchName()
    const executionId = await startedIntegration(h, i, branch, [{ change: `lost${n}` }])
    git(['update-ref', `refs/heads/${branch}`, originHead(matrix, 'master')!], matrix.origin)
    await i.tick()
    expect(setup(executionId)[0]!.state).toBe('done')
    expect(i.store.branch(h.matrix.world.team.teamId, branch)?.createdBy).toBe(executionId)
    expect(change(executionId, `lost${n}`).state).toBe('implementing')
  })

  test('a foreign ref stops every waiting change as effect-failed, naming the branch', async () => {
    const branch = branchName()
    const executionId = await startedIntegration(h, i, branch, [{ change: `x${n}` }, { change: `y${n}` }])
    pushCommit(matrix, 'master', `f-${n}.txt`, 'f\n')
    const foreign = pushCommit(matrix, 'master', `g-${n}.txt`, 'g\n')
    git(['update-ref', `refs/heads/${branch}`, foreign], matrix.origin)
    await i.tick()
    for (const name of [`x${n}`, `y${n}`]) {
      const row = change(executionId, name)
      expect(row.state).toBe('stopped')
      expect(row.stopReason).toBe('effect-failed')
      expect(row.stopDetail?.message).toContain(branch)
      expect(row.stopDetail?.resumeState).toBe('waiting')
    }
    expect(h.executions.effectsOf(executionId).some(effect => effect.kind === 'provision')).toBe(false)
  })

  test('three transient failures stop as effect-failed; the first Retry creates the branch and the others find it', async () => {
    const branch = branchName()
    const executionId = await startedIntegration(h, i, branch, [{ change: `p${n}` }, { change: `q${n}` }])
    i.refs.createTransient = 4
    for (let attempt = 0; attempt < 4; attempt++) {
      await i.tick()
      h.clock.now += 3_600_000
    }
    expect(change(executionId, `p${n}`).stopReason).toBe('effect-failed')
    expect(change(executionId, `q${n}`).stopReason).toBe('effect-failed')
    expect(setup(executionId)[0]!.state).toBe('failed')
    i.refs.createTransient = 0
    const retried = await h.service.retry({ kind: 'human', team: h.matrix.world.team }, { executionId, change: `p${n}`, commandId: `retry-p-${n}` })
    expect(retried.ok).toBe(true)
    expect(change(executionId, `p${n}`).state).toBe('waiting')
    await i.tick()
    expect(setup(executionId).map(effect => [effect.effectKey, effect.state])).toEqual([
      [`${executionId}::create-integration:1`, 'failed'], [`${executionId}::create-integration:2`, 'done'],
    ])
    expect(originHead(matrix, branch)).not.toBeNull()
    expect(change(executionId, `p${n}`).state).toBe('implementing')
    await h.service.retry({ kind: 'human', team: h.matrix.world.team }, { executionId, change: `q${n}`, commandId: `retry-q-${n}` })
    await i.tick()
    expect(setup(executionId).length).toBe(2)
    expect(change(executionId, `q${n}`).state).toBe('implementing')
  })
})

describe('increments (4.1, 4.2, D5)', () => {
  test('an up-to-date change lands by fast-forward: the head is C, the fact is exact, the task done, the dependent provisions from it', async () => {
    const branch = branchName()
    const executionId = await startedIntegration(h, i, branch, [{ change: `core${n}` }, { change: `ui${n}`, dependsOn: [`core${n}`] }])
    const commit = await passed(executionId, `core${n}`)
    await i.tick()
    await i.tick()
    expect(originHead(matrix, branch)).toBe(commit)
    expect(originHead(matrix, 'master')).not.toBe(commit)
    const candidate = i.store.candidateOf(executionId, `core${n}`)!
    expect(candidate).toMatchObject({ state: 'landed', commitSha: commit, outside: null })
    const fact = h.executions.landings(h.executions.execution(executionId)!.planId).find(entry => entry.change === `core${n}`)!
    expect(fact).toMatchObject({ mechanism: 'integration-branch', headSha: commit, mergeSha: commit, treeVerified: true, postCi: null })
    expect(fact.baseSha).toBe(candidate.baselineSha)
    expect(h.tasks.store.get(change(executionId, `core${n}`).taskId!)!.status).toBe('done')
    expect(h.gh.merges).toEqual([])
    expect(change(executionId, `ui${n}`).baselineCommit).toBe(commit)
  })

  test('the plan completes on the last landing and shows as not yet promoted', async () => {
    const branch = branchName()
    const executionId = await startedIntegration(h, i, branch, [{ change: `last${n}` }])
    await passed(executionId, `last${n}`)
    for (let tick = 0; tick < 4 && change(executionId, `last${n}`).state !== 'landed'; tick++) await i.tick()
    const planId = h.executions.execution(executionId)!.planId
    expect(h.executions.execution(executionId)).toMatchObject({ state: 'finished', outcome: 'completed' })
    expect(h.bench.plans.get(planId)!.lifecycle).toBe('completed')
    const landed = i.store.candidateOf(executionId, `last${n}`)!
    expect(landed.state).toBe('landed')
    expect(candidatePromoted(landed, promotedThrough(i.store.promotionsOf(planId)))).toBe(false)
  })
})

describe('create-integration recovery (3.3, D6 table)', () => {
  test('a restart after GitHub created the ref records the creation and provisions; one creation only', async () => {
    const branch = branchName()
    const executionId = await startedIntegration(h, i, branch, [{ change: `rc${n}` }])
    const sha = String(setup(executionId)[0]!.command.sha)
    const running = () => setup(executionId)[0]!.state === 'running'
    const hung = i.makeExecutor({ adapters: { 'create-integration': { call: () => {
      git(['update-ref', `refs/heads/${branch}`, sha], matrix.origin)
      return new Promise(() => {})
    } } } })
    for (let tick = 0; tick < 8 && !running(); tick++) {
      hung.wake(h.matrix.world.team.teamId)
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    expect(running()).toBe(true)
    hung.close()
    i.executor.close()
    i.executor = i.makeExecutor()
    await i.executor.startup()
    expect(setup(executionId)[0]!.state).toBe('done')
    expect(i.store.branch(h.matrix.world.team.teamId, branch)).toMatchObject({ createdBy: executionId, createdSha: sha })
    await i.tick()
    expect(change(executionId, `rc${n}`).state).toBe('implementing')
    expect(i.refs.creates).toEqual([])
  })

  test('a restart that finds a foreign ref stops every waiting change as effect-failed', async () => {
    const branch = branchName()
    const executionId = await startedIntegration(h, i, branch, [{ change: `rf${n}` }])
    const foreign = pushCommit(matrix, 'master', `rf-${n}.txt`, 'rf\n')
    h.executions.markEffectRunning(setup(executionId)[0]!.id)
    git(['update-ref', `refs/heads/${branch}`, foreign], matrix.origin)
    await i.executor.startup()
    expect(setup(executionId)[0]!.state).toBe('failed')
    expect(change(executionId, `rf${n}`)).toMatchObject({ state: 'stopped', stopReason: 'effect-failed' })
    expect(change(executionId, `rf${n}`).stopDetail?.message).toContain('foreign-branch')
  })
})
