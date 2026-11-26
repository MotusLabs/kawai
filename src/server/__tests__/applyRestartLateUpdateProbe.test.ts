// The round-3 reviewer's F6 reproduction (plan-revision-apply A3/CH5), kept as
// committed with only its debug print dropped: a Restart commits while an older
// update attempt's git reads run, and the executor still sends the restart row.
import { expect, spyOn, test } from 'bun:test'
import * as git from '../git/gitCommand'
import { dispatchUpdateAttempt, type DispatchDeps } from '../plans/execution/executionDispatch'
import { TaskResultService } from '../team/TaskResultService'
import { TaskService } from '../team/TaskService'
import { applyBench } from './applyBench'

// @covers: plan-revision-apply › The execution keeps its revision history › Manifests keep their revision
test('CH5 dispatches the owed restart when an older update completes its Git reads later', async () => {
  const wired = await applyBench('apply-restart-late-update')
  try {
    const { planId, executionId } = await wired.running()
    await wired.inFlightByKawai(executionId, 'ui', 'dev')
    const change = wired.executions.change(executionId, 'ui')!
    expect(wired.executions.transition(executionId, 'ui', change, { state: 'implementing', baselineCommit: 'base-sha' })).not.toBeNull()
    const roundId = wired.answerNewestRow(executionId, 'ui', 1)
    wired.bench.db.db.prepare("UPDATE plan_execution_rounds SET outcome = 'pass' WHERE id = ?").run(roundId)
    const round = wired.executions.round(roundId)!
    const next = await wired.approveNext(planId, content => ({
      ...content, changes: content.changes.map(entry => entry.change === 'ui' ? { ...entry, guidance: 'New direction for restart' } : entry),
    }))
    const deps: DispatchDeps = {
      team: wired.world.team, executions: wired.executions, plans: wired.bench.plans,
      tasks: new TaskService(wired.bench.tasks, { getSession: id => wired.bench.records.get(id), plans: wired.bench.plans }),
      assignments: wired.assignments,
      results: new TaskResultService(wired.tasks, { getSession: id => wired.bench.records.get(id), assignments: wired.assignments }),
    }
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const original = git.runGitAsync
    let paused = false
    const seam = spyOn(git, 'runGitAsync').mockImplementation(async (args, options) => {
      if (!paused && args[0] === 'rev-parse' && args[1] === 'HEAD') {
        paused = true
        entered.resolve()
        await release.promise
      }
      return original(args, options)
    })
    const send = dispatchUpdateAttempt(deps, { executionId, change: 'ui', round, update: { base: 'base-head', files: ['a.ts'] } })
    let owedId: string | undefined
    try {
      await Promise.race([entered.promise, send])
      expect(paused).toBe(true)
      expect(await wired.applyAs({ executionId, choices: { ui: 'restart' } })).toMatchObject({ ok: true })
      const owed = wired.executions.attempts(executionId, 'ui').at(-1)!
      expect(owed).toMatchObject({ kind: 'implement', assignmentId: null, manifest: { plan: { revision: next.revision } } })
      owedId = owed.id
    } finally {
      release.resolve()
      try { await send } finally { seam.mockRestore() }
    }
    const state = wired.executions.change(executionId, 'ui')!
    expect(state.state).toBe('implementing')
    const executor = wired.executor()
    await executor.tick(wired.teamId)
    await executor.tick(wired.teamId)
    const owedAfterTicks = wired.executions.attempts(executionId, 'ui').find(row => row.id === owedId)
    expect(owedAfterTicks?.assignmentId).not.toBeNull()
  } finally {
    wired.close()
  }
})
