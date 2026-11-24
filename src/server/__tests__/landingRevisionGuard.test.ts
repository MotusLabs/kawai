// D9 from a settled branch update (plan-revision-apply review F9, A3/CH4
// via D9): the change stays `landing` until D9's mint commits, so a crash
// before it leaves the follow-on eligible. The mint's transaction is the
// one that exits landing (the slot released), clears the pass marker, and
// supersedes the round; a change that moved while the mint read git (a Stop)
// gets no fix and no update attempt. Real executor, local bare origin,
// scripted GitHub.
import { expect, spyOn, test } from 'bun:test'
import * as git from '../git/gitCommand'
import { createMatrixBench, createMatrixWorld, pushCommit, removeMatrixWorld, review, startedExecution, submitWork, type MatrixBench, type MatrixWorld } from './executionMatrixHarness'

/** A passed change whose branch update GitHub refuses once the base conflicts and the task is republished. */
async function conflicted(matrix: MatrixWorld, h: MatrixBench) {
  const executionId = await startedExecution(h, [{ change: 'rv-guard' }])
  const row = () => h.executions.change(executionId, 'rv-guard')!
  await h.tick()
  await submitWork(h, executionId, 'rv-guard', 'seed.txt', 'branch side\n')
  await h.tick()
  await review(h, executionId, 'rv-guard', 'pass')
  pushCommit(matrix, 'master', 'base-only.txt', 'base initially clean\n')
  h.gh.update = async () => {
    h.gh.update = null
    pushCommit(matrix, 'master', 'seed.txt', 'base now conflicts\n')
    await h.tasks.amend(h.bench.human, row().taskId!, { direction: 'Change the scope.' })
    return 'conflict' as const
  }
  const round = () => h.executions.rounds(executionId, 'rv-guard').at(-1)!
  const fixes = () => h.tasks.store.assignmentsOf(row().taskId!).filter(assignment => assignment.handoffKind === 'fix')
  return { executionId, row, round, fixes, attempts: () => h.executions.attempts(executionId, 'rv-guard') }
}

/** Pause (or fail) D9's start-facts read of the worktree head. */
function atMintRead(onRead: () => Promise<void>) {
  const original = git.runGitAsync
  return spyOn(git, 'runGitAsync').mockImplementation(async (args, options) => {
    if (args.join(' ') === 'rev-parse HEAD' && new Error().stack?.includes('gatherStartFacts')) await onRead()
    return original(args, options)
  })
}

async function bench(prefix: string, run: (matrix: MatrixWorld, h: MatrixBench) => Promise<void>) {
  const matrix = await createMatrixWorld(prefix)
  const h = createMatrixBench(matrix)
  try { await run(matrix, h) } finally {
    h.executor.close()
    h.bench.db.close()
    removeMatrixWorld(matrix)
  }
}

test('a crash before the D9 mint keeps the settled update eligible: recovery mints one fix in the transaction that exits landing, frees the slot, clears the pass, and supersedes the round, with no update attempt', () => bench('kawai-f9-guard-', async (_matrix, h) => {
  const c = await conflicted(_matrix, h)
  let crashed = false
  const spy = atMintRead(async () => {
    if (crashed) return
    crashed = true
    throw new Error('crash before D9 mint')
  })
  try { await h.tick() } finally { spy.mockRestore() }
  const passed = c.round()
  expect({ crashed, state: c.row().state, step: c.row().step, passed: c.row().passedAt !== null, slot: h.executions.slot(c.row().teamId)?.holderId ?? null, round: passed.outcome, fixes: c.fixes().length })
    .toEqual({ crashed: true, state: 'landing', step: 'updating', passed: true, slot: `${c.executionId}:rv-guard`, round: 'pass', fixes: 0 })
  await h.tick()
  await h.tick()
  expect({
    state: c.row().state, passedAt: c.row().passedAt, slot: h.executions.slot(c.row().teamId), round: h.executions.round(passed.id)!.outcome,
    fixes: c.fixes().length, kinds: c.attempts().map(attempt => attempt.kind).filter(kind => kind !== 'implement'),
  }).toEqual({ state: 'implementing', passedAt: null, slot: null, round: 'superseded', fixes: 1, kinds: ['fix'] })
}))

test('a change stopped while the D9 mint reads git gets no fix and no update attempt, and its round stays as it was', () => bench('kawai-f9-stale-', async (_matrix, h) => {
  const c = await conflicted(_matrix, h)
  let stopped = false
  const spy = atMintRead(async () => {
    if (stopped) return
    stopped = true
    const now = c.row()
    expect(h.executions.transition(c.executionId, 'rv-guard', now, { state: 'stopped', step: null, stopReason: 'effect-failed', stopDetail: null })).not.toBeNull()
  })
  try { await h.tick() } finally { spy.mockRestore() }
  await h.tick()
  expect({ stopped, state: c.row().state, round: c.round().outcome, fixes: c.fixes().length, kinds: c.attempts().map(attempt => attempt.kind).filter(kind => kind !== 'implement') })
    .toEqual({ stopped: true, state: 'stopped', round: 'pass', fixes: 0, kinds: [] })
}))
