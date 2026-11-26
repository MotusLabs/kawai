// The reviewer's F9 probe (plan-revision-apply review F9, A3/CH4 via D9),
// verbatim but for this header, a typed literal, and the interrupted tick's state: the
// settled update's follow-on stays eligible (`landing`) until D9's mint
// commits, so the recovered fix carries the base and the conflicting files.
import { expect, spyOn, test } from 'bun:test'
import * as git from '../git/gitCommand'
import { createMatrixBench, createMatrixWorld, pushCommit, removeMatrixWorld, review, startedExecution, submitWork } from './executionMatrixHarness'

for (const crash of [false, true]) test(`a settled conflicting branch update and task revision send one complete fix (interrupted: ${crash})`, async () => {
  const matrix = await createMatrixWorld('kawai-f8-crash-')
  const h = createMatrixBench(matrix)
  try {
    const executionId = await startedExecution(h, [{ change: 'rv-crash' }])
    const row = () => h.executions.change(executionId, 'rv-crash')!
    await h.tick()
    await submitWork(h, executionId, 'rv-crash', 'seed.txt', 'branch side\n')
    await h.tick()
    await review(h, executionId, 'rv-crash', 'pass')
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
      if (crash && args.join(' ') === 'rev-parse HEAD' && new Error().stack?.includes('gatherStartFacts')) {
        interrupted = true
        throw new Error('crash before D9 mint')
      }
      return original(args, options)
    })
    try { await h.tick() } finally { spy.mockRestore() }
    expect(interrupted).toBe(crash)
    expect(row().state).toBe(crash ? 'landing' : 'implementing')
    expect(h.executions.effectsOf(executionId).filter(effect => effect.kind === 'update-branch').map(effect => effect.state)).toEqual(['done'])
    await h.tick()
    await h.tick()
    const fixes = h.tasks.store.assignmentsOf(row().taskId!).filter(assignment => assignment.handoffKind === 'fix')
    expect(fixes).toHaveLength(1)
    expect(fixes[0]!.instruction).toContain('revision 2')
    const fix = h.executions.attempts(executionId, 'rv-crash').at(-1)!
    expect({
      base: fixes[0]!.instruction.includes(base),
      files: fixes[0]!.instruction.includes('conflicting files: seed.txt'),
      merge: fixes[0]!.instruction.includes('Merge the base branch as part of this attempt'),
      update: fix.manifest.update,
    }).toEqual({ base: true, files: true, merge: true, update: { base, files: ['seed.txt'] } })
  } finally {
    h.executor.close()
    h.bench.db.close()
    removeMatrixWorld(matrix)
  }
})
