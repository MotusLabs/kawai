// The reviewer's F9 hold-recovery reproduction (findings-1785921f), committed
// verbatim with this header: interrupted D9 mint, owner hold via HoldService,
// recovery tick, release; the one fix names the base head and the files.
import { expect, spyOn, test } from 'bun:test'
import * as git from '../git/gitCommand'
import { DecisionStore } from '../plans/decisions/decisionStore'
import { HoldService } from '../plans/revisionControl/holdService'
import { HoldStore } from '../plans/revisionControl/holdStore'
import { ImpactStore } from '../strategy/impactStore'
import { createMatrixBench, createMatrixWorld, pushCommit, removeMatrixWorld, review, startedExecution, submitWork } from './executionMatrixHarness'

test('a hold placed after interruption preserves the settled conflict through release', async () => {
  const matrix = await createMatrixWorld('kawai-f9-hold-recovery-')
  const h = createMatrixBench(matrix)
  const holds = new HoldStore(h.bench.db.db)
  const holdService = new HoldService({
    holds, plans: h.bench.plans, planService: h.bench.service,
    strategies: h.bench.strategies, impact: new ImpactStore(h.bench.db.db),
    decisions: new DecisionStore(h.bench.db.db), executions: h.executions,
  })
  const executor = h.makeExecutor({ holds: { active: (team, plan) => holds.active(team, plan), openTargets: () => [] } })
  const tick = () => h.tick(executor)
  try {
    const change = 'rv-crash-hold'
    const executionId = await startedExecution(h, [{ change }])
    const planId = h.executions.execution(executionId)!.planId
    const row = () => h.executions.change(executionId, change)!
    const fixes = () => h.tasks.store.assignmentsOf(row().taskId!).filter(a => a.handoffKind === 'fix')
    await tick()
    await submitWork(h, executionId, change, 'seed.txt', 'branch side\n')
    await tick()
    await review(h, executionId, change, 'pass')
    pushCommit(matrix, 'master', 'base-only.txt', 'base initially clean\n')
    let base = ''
    h.gh.update = async () => {
      h.gh.update = null
      base = pushCommit(matrix, 'master', 'seed.txt', 'base now conflicts\n')
      await h.tasks.amend(h.bench.human, row().taskId!, { direction: 'Change the scope.' })
      return 'conflict' as const
    }
    const original = git.runGitAsync
    let interrupted = false
    const spy = spyOn(git, 'runGitAsync').mockImplementation(async (args, options) => {
      if (args.join(' ') === 'rev-parse HEAD' && new Error().stack?.includes('gatherStartFacts')) {
        interrupted = true
        throw new Error('crash before D9 mint')
      }
      return original(args, options)
    })
    try { await tick() } finally { spy.mockRestore() }
    expect(interrupted).toBe(true)
    expect(row().state).toBe('landing')
    expect(h.executions.effectsOf(executionId).filter(e => e.kind === 'update-branch').map(e => e.state)).toEqual(['done'])

    const placed = holdService.place(h.bench.human, { planId, scope: 'changes', changes: [change], deadline: new Date(Date.now() + 86_400_000).toISOString(), rationale: 'Hold after interruption.', commandId: crypto.randomUUID() })
    if (!placed.ok) throw new Error(JSON.stringify(placed))
    await tick()
    expect(fixes()).toHaveLength(0)
    expect(holdService.release(h.bench.human, { planId, holdId: placed.result!.hold.id, reason: 'Release after recovery.', commandId: crypto.randomUUID() }).ok).toBe(true)
    await tick()
    await tick()

    expect(fixes()).toHaveLength(1)
    const fix = h.executions.attempts(executionId, change).at(-1)!
    expect({ update: fix.manifest.update, namesFiles: fixes()[0]!.instruction.includes('conflicting files: seed.txt'), namesBase: fixes()[0]!.instruction.includes(base) })
      .toEqual({ update: { base, files: ['seed.txt'] }, namesFiles: true, namesBase: true })
  } finally {
    executor.close()
    h.executor.close()
    h.bench.db.close()
    removeMatrixWorld(matrix)
  }
})
