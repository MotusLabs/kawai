import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test'
import * as git from '../git/gitCommand'
import { dispatchRevisionAttempt, roundAdapters, type RoundDeps } from '../plans/execution/executionRounds'
import { TaskResultService } from '../team/TaskResultService'
import { applyBench, type ApplyBench } from './applyBench'
import { writeGroup } from './planHarness'

let wired: ApplyBench
beforeAll(async () => { wired = await applyBench('apply-conflict-carry') })
afterAll(() => wired.close())

for (const changeGroup of [false, true]) {
  test(`preserve combined revision/update conflict after ${changeGroup ? 'routing' : 'guidance'} Apply`, async () => {
    writeGroup(wired.world, 'middle-devs', '---\nprofiles: [default, opus]\n---\nBuild.')
    writeGroup(wired.world, 'senior-devs', '---\nprofiles: [default, opus]\n---\nBuild hard things.')
    const { planId, executionId } = await wired.running({ roles: [
      { group: 'middle-devs', profiles: ['default'] }, { group: 'senior-devs', profiles: ['opus'] }, { group: 'reviewers', profiles: [] },
    ] })
    const { taskId } = await wired.inFlightByKawai(executionId, 'ui', 'dev')
    const start = wired.executions.change(executionId, 'ui')!
    expect(wired.executions.transition(executionId, 'ui', start, { state: 'implementing', baselineCommit: 'base-sha' })).not.toBeNull()
    const roundId = wired.answerNewestRow(executionId, 'ui', 1)
    const round = wired.executions.round(roundId)!
    const now = wired.executions.change(executionId, 'ui')!
    wired.bench.db.db.prepare('UPDATE plan_execution_rounds SET outcome = ? WHERE id = ?').run('pass', roundId)
    expect(wired.executions.transition(executionId, 'ui', now, { state: 'gating', step: null, passedAt: null })).not.toBeNull()
    await wired.approveNext(planId, content => ({ ...content, changes: content.changes.map(entry => entry.change === 'ui' ? { ...entry, guidance: 'Adapt scope.' } : entry) }))
    expect(await wired.applyAs({ executionId, choices: { ui: 'adapt' } })).toMatchObject({ ok: true })
    expect(wired.tasks.store.get(taskId)?.revision).toBe(2)
    const next = await wired.approveNext(planId, content => ({ ...content, changes: content.changes.map(entry => entry.change === 'ui' ? changeGroup ? { ...entry, group: 'senior-devs' } : { ...entry, guidance: 'Latest guidance.' } : entry) }))
    const deps: RoundDeps = {
      team: wired.world.team, executions: wired.executions, plans: wired.bench.plans, tasks: wired.tasks,
      assignments: wired.assignments,
      results: new TaskResultService(wired.tasks, { getSession: id => wired.bench.records.get(id), assignments: wired.assignments }),
      repo: 'test-only', adapters: roundAdapters, now: () => wired.now().toISOString(),
      records: () => wired.bench.records.values(), groupScoped: () => false,
      releases: { readiness: () => ({ ready: true, reason: null }), release: () => ({ ok: true }), pendingSpawns: () => [] },
    }
    const paused = Promise.withResolvers<void>()
    const ready = Promise.withResolvers<void>()
    const orig = git.runGitAsync
    let pauseOnce = true
    const spy = spyOn(git, 'runGitAsync').mockImplementation(async (args, options) => {
      if (args[0] === 'rev-parse' && pauseOnce) { pauseOnce = false; paused.resolve(); await ready.promise }
      return orig(args, options)
    })
    const before = wired.tasks.store.assignmentsOf(taskId).length
    const mint = dispatchRevisionAttempt(deps, wired.executions.change(executionId, 'ui')!, round, { base: 'actual-conflicting-base', files: ['conflicted-path.ts'] })
    try {
      await Promise.race([paused.promise, mint.then(() => { throw new Error('Mint bypassed its git pause') })])
      expect(await wired.applyAs({ executionId, choices: { ui: 'continue' } })).toMatchObject({ ok: true })
      expect(wired.executions.execution(executionId)?.revision).toBe(next.revision)
    } finally {
      ready.resolve()
      try { await mint } finally { spy.mockRestore() }
    }
    const executor = wired.executor()
    await executor.tick(wired.teamId)
    await executor.tick(wired.teamId)
    const sent = wired.tasks.store.assignmentsOf(taskId).slice(before)
    expect(sent).toHaveLength(1)
    expect(sent[0]?.targetId).toBe(changeGroup && !process.env.PROBE_PRE_FIX ? 'senior-devs' : 'middle-devs')
    expect(sent[0]?.instruction).toContain('actual-conflicting-base')
    expect(sent[0]?.instruction).toContain('conflicted-path.ts')
  })
}
