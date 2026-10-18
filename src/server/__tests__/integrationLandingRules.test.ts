// Integration landing's rules (integration-candidates 4.1, 4.3-4.5) through
// the executor over a real bare origin: a carried round's candidate, outside
// commits, a branch moved by hand or a refused fast-forward, a rewritten
// branch and its Retry, restarts around the fast-forward, and the R15/R16
// failed-candidate cases.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import type { CiCheck } from '../../shared/planExecution'
import { STOP_REASON_LABELS } from '../../shared/planExecutionProgress'
import { createMatrixBench, createMatrixWorld, git, onOrigin, originHead, passedChange, pushCommit, removeMatrixWorld, type MatrixBench, type MatrixWorld } from './executionMatrixHarness'
import { createIntegrationBench, startedIntegration, type IntegrationBench } from './integrationMatrixHarness'

let matrix: MatrixWorld
let h: MatrixBench
let i: IntegrationBench
let n = 0

beforeAll(async () => { matrix = await createMatrixWorld('kawai-integration-rules-') })
afterAll(() => removeMatrixWorld(matrix))
beforeEach(() => {
  h = createMatrixBench(matrix)
  i = createIntegrationBench(h)
  n += 1
  // GitHub's branch update merges the integration branch (the PR's base), not master.
  h.gh.update = branch => {
    onOrigin(matrix, clone => {
      git(['checkout', '-q', branch], clone)
      git(['-c', 'user.email=gh@e', '-c', 'user.name=GitHub', 'merge', '-q', '--no-ff', '-m', 'Merge base into branch', `origin/${branchName()}`], clone)
      git(['push', '-q', 'origin', `HEAD:refs/heads/${branch}`], clone)
    })
  }
})
afterEach(() => { i.executor.close(); h.executor.close(); h.bench.db.close() })

const branchName = () => `wave/rules-${n}`
const change = (executionId: string, name: string) => h.executions.change(executionId, name)!
const pending = (): CiCheck[] => [{ name: 'ci', source: 'actions', conclusion: 'in_progress', link: null, runId: 78, startedAt: '2026-10-17T00:00:00.000Z', completedAt: null }]
const failing = (): CiCheck[] => [
  { name: 'ci', source: 'actions', conclusion: 'success', link: null, runId: 77, startedAt: '2026-10-17T00:00:00.000Z', completedAt: '2026-10-17T00:01:00.000Z' },
  { name: 'e2e', source: 'status', conclusion: 'failure', link: null, startedAt: null, completedAt: null },
]
const passed = async (executionId: string, name: string) => {
  const real = h.tick
  h.tick = () => i.tick()
  try {
    return await passedChange(h, executionId, name)
  } finally {
    h.tick = real
  }
}
/** Tick until the predicate holds (bounded); the clock moves so CI windows and backoffs advance. */
const until = async (predicate: () => boolean, ticks = 12) => {
  for (let tick = 0; tick < ticks && !predicate(); tick++) {
    await i.tick()
    h.clock.now += 60_000
  }
  expect(predicate()).toBe(true)
}
const landed = (executionId: string, name: string) => () => change(executionId, name).state === 'landed'
const candidates = () => i.store.candidates(h.matrix.world.team.teamId, branchName())

describe('candidates (4.1, D5)', () => {
  test('a change behind the integration head gets update-branch and a carried round; its candidate verifies on its own CI, never the landed one\'s (R16)', async () => {
    const executionId = await startedIntegration(h, i, branchName(), [{ change: `a${n}` }, { change: `b${n}` }])
    const commitA = await passed(executionId, `a${n}`)
    const commitB = await passed(executionId, `b${n}`)
    await until(landed(executionId, `a${n}`))
    // a's head has green CI; everything else now reads pending.
    h.gh.checks.set(commitA, h.gh.defaultChecks)
    h.gh.defaultChecks = pending()
    await until(() => candidates().some(candidate => candidate.change === `b${n}`))
    const verifying = candidates().find(candidate => candidate.change === `b${n}`)!
    expect(verifying.state).toBe('verifying')
    expect(verifying.baselineSha).toBe(commitA)
    expect(verifying.commitSha).not.toBe(commitB)
    expect(verifying.commitSha).not.toBe(commitA)
    expect(h.gh.updates.length).toBe(1)
    await i.tick()
    expect(i.store.candidate(verifying.id)!.state).toBe('verifying')
    h.gh.defaultChecks = [...h.gh.checks.get(commitA)!]
    await until(landed(executionId, `b${n}`))
    expect(i.store.candidate(verifying.id)!.state).toBe('landed')
    expect(originHead(matrix, branchName())).toBe(verifying.commitSha)
    // Back-to-back landings flag nothing.
    expect(candidates().every(candidate => candidate.outside === null)).toBe(true)
  })

  test('a commit the owner pushed is recorded as an outside commit on the next candidate', async () => {
    const executionId = await startedIntegration(h, i, branchName(), [{ change: `o${n}` }])
    await i.tick()
    const owner = pushCommit(matrix, branchName(), `owner-${n}.txt`, 'owner\n')
    await passed(executionId, `o${n}`)
    await until(landed(executionId, `o${n}`))
    const landedCandidate = candidates().find(candidate => candidate.state === 'landed')!
    // The recorded author, not a literal: a commit hook exports GIT_AUTHOR_NAME, which wins over -c user.name.
    const author = git(['log', '-1', '--format=%an', owner], matrix.origin).trim()
    expect(landedCandidate.outside).toEqual([{ sha: owner, author, subject: `commit owner-${n}.txt` }])
  })
})

describe('moved and rewritten branches (4.3, 4.5, D6)', () => {
  test('a branch moved during the fast-forward is refused (422): the candidate is superseded, the change keeps the slot, the next candidate flags the owner\'s commit', async () => {
    const executionId = await startedIntegration(h, i, branchName(), [{ change: `m${n}` }])
    await passed(executionId, `m${n}`)
    let owner = ''
    i.refs.beforeFastForward = () => {
      i.refs.beforeFastForward = null
      owner = pushCommit(matrix, branchName(), `hand-${n}.txt`, 'hand\n')
    }
    // The slot is kept: the branch update that follows runs while the change is still landing.
    const update = h.gh.update!
    const seen: string[] = []
    h.gh.update = (pr, head) => {
      seen.push(`${change(executionId, `m${n}`).state}/${candidates().map(candidate => candidate.state).join(',')}`)
      return update(pr, head)
    }
    await until(landed(executionId, `m${n}`))
    expect(seen).toEqual(['landing/superseded'])
    const last = candidates().find(candidate => candidate.state === 'landed')!
    expect(last.outside?.map(commit => commit.sha)).toEqual([owner])
    expect(i.refs.fastForwards.length).toBe(1)
  })

  test('a rewritten branch stops the change as integration-rewritten naming the head and the missing commit; Retry after a restore lands', async () => {
    const branch = branchName()
    const executionId = await startedIntegration(h, i, branch, [{ change: `r${n}` }, { change: `s${n}` }])
    const commitR = await passed(executionId, `r${n}`)
    await until(landed(executionId, `r${n}`))
    const created = i.store.branch(h.matrix.world.team.teamId, branch)!.createdSha
    git(['update-ref', `refs/heads/${branch}`, created], matrix.origin)
    await passed(executionId, `s${n}`)
    await until(() => change(executionId, `s${n}`).state === 'stopped')
    const stopped = change(executionId, `s${n}`)
    expect(stopped.stopReason).toBe('integration-rewritten')
    expect(stopped.stopDetail?.names).toEqual([created, commitR])
    expect(stopped.stopDetail?.message).toContain(created)
    expect(STOP_REASON_LABELS['integration-rewritten']).toBe('the integration branch was rewritten')
    git(['update-ref', `refs/heads/${branch}`, commitR], matrix.origin)
    const retried = await h.service.retry({ kind: 'human', team: h.matrix.world.team }, { executionId, change: `s${n}`, commandId: `retry-s-${n}` })
    expect(retried.ok).toBe(true)
    await until(landed(executionId, `s${n}`))
    expect(originHead(matrix, branch)).toBe(candidates().find(candidate => candidate.change === `s${n}` && candidate.state === 'landed')!.commitSha)
  })

  test('a restart after the fast-forward records the landing without moving the branch again', async () => {
    const executionId = await startedIntegration(h, i, branchName(), [{ change: `x${n}` }])
    const commit = await passed(executionId, `x${n}`)
    await crashAndRestart(executionId, () => git(['update-ref', `refs/heads/${branchName()}`, commit], matrix.origin))
    await until(landed(executionId, `x${n}`))
    expect(i.refs.fastForwards).toEqual([])
    expect(originHead(matrix, branchName())).toBe(commit)
  })

  test('a restart before the fast-forward runs it again', async () => {
    const executionId = await startedIntegration(h, i, branchName(), [{ change: `y${n}` }])
    const commit = await passed(executionId, `y${n}`)
    await crashAndRestart(executionId, () => {})
    await until(landed(executionId, `y${n}`))
    expect(i.refs.fastForwards.map(entry => entry.sha)).toEqual([commit])
  })
})

/**
 * The process dies inside the fast-forward call: an executor whose
 * fast-forward does `before` (GitHub moved the ref, or not yet) and never
 * returns. Then a fresh executor's startup inspects the unknown effect.
 */
async function crashAndRestart(executionId: string, before: () => void): Promise<void> {
  const running = () => h.executions.effectsOf(executionId).some(effect => effect.kind === 'fast-forward' && effect.state === 'running')
  const hung = i.makeExecutor({ adapters: { 'fast-forward': { call: () => { before(); return new Promise(() => {}) } } } })
  for (let tick = 0; tick < 8 && !running(); tick++) {
    hung.wake(h.matrix.world.team.teamId)
    await new Promise(resolve => setTimeout(resolve, 150))
  }
  expect(running()).toBe(true)
  hung.close()
  i.executor.close()
  i.executor = i.makeExecutor()
  await i.executor.startup()
}

describe('failed candidates (4.4, D7)', () => {
  test('R15: b fails once merged with a; the branch keeps a\'s candidate; b gets a fix attempt naming the checks', async () => {
    const executionId = await startedIntegration(h, i, branchName(), [{ change: `p${n}` }, { change: `q${n}` }])
    const commitP = await passed(executionId, `p${n}`)
    await passed(executionId, `q${n}`)
    await until(landed(executionId, `p${n}`))
    h.gh.checks.set(commitP, h.gh.defaultChecks)
    h.gh.defaultChecks = failing()
    await until(() => candidates().some(candidate => candidate.change === `q${n}` && candidate.state === 'failed'))
    expect(originHead(matrix, branchName())).toBe(commitP)
    expect(candidates().find(candidate => candidate.change === `p${n}`)!.state).toBe('landed')
    const row = change(executionId, `q${n}`)
    expect(row.state).toBe('implementing')
    const fix = h.tasks.store.assignmentsOf(row.taskId!).filter(entry => entry.handoffKind === 'fix').at(-1)!
    expect(h.mail.get(fix.messageId!)!.body).toContain('e2e')
  })
})

describe('a missing branch or record stops, never loops (review F1)', () => {
  const slots = () => h.bench.db.db.prepare('SELECT holder_id FROM plan_landing_slots WHERE team_id = ?').all(h.matrix.world.team.teamId)
  const stoppedAs = async (executionId: string, name: string) => {
    await until(() => change(executionId, name).state === 'stopped')
    const stopped = change(executionId, name)
    expect(stopped.stopReason).toBe('integration-rewritten')
    expect(slots()).toEqual([])
    return stopped
  }

  test('the branch deleted during the fast-forward (a live 422) stops the change naming the missing ref; the slot frees; Retry after a restore lands', async () => {
    const branch = branchName()
    const executionId = await startedIntegration(h, i, branch, [{ change: `d${n}` }])
    await passed(executionId, `d${n}`)
    const created = i.store.branch(h.matrix.world.team.teamId, branch)!.createdSha
    i.refs.beforeFastForward = () => {
      i.refs.beforeFastForward = null
      git(['update-ref', '-d', `refs/heads/${branch}`], matrix.origin)
    }
    const stopped = await stoppedAs(executionId, `d${n}`)
    expect(stopped.stopDetail?.names).toEqual([`refs/heads/${branch}`, created])
    expect(stopped.stopDetail?.message).toContain('missing on origin')
    git(['update-ref', `refs/heads/${branch}`, created], matrix.origin)
    expect((await h.service.retry({ kind: 'human', team: h.matrix.world.team }, { executionId, change: `d${n}`, commandId: `retry-d-${n}` })).ok).toBe(true)
    await until(landed(executionId, `d${n}`))
  })

  test('the branch deleted before a restart\'s inspection of the fast-forward stops the change as integration-rewritten', async () => {
    const branch = branchName()
    const executionId = await startedIntegration(h, i, branch, [{ change: `e${n}` }])
    await passed(executionId, `e${n}`)
    await crashAndRestart(executionId, () => git(['update-ref', '-d', `refs/heads/${branch}`], matrix.origin))
    const stopped = await stoppedAs(executionId, `e${n}`)
    expect(stopped.stopDetail?.names?.[0]).toBe(`refs/heads/${branch}`)
  })

  test('the branch missing when the change reaches the up-to-date step stops it there', async () => {
    const branch = branchName()
    const executionId = await startedIntegration(h, i, branch, [{ change: `u${n}` }])
    await i.tick()
    git(['update-ref', '-d', `refs/heads/${branch}`], matrix.origin)
    await passed(executionId, `u${n}`)
    const stopped = await stoppedAs(executionId, `u${n}`)
    expect(stopped.stopDetail?.names?.[0]).toBe(`refs/heads/${branch}`)
    expect(i.refs.fastForwards).toEqual([])
  })

  test('a branch record gone at the fast-forward\'s follow-on stops the change instead of returning to up-to-date', async () => {
    const branch = branchName()
    const executionId = await startedIntegration(h, i, branch, [{ change: `g${n}` }])
    await passed(executionId, `g${n}`)
    i.refs.beforeFastForward = () => {
      i.refs.beforeFastForward = null
      pushCommit(matrix, branch, `gone-${n}.txt`, 'gone\n')
      // The record and the creation outcome it could be rebuilt from are both gone.
      h.bench.db.db.prepare('DELETE FROM plan_integration_branches WHERE branch = ?').run(branch)
      h.bench.db.db.prepare(`UPDATE plan_execution_effects SET outcome_json = '{"created":false,"reused":true}' WHERE execution_id = ? AND kind = 'create-integration'`).run(executionId)
    }
    const stopped = await stoppedAs(executionId, `g${n}`)
    expect(stopped.stopDetail?.names).toEqual([`refs/heads/${branch}`])
    expect(stopped.stopDetail?.message).toContain('no creation record')
  })
})
