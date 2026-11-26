// D9 from a settled branch update under an owner hold (plan-revision-apply
// review F9, A3/CH4 via D9, invariant AL3): the hold governs dispatch only.
// D9's one guarded transaction still records the conflict in the fix row,
// supersedes the pass, and exits the slot; the fix stays owed and mail-free
// while held, and the release sends exactly that row. A refused mint rolls
// its writes back, so the follow-on and its round stay eligible. The ordinary
// held update (no revision pending) keeps its pass and makes no attempt.
// Real executor, owner HoldService, local bare origin, scripted GitHub.
import { expect, spyOn, test } from 'bun:test'
import * as git from '../git/gitCommand'
import * as attemptSend from '../plans/execution/attemptSend'
import { DecisionStore } from '../plans/decisions/decisionStore'
import { HoldService } from '../plans/revisionControl/holdService'
import { HoldStore } from '../plans/revisionControl/holdStore'
import { ImpactStore } from '../strategy/impactStore'
import { createMatrixBench, createMatrixWorld, pushCommit, removeMatrixWorld, review, startedExecution, submitWork, type MatrixBench, type MatrixWorld } from './executionMatrixHarness'

const CHANGE = 'rv-hold'

async function heldBench(prefix: string, run: (ctx: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const matrix = await createMatrixWorld(prefix)
  const h = createMatrixBench(matrix)
  const holds = new HoldStore(h.bench.db.db)
  const holdService = new HoldService({
    holds, plans: h.bench.plans, planService: h.bench.service, strategies: h.bench.strategies,
    impact: new ImpactStore(h.bench.db.db), decisions: new DecisionStore(h.bench.db.db), executions: h.executions,
  })
  const executor = h.makeExecutor({ holds: { active: (team, plan) => holds.active(team, plan), openTargets: () => [] } })
  try { await run(await setup(matrix, h, holdService, () => h.tick(executor))) } finally {
    executor.close()
    h.executor.close()
    h.bench.db.close()
    removeMatrixWorld(matrix)
  }
}

/** A passed change; `conflict(republish)` scripts GitHub to refuse the next branch update once the base conflicts. */
async function setup(matrix: MatrixWorld, h: MatrixBench, holdService: HoldService, tick: () => Promise<void>) {
  const executionId = await startedExecution(h, [{ change: CHANGE }])
  const planId = h.executions.execution(executionId)!.planId
  const row = () => h.executions.change(executionId, CHANGE)!
  await tick()
  await submitWork(h, executionId, CHANGE, 'seed.txt', 'branch side\n')
  await tick()
  await review(h, executionId, CHANGE, 'pass')
  pushCommit(matrix, 'master', 'base-only.txt', 'base initially clean\n')
  const scripted = { base: '' }
  const conflict = (during: () => Promise<void>) => {
    h.gh.update = async () => {
      h.gh.update = null
      scripted.base = pushCommit(matrix, 'master', 'seed.txt', 'base now conflicts\n')
      await during()
      return 'conflict' as const
    }
  }
  const republish = () => h.tasks.amend(h.bench.human, row().taskId!, { direction: 'Change the scope.' }).then(() => undefined)
  const hold = () => {
    const placed = holdService.place(h.bench.human, { planId, scope: 'changes', changes: [CHANGE], deadline: new Date(Date.now() + 86_400_000).toISOString(), rationale: 'Owner hold.', commandId: crypto.randomUUID() })
    if (!placed.ok) throw new Error(JSON.stringify(placed))
    return placed.result!.hold.id
  }
  const release = (holdId: string) => expect(holdService.release(h.bench.human, { planId, holdId, reason: 'Release.', commandId: crypto.randomUUID() }).ok).toBe(true)
  const fixMail = () => h.tasks.store.assignmentsOf(row().taskId!).filter(assignment => assignment.handoffKind === 'fix')
  const attempts = () => h.executions.attempts(executionId, CHANGE).filter(attempt => attempt.kind !== 'implement')
  const round = () => h.executions.rounds(executionId, CHANGE).at(-1)!
  const updates = () => h.executions.effectsOf(executionId).filter(effect => effect.kind === 'update-branch').map(effect => effect.state)
  return { h, executionId, row, tick, conflict, republish, hold, release, fixMail, attempts, round, updates, scripted }
}

/** Fail D9's start-facts read of the worktree head once (a crash before the mint). */
function crashMintReadOnce() {
  const original = git.runGitAsync
  const seen = { crashed: false }
  const spy = spyOn(git, 'runGitAsync').mockImplementation(async (args, options) => {
    if (!seen.crashed && args.join(' ') === 'rev-parse HEAD' && new Error().stack?.includes('gatherStartFacts')) {
      seen.crashed = true
      throw new Error('crash before D9 mint')
    }
    return original(args, options)
  })
  return { seen, restore: () => spy.mockRestore() }
}

test('interrupted D9 mint, then an owner hold, then recovery: the slot frees with one owed fix carrying the base and files, no mail and no update attempt while held; the release sends that one fix and a further tick sends nothing', () => heldBench('kawai-f9-hold-witness-', async c => {
  c.conflict(c.republish)
  const crash = crashMintReadOnce()
  try { await c.tick() } finally { crash.restore() }
  const passed = c.round()
  expect({ crashed: crash.seen.crashed, state: c.row().state, step: c.row().step, passed: c.row().passedAt !== null, updates: c.updates(), round: passed.outcome })
    .toEqual({ crashed: true, state: 'landing', step: 'updating', passed: true, updates: ['done'], round: 'pass' })

  const holdId = c.hold()
  await c.tick()
  const owed = c.attempts()
  expect({
    state: c.row().state, passedAt: c.row().passedAt, slot: c.h.executions.slot(c.row().teamId), round: c.h.executions.round(passed.id)!.outcome,
    kinds: owed.map(attempt => attempt.kind), update: owed[0]?.manifest.update, assigned: owed[0]?.assignmentId ?? null, mail: c.fixMail().length,
  }).toEqual({ state: 'implementing', passedAt: null, slot: null, round: 'superseded', kinds: ['fix'], update: { base: c.scripted.base, files: ['seed.txt'] }, assigned: null, mail: 0 })
  await c.tick()
  expect({ mail: c.fixMail().length, kinds: c.attempts().map(attempt => attempt.kind) }).toEqual({ mail: 0, kinds: ['fix'] })

  c.release(holdId)
  await c.tick()
  await c.tick()
  const sent = c.fixMail()
  expect({ mail: sent.length, kinds: c.attempts().map(attempt => attempt.kind), id: c.attempts()[0]!.id, namesFiles: sent[0]?.instruction.includes('conflicting files: seed.txt'), namesBase: sent[0]?.instruction.includes(c.scripted.base) })
    .toEqual({ mail: 1, kinds: ['fix'], id: owed[0]!.id, namesFiles: true, namesBase: true })
  await c.tick()
  expect(c.fixMail()).toHaveLength(1)
}))

test('a hold placed while the conflicting update settles, with a revision pending: D9 mints the owed fix in the slot-exit transaction and the release sends it with the conflict', () => heldBench('kawai-f9-hold-direct-', async c => {
  let holdId = ''
  c.conflict(async () => { await c.republish(); holdId = c.hold() })
  await c.tick()
  await c.tick()
  const owed = c.attempts()
  expect({ state: c.row().state, passedAt: c.row().passedAt, slot: c.h.executions.slot(c.row().teamId), kinds: owed.map(attempt => attempt.kind), update: owed[0]?.manifest.update, mail: c.fixMail().length })
    .toEqual({ state: 'implementing', passedAt: null, slot: null, kinds: ['fix'], update: { base: c.scripted.base, files: ['seed.txt'] }, mail: 0 })
  c.release(holdId)
  await c.tick()
  await c.tick()
  expect({ mail: c.fixMail().length, namesBase: c.fixMail()[0]?.instruction.includes(c.scripted.base), kinds: c.attempts().map(attempt => attempt.kind) })
    .toEqual({ mail: 1, namesBase: true, kinds: ['fix'] })
}))

test('a refused D9 mint rolls back the supersession and the landing exit: the change stays landing/updating with its pass and slot, and the next tick mints the conflict-bearing fix', () => heldBench('kawai-f9-refused-', async c => {
  c.conflict(c.republish)
  let refused = 0
  const spy = spyOn(attemptSend, 'commitAttemptInsert').mockImplementation(() => { refused++; return null })
  try { await c.tick() } finally { spy.mockRestore() }
  const passed = c.round()
  expect({ refused: refused > 0, state: c.row().state, step: c.row().step, passed: c.row().passedAt !== null, slot: c.h.executions.slot(c.row().teamId)?.holderId ?? null, round: passed.outcome, kinds: c.attempts().map(attempt => attempt.kind), updates: c.updates() })
    .toEqual({ refused: true, state: 'landing', step: 'updating', passed: true, slot: `${c.executionId}:${CHANGE}`, round: 'pass', kinds: [], updates: ['done'] })
  await c.tick()
  await c.tick()
  expect({ state: c.row().state, slot: c.h.executions.slot(c.row().teamId), kinds: c.attempts().map(attempt => attempt.kind), update: c.attempts()[0]?.manifest.update, mail: c.fixMail().length })
    .toEqual({ state: 'implementing', slot: null, kinds: ['fix'], update: { base: c.scripted.base, files: ['seed.txt'] }, mail: 1 })
}))

test('a held conflicting update with no revision pending keeps its pass and makes no attempt; the release answers it with one update attempt naming the files', () => heldBench('kawai-f9-hold-ordinary-', async c => {
  let holdId = ''
  c.conflict(async () => { holdId = c.hold() })
  await c.tick()
  await c.tick()
  expect({ state: c.row().state, passed: c.row().passedAt !== null, round: c.round().outcome, kinds: c.attempts().map(attempt => attempt.kind), mail: c.fixMail().length })
    .toEqual({ state: 'gating', passed: true, round: 'pass', kinds: [], mail: 0 })
  c.conflict(async () => undefined)
  c.release(holdId)
  for (let i = 0; i < 4 && c.fixMail().length === 0; i++) await c.tick()
  expect({ kinds: c.attempts().map(attempt => attempt.kind), mail: c.fixMail().length, namesFiles: c.fixMail()[0]?.instruction.includes('seed.txt') })
    .toEqual({ kinds: ['update'], mail: 1, namesFiles: true })
}))
