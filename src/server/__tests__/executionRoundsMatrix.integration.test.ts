// The round matrix (plan-execution §12.2-12.4, §13.3; rev 5 B5) over a real
// bare origin and the scripted GitHub of the matrix harness: the push and
// PR rules (reuse across rounds, the implementer's own push, a moved branch
// stopping as effect-failed), CI driven through pending, failed, rerun, and
// passed — flaky marked in the view — and both timeouts, the release step's
// unscoped and human-session cases, and one stop-and-Retry per reason.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { executionViewReads, executionViews } from '../plans/execution/executionView'
import { CI_MISSING_AFTER_MS, CI_TIMEOUT_MS } from '../../shared/planExecutionGates'
import type { CiCheck } from '../../shared/planExecution'
import {
  createMatrixBench, createMatrixWorld, git, onOrigin, originHead, pushCommit, removeMatrixWorld, review, startedExecution, submitWork,
  type MatrixBench, type MatrixWorld,
} from './executionMatrixHarness'

let matrix: MatrixWorld
let h: MatrixBench

beforeAll(async () => { matrix = await createMatrixWorld('kawai-rounds-matrix-') })
afterAll(() => removeMatrixWorld(matrix))
beforeEach(() => { h = createMatrixBench(matrix) })
afterEach(() => { h.executor.close(); h.bench.db.close() })

const run = (name: string, conclusion: string, runId: number, startedAt: string, completedAt: string | null): CiCheck =>
  ({ name, source: 'actions', conclusion, link: `https://example.internal/runs/${runId}`, runId, startedAt, completedAt })
const e2e = (conclusion = 'success'): CiCheck => ({ name: 'e2e', source: 'status', conclusion, link: null, startedAt: null, completedAt: null })
const view = (executionId: string, change: string) => {
  const planId = h.executions.execution(executionId)!.planId
  return executionViews(h.executions, planId, executionViewReads(h.bench.plans, h.bench.db.db))
    .find(entry => entry.id === executionId)!.changes.find(entry => entry.change === change)!
}

describe('push and pull request (12.2)', () => {
  test('one PR across rounds; the implementer\'s own push is accepted without a Kawai push', async () => {
    const executionId = await startedExecution(h, [{ change: 'pr-a' }])
    await h.tick()
    const first = await submitWork(h, executionId, 'pr-a', 'src/a.ts', '1\n')
    await h.tick()
    expect(originHead(matrix, 'pr-a')).toBe(first)
    expect(h.gh.pushes).toEqual([`pr-a@${first}`])
    await review(h, executionId, 'pr-a', 'fail', 'rev1', 'needs work')
    await h.tick()
    // The fix round: the implementer pushes it itself; Kawai pushes nothing.
    const second = await submitWork(h, executionId, 'pr-a', 'src/a.ts', '2\n', { push: true })
    await h.tick()
    expect(originHead(matrix, 'pr-a')).toBe(second)
    expect(h.gh.pushes).toEqual([`pr-a@${first}`])
    const pushes = h.executions.effectsOf(executionId).filter(effect => effect.kind === 'push')
    expect(pushes.map(effect => (effect.outcome as { pushedByKawai: boolean }).pushedByKawai)).toEqual([true, false])
    // The change's one pull request, reused by the second round.
    expect(h.gh.prCreates).toBe(1)
    expect(h.executions.rounds(executionId, 'pr-a').map(round => round.pushedAt !== null)).toEqual([true, true])
    expect(h.executions.change(executionId, 'pr-a')!.prNumber).toBe(h.gh.pulls[0]!.number)
  })

  test('a branch moved on origin by someone else stops the change as effect-failed, never forced', async () => {
    const executionId = await startedExecution(h, [{ change: 'pr-b' }])
    await h.tick()
    const row = h.executions.change(executionId, 'pr-b')!
    // Someone else pushes to the change's branch first (not an ancestor of the result).
    const foreign = pushCommit(matrix, 'master', 'foreign.txt', 'x\n')
    const { spawnSync } = await import('node:child_process')
    const { cleanGitEnv } = await import('../git/gitCommand')
    spawnSync('git', ['update-ref', `refs/heads/${row.branch}`, foreign], { cwd: matrix.origin, env: cleanGitEnv() })
    const commit = await (async () => {
      // The result's own commit is on the local branch only; the check refuses
      // a result behind origin, so the move lands between submit and push.
      spawnSync('git', ['update-ref', '-d', `refs/heads/${row.branch}`], { cwd: matrix.origin, env: cleanGitEnv() })
      const sha = await submitWork(h, executionId, 'pr-b', 'src/b.ts', 'b\n')
      spawnSync('git', ['update-ref', `refs/heads/${row.branch}`, foreign], { cwd: matrix.origin, env: cleanGitEnv() })
      return sha
    })()
    await h.tick()
    const stopped = h.executions.change(executionId, 'pr-b')!
    expect(stopped).toMatchObject({ state: 'stopped', stopReason: 'effect-failed' })
    expect(stopped.stopDetail?.message ?? '').toMatch(/rejected|non-fast-forward|fetch first/)
    // origin keeps the foreign head: nothing was forced.
    expect(originHead(matrix, row.branch!)).toBe(foreign)
    expect(originHead(matrix, row.branch!)).not.toBe(commit)
  })
})

describe('CI through the stub (12.3)', () => {
  test('pending, failed, the one rerun, then passed: the round passes with the name marked flaky', async () => {
    const executionId = await startedExecution(h, [{ change: 'ci-a' }])
    await h.tick()
    const commit = await submitWork(h, executionId, 'ci-a', 'src/c.ts', 'c\n')
    h.gh.checks.set(commit, [run('ci', 'in_progress', 31, '2026-10-17T00:00:00.000Z', null), e2e()])
    await h.tick()
    expect(view(executionId, 'ci-a').waiting).toEqual({ kind: 'ci', pending: ['ci'] })
    expect(view(executionId, 'ci-a').latestRound!.ci!.state).toBe('pending')
    h.gh.checks.set(commit, [run('ci', 'failure', 31, '2026-10-17T00:00:00.000Z', '2026-10-17T00:01:00.000Z'), e2e()])
    await h.tick()
    expect(h.gh.reruns).toEqual([31])
    // The rerun is under way: its old failure waits for the new run.
    h.gh.checks.set(commit, [run('ci', 'failure', 31, '2026-10-17T00:00:00.000Z', '2026-10-17T00:01:00.000Z'), e2e()])
    await h.tick()
    expect(h.executions.change(executionId, 'ci-a')!.state).toBe('gating')
    expect(h.executions.rounds(executionId, 'ci-a').at(-1)!.reviewAssignmentId).toBeNull()
    h.gh.checks.set(commit, [
      run('ci', 'failure', 31, '2026-10-17T00:00:00.000Z', '2026-10-17T00:01:00.000Z'),
      run('ci', 'success', 31, '2099-01-01T00:00:00.000Z', '2099-01-01T00:01:00.000Z'),
      e2e(),
    ])
    await h.tick()
    expect(h.gh.reruns).toEqual([31])
    expect(h.executions.rounds(executionId, 'ci-a').at(-1)!.reviewAssignmentId).not.toBeNull()
    expect(view(executionId, 'ci-a').latestRound!.ci).toMatchObject({ state: 'pass', flaky: ['ci'] })
  })

  test('a failure after the rerun fails the round; a non-rerunnable failure fails at once', async () => {
    const executionId = await startedExecution(h, [{ change: 'ci-b' }])
    await h.tick()
    const commit = await submitWork(h, executionId, 'ci-b', 'src/c.ts', 'c\n')
    h.gh.checks.set(commit, [run('ci', 'failure', 41, '2026-10-17T00:00:00.000Z', '2026-10-17T00:01:00.000Z'), e2e()])
    await h.tick()
    h.gh.checks.set(commit, [
      run('ci', 'failure', 41, '2026-10-17T00:00:00.000Z', '2026-10-17T00:01:00.000Z'),
      run('ci', 'failure', 41, '2099-01-01T00:00:00.000Z', '2099-01-01T00:01:00.000Z'),
      e2e(),
    ])
    await h.tick()
    const failed = h.executions.rounds(executionId, 'ci-b')[0]!
    expect(failed.outcome).toBe('fail')
    expect(failed.reviewAssignmentId).toBeNull()
    // The failed implement round dispatches a fix attempt (it never counts).
    expect(h.executions.change(executionId, 'ci-b')).toMatchObject({ state: 'implementing', fixRounds: 0 })
    const fix = await submitWork(h, executionId, 'ci-b', 'src/c.ts', 'd\n')
    h.gh.checks.set(fix, [run('ci', 'success', 42, '2026-10-17T00:00:00.000Z', '2026-10-17T00:01:00.000Z'), e2e('failure')])
    await h.tick()
    expect(h.gh.reruns).toEqual([41])
    expect(h.executions.rounds(executionId, 'ci-b').at(-1)!.outcome).toBe('fail')
  })

  test('no checks within 30 minutes stops as ci-missing; pending past 3 hours stops as ci-timeout; Retry reopens the window', async () => {
    const executionId = await startedExecution(h, [{ change: 'ci-c' }])
    await h.tick()
    const commit = await submitWork(h, executionId, 'ci-c', 'src/c.ts', 'c\n')
    h.gh.checks.set(commit, [])
    await h.tick()
    h.clock.now += CI_MISSING_AFTER_MS - 1000
    await h.tick()
    expect(h.executions.change(executionId, 'ci-c')!.state).toBe('gating')
    h.clock.now += 2000
    await h.tick()
    expect(h.executions.change(executionId, 'ci-c')).toMatchObject({ state: 'stopped', stopReason: 'ci-missing' })
    expect(view(executionId, 'ci-c').latestRound!.ci!.state).toBe('stopped')

    // Retry reopens the window (from the real now), checks arrive and hang.
    await h.service.retry(h.bench.human, { executionId, change: 'ci-c', commandId: 'retry-ci-c' })
    h.clock.now = Date.now()
    h.gh.checks.set(commit, [run('ci', 'queued', 51, '2026-10-17T00:00:00.000Z', null), e2e()])
    await h.tick()
    expect(h.executions.change(executionId, 'ci-c')!.state).toBe('gating')
    h.clock.now += CI_TIMEOUT_MS + 1000
    await h.tick()
    const stopped = h.executions.change(executionId, 'ci-c')!
    expect(stopped).toMatchObject({ state: 'stopped', stopReason: 'ci-timeout' })
    expect(stopped.stopDetail?.checks).toEqual(['ci'])
  })
})

describe('release before review (12.4)', () => {
  test('an unscoped review group leaves the implementer working; a human-created session is never released', async () => {
    const released: string[] = []
    const executor = h.makeExecutor({
      releases: { readiness: () => ({ ready: true, reason: null }), release: id => { released.push(id); return { ok: true } }, pendingSpawns: () => [] },
      groupScoped: (_team, group) => group !== 'reviewers',
    })
    try {
      const executionId = await startedExecution(h, [{ change: 'rl-a' }])
      await h.tick(executor)
      const worktree = h.executions.change(executionId, 'rl-a')!.worktree!
      h.bench.records.set('dev', { ...h.bench.records.get('dev')!, projectPath: worktree, spawned: true })
      await submitWork(h, executionId, 'rl-a', 'src/r.ts', 'r\n')
      await h.tick(executor)
      expect(h.executions.change(executionId, 'rl-a')!.step).toBe('reviewing')
      expect(released).toEqual([])

      // Scoped now, but the session in the worktree was created by the human.
      const scoped = h.makeExecutor({
        releases: { readiness: () => ({ ready: true, reason: null }), release: id => { released.push(id); return { ok: true } }, pendingSpawns: () => [] },
        groupScoped: () => true,
      })
      try {
        const second = await startedExecution(h, [{ change: 'rl-b' }])
        await h.tick(scoped)
        const tree = h.executions.change(second, 'rl-b')!.worktree!
        h.bench.records.set('dev', { ...h.bench.records.get('dev')!, projectPath: tree, spawned: false })
        await submitWork(h, second, 'rl-b', 'src/r.ts', 'r\n')
        await h.tick(scoped)
        expect(h.executions.change(second, 'rl-b')!.step).toBe('reviewing')
        expect(released).toEqual([])
      } finally {
        scoped.close()
      }
    } finally {
      executor.close()
    }
  })

  test('a refused release holds the step at releasing with its error (N3)', async () => {
    const executor = h.makeExecutor({
      releases: { readiness: () => ({ ready: true, reason: null }), release: () => ({ ok: false, error: 'archive refused: pending approval' }), pendingSpawns: () => [] },
      groupScoped: () => true,
    })
    try {
      const executionId = await startedExecution(h, [{ change: 'rl-c' }])
      await h.tick(executor)
      const worktree = h.executions.change(executionId, 'rl-c')!.worktree!
      h.bench.records.set('dev', { ...h.bench.records.get('dev')!, projectPath: worktree, spawned: true })
      await submitWork(h, executionId, 'rl-c', 'src/r.ts', 'r\n')
      await h.tick(executor)
      const held = h.executions.change(executionId, 'rl-c')!
      expect(held.step).toBe('releasing')
      expect(held.stopDetail?.message).toContain('archive refused: pending approval')
      expect(h.executions.rounds(executionId, 'rl-c').at(-1)!.reviewAssignmentId).toBeNull()
      expect(view(executionId, 'rl-c').waiting).toEqual({ kind: 'release', member: 'dev', reason: held.stopDetail!.message! })
    } finally {
      executor.close()
    }
  })
})

describe('one stop per reason, each retried (13.3)', () => {
  test('name-taken: no task; Retry after the name is freed provisions it', async () => {
    pushCommit(matrix, 'master', 'nt.txt', 'nt\n')
    const { spawnSync } = await import('node:child_process')
    const { cleanGitEnv } = await import('../git/gitCommand')
    spawnSync('git', ['branch', 'nt-a', 'master'], { cwd: matrix.origin, env: cleanGitEnv() })
    const executionId = await startedExecution(h, [{ change: 'nt-a' }])
    await h.tick()
    const stopped = h.executions.change(executionId, 'nt-a')!
    expect(stopped).toMatchObject({ state: 'stopped', stopReason: 'name-taken', taskId: null })
    spawnSync('git', ['branch', '-D', 'nt-a'], { cwd: matrix.origin, env: cleanGitEnv() })
    spawnSync('git', ['branch', '-D', 'nt-a'], { cwd: matrix.world.repo, env: cleanGitEnv() })
    expect(await h.service.retry(h.bench.human, { executionId, change: 'nt-a', commandId: 'retry-nt' })).toMatchObject({ ok: true })
    await h.tick()
    expect(h.executions.change(executionId, 'nt-a')).toMatchObject({ state: 'implementing' })
    expect(h.executions.change(executionId, 'nt-a')!.taskId).not.toBeNull()
  })

  test('pr-closed: Retry reopens a new pull request', async () => {
    const executionId = await startedExecution(h, [{ change: 'pc-a' }])
    await h.tick()
    await submitWork(h, executionId, 'pc-a', 'src/p.ts', 'p\n')
    await h.tick()
    h.gh.pulls[0]!.state = 'CLOSED'
    await review(h, executionId, 'pc-a', 'fail')
    await h.tick()
    await submitWork(h, executionId, 'pc-a', 'src/p.ts', 'q\n')
    await h.tick()
    expect(h.executions.change(executionId, 'pc-a')).toMatchObject({ state: 'stopped', stopReason: 'pr-closed' })
    h.gh.pulls.length = 0
    expect(await h.service.retry(h.bench.human, { executionId, change: 'pc-a', commandId: 'retry-pc' })).toMatchObject({ ok: true })
    await h.tick()
    expect(h.gh.prCreates).toBe(2)
    expect(h.executions.change(executionId, 'pc-a')).toMatchObject({ state: 'gating', step: 'reviewing' })
  })

  test('review-unavailable: Retry clears the review and dispatches a new one', async () => {
    const executionId = await startedExecution(h, [{ change: 'ru-a' }])
    await h.tick()
    await submitWork(h, executionId, 'ru-a', 'src/r.ts', 'r\n')
    await h.tick()
    const row = h.executions.change(executionId, 'ru-a')!
    const round = h.executions.rounds(executionId, 'ru-a').at(-1)!
    const assignment = h.tasks.store.assignmentsOf(row.taskId!).find(entry => entry.id === round.reviewAssignmentId)!
    h.mail.claim(assignment.messageId!, 'dev')
    await h.tick()
    expect(h.executions.change(executionId, 'ru-a')).toMatchObject({ state: 'stopped', stopReason: 'review-unavailable' })
    // No findings were submitted by anyone.
    expect(h.tasks.store.results.findingsFor(round.resultId)).toEqual([])
    expect(await h.service.retry(h.bench.human, { executionId, change: 'ru-a', commandId: 'retry-ru' })).toMatchObject({ ok: true })
    await h.tick()
    const again = h.executions.rounds(executionId, 'ru-a').at(-1)!
    expect(again.reviewAssignmentId).not.toBeNull()
    expect(again.reviewAssignmentId).not.toBe(round.reviewAssignmentId)
  })

  test('instruction-failed: Retry sends the instruction again', async () => {
    const executionId = await startedExecution(h, [{ change: 'if-a' }])
    await h.tick()
    const row = h.executions.change(executionId, 'if-a')!
    const first = h.tasks.store.assignmentsOf(row.taskId!)[0]!
    h.mail.deadLetter(first.messageId!, 'killed-recipient')
    await h.tick()
    expect(h.executions.change(executionId, 'if-a')).toMatchObject({ state: 'stopped', stopReason: 'instruction-failed' })
    expect(await h.service.retry(h.bench.human, { executionId, change: 'if-a', commandId: 'retry-if' })).toMatchObject({ ok: true })
    await h.tick()
    const assignments = h.tasks.store.assignmentsOf(row.taskId!)
    expect(assignments).toHaveLength(2)
    expect(h.mail.get(assignments.at(-1)!.messageId!)!.state).toBe('queued')
    expect(h.executions.change(executionId, 'if-a')!.state).toBe('implementing')
  })

  test('effect-unknown: Retry re-enters inspection, which finds it not done and runs it again', async () => {
    const executionId = await startedExecution(h, [{ change: 'eu-a' }])
    await h.tick()
    const commit = await submitWork(h, executionId, 'eu-a', 'src/e.ts', 'e\n')
    // The push's outcome could not be decided (D14's inspection): its effect
    // failed and the change stopped as effect-unknown, naming the effect.
    const failing = h.makeExecutor({ adapters: { push: { call: async () => ({ ok: false, error: { argv: ['git', 'push'], exitCode: 128, stderr: 'remote end hung up unexpectedly' } }) } } })
    try {
      await h.tick(failing)
    } finally {
      failing.close()
    }
    const push = h.executions.effectsOf(executionId).find(effect => effect.kind === 'push')!
    expect(push.state).toBe('failed')
    h.executions.transition(executionId, 'eu-a', h.executions.change(executionId, 'eu-a')!, { state: 'stopped', stopReason: 'effect-unknown', stopDetail: { message: 'the push could not be inspected', effectId: push.id } })
    expect(await h.service.retry(h.bench.human, { executionId, change: 'eu-a', commandId: 'retry-eu' })).toMatchObject({ ok: true })
    expect(h.executions.effect(push.id)!.state).toBe('unknown')
    await h.tick()
    expect(h.executions.effect(push.id)!.state).toBe('done')
    expect(originHead(matrix, 'eu-a')).toBe(commit)
    expect(h.executions.change(executionId, 'eu-a')).toMatchObject({ state: 'gating', step: 'reviewing' })
  })

  test('a passed change waits for the slot another change holds, then lands next', async () => {
    const executionId = await startedExecution(h, [{ change: 'sl-a' }, { change: 'sl-b' }])
    await h.tick()
    await submitWork(h, executionId, 'sl-a', 'src/sl-a.ts', 'a\n')
    await submitWork(h, executionId, 'sl-b', 'src/sl-b.ts', 'b\n')
    await h.tick()
    // The base moves, and GitHub's update of sl-a has not come through yet:
    // sl-a holds the slot while updating.
    pushCommit(matrix, 'master', 'moved.txt', 'moved\n')
    let updates = 0
    h.gh.update = () => { updates += 1 }
    await review(h, executionId, 'sl-a', 'pass')
    await h.tick()
    expect(h.executions.change(executionId, 'sl-a')).toMatchObject({ state: 'landing', step: 'updating' })
    await review(h, executionId, 'sl-b', 'pass')
    await h.tick()
    expect(h.executions.change(executionId, 'sl-b')!.state).toBe('gating')
    expect(h.executions.slot(matrix.world.team.teamId)?.holderId).toContain(':sl-a')
    expect(view(executionId, 'sl-b').waiting).toMatchObject({ kind: 'slot' })
    // GitHub's update lands: sl-a merges, lands, and frees the slot for sl-b.
    h.gh.update = null
    const pull = h.gh.pulls.find(entry => entry.branch === 'sl-a')!
    onOrigin(matrix, clone => {
      git(['checkout', '-q', pull.branch], clone)
      git(['-c', 'user.email=gh@e', '-c', 'user.name=GitHub', 'merge', '-q', '--no-ff', '-m', 'Merge base', 'origin/master'], clone)
      git(['push', '-q', 'origin', `HEAD:refs/heads/${pull.branch}`], clone)
    })
    for (let pass = 0; pass < 4; pass++) await h.tick()
    expect(updates).toBe(1)
    expect(h.executions.change(executionId, 'sl-a')!.state).toBe('landed')
    expect(['landing', 'landed']).toContain(h.executions.change(executionId, 'sl-b')!.state)
  })
})
