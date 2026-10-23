// The round pipeline's release step end to end (plan-execution §12.4, D11)
// over the plan bench, a bare origin, and a stub gh: a worktree-scoped
// review group releases the spawned implementer before the review handoff —
// and holds the step, with its reason, while the member is not ready or a
// spawn is still starting in the worktree, releasing it and dispatching the
// review on the next tick once it can be released.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import path from 'node:path'
import { ExecutionExecutor } from '../plans/execution/executor'
import { provisionAdapter } from '../plans/execution/executionProvision'
import { neutralExecutorSeams } from './executorTestSeams'
import {
  approvedExecution, assignments, bench, closeExecutor, executions, ghStub, implementStage, mail, passCi,
  results, setupBench, setupWorld, stubRoundAdapters, tasks, teardownWorld, world,
} from './executionRoundsFixture'

beforeAll(setupWorld)
afterAll(teardownWorld)
beforeEach(setupBench)
afterEach(closeExecutor)

describe('the round pipeline (§12)', () => {
  test('a worktree-scoped review group releases the spawned implementer before review (12.4)', async () => {
    const executionId = await approvedExecution('rel-a')
    const staged = await implementStage(executionId, 'rel-a', 'x')
    const worktreeA = staged.row!.worktree!
    // dev is a spawned member working in the change's worktree.
    bench.records.set('dev', { ...(bench.records.get('dev') as Exclude<ReturnType<typeof bench.records.get>, undefined>), projectPath: path.join(worktreeA, 'src'), spawned: true })
    const released: string[] = []
    const holding = { ready: true, reason: null as string | null }
    const releasingExecutor = new ExecutionExecutor({
      ...neutralExecutorSeams, plansService: bench.service,
      store: executions, plans: bench.plans, tasks, assignments, results, mailbox: mail,
      records: () => bench.records.values(),
      teamOf: id => (id === world.team.teamId ? world.team : undefined),
      adapters: { provision: provisionAdapter(executions) },
      roundAdapters: stubRoundAdapters(),
      releases: { readiness: id => (id === 'dev' ? holding : { ready: true, reason: null }), release: id => { released.push(id); return { ok: true as const } }, pendingSpawns: () => [] },
      groupScoped: () => true,
    })
    try {
      ghStub.pulls = '[]'
      passCi()
      releasingExecutor.wake(world.team.teamId)
      await releasingExecutor.idle()
      expect(released).toEqual(['dev'])
      expect(executions.change(executionId, 'rel-a')!.step).toBe('reviewing')

      // A not-ready member holds the step with its reason.
      const execution2 = await approvedExecution('rel-b')
      const second = await implementStage(execution2, 'rel-b', 'x')
      bench.records.set('dev', { ...(bench.records.get('dev') as Exclude<ReturnType<typeof bench.records.get>, undefined>), projectPath: path.join(second.row!.worktree!, 'src'), spawned: true })
      holding.ready = false
      holding.reason = 'busy'
      releasingExecutor.wake(world.team.teamId)
      await releasingExecutor.idle()
      expect(executions.change(execution2, 'rel-b')!.step).toBe('releasing')
      // Ready again, the review follows on the next tick.
      holding.ready = true
      ghStub.pulls = '[]'
      passCi()
      releasingExecutor.wake(world.team.teamId)
      await releasingExecutor.idle()
      expect(executions.change(execution2, 'rel-b')!.step).toBe('reviewing')
    } finally {
      releasingExecutor.close()
    }
  })

  test('a spawn still starting in the worktree holds the release step until it can be released', async () => {
    // The instruction's spawn is reserved (team_spawns) but not yet a record:
    // dispatching the review then let the late implementer hold the worktree
    // against the reviewer's spawn (the e2e "review handoff never claimed").
    const executionId = await approvedExecution('rel-s')
    const staged = await implementStage(executionId, 'rel-s', 'x')
    const worktree = staged.row!.worktree!
    const pending: Array<{ groupId: string; worktree: string }> = [
      { groupId: 'reviewers', worktree },
      { groupId: 'dev', worktree: `${worktree}-other` },
      { groupId: 'dev', worktree },
    ]
    const asked: string[] = []
    const released: string[] = []
    const startingExecutor = new ExecutionExecutor({
      ...neutralExecutorSeams, plansService: bench.service,
      store: executions, plans: bench.plans, tasks, assignments, results, mailbox: mail,
      records: () => bench.records.values(),
      teamOf: id => (id === world.team.teamId ? world.team : undefined),
      adapters: { provision: provisionAdapter(executions) },
      roundAdapters: stubRoundAdapters(),
      releases: {
        readiness: () => ({ ready: true, reason: null }),
        release: id => { released.push(id); return { ok: true as const } },
        pendingSpawns: teamId => { asked.push(teamId); return pending },
      },
      groupScoped: () => true,
    })
    try {
      ghStub.pulls = '[]'
      passCi()
      startingExecutor.wake(world.team.teamId)
      await startingExecutor.idle()
      expect(asked).toContain(world.team.teamId)
      const held = executions.change(executionId, 'rel-s')!
      expect(held.step).toBe('releasing')
      expect(held.stopDetail?.message).toContain('dev member is still starting in the worktree')
      expect(executions.rounds(executionId, 'rel-s').at(-1)!.reviewAssignmentId).toBeNull()
      expect(tasks.store.assignmentsOf(held.taskId!).some(row => row.handoffKind === 'review')).toBe(false)

      // The spawn lands as a spawned record in the worktree: it is released, then the review follows.
      pending.splice(2, 1)
      bench.records.set('dev', { ...(bench.records.get('dev') as Exclude<ReturnType<typeof bench.records.get>, undefined>), projectPath: worktree, spawned: true })
      ghStub.pulls = '[]'
      passCi()
      startingExecutor.wake(world.team.teamId)
      await startingExecutor.idle()
      expect(released).toEqual(['dev'])
      expect(executions.change(executionId, 'rel-s')!.step).toBe('reviewing')
    } finally {
      startingExecutor.close()
    }
  })
})
