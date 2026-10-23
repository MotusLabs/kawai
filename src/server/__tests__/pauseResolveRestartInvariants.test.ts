// The restart-side §8 invariants (revision-control 4.4, rev4 note-53b0d562's
// T5) and R01's carried I6 clause: the restart's own-row insert over every
// older-row shape (H3) with H4's implement guard and no D9 fix after, and
// the rows-survive restart. The dispatch arms and the R2 release
// bookkeeping live in pauseResolveRestart.test.ts; the bench wiring and the
// paused-target worlds live in pauseResolveBench.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import type { CiCheck } from '../../shared/planExecution'
import { planSteps } from '../plans/execution/executionPlanner'
import { executionSnapshot } from '../plans/execution/executionSnapshot'
import { assignmentState } from '../team/assignmentStore'
import { pauseResolveBench, targetOf, type PauseResolveBench } from './pauseResolveBench'

let wired: PauseResolveBench
let sequence = 0

beforeAll(async () => {
  wired = await pauseResolveBench('pause-resolve-restart-invariants')
})

afterAll(() => {
  wired.close()
})

function ok<T>(outcome: { ok: boolean; result?: T; message?: string }): T {
  if (!outcome.ok || outcome.result === undefined) throw new Error(outcome.ok ? 'the command wrote nothing' : (outcome.message ?? 'refused'))
  return outcome.result
}

/** The inline-dispatch precondition the bench's fixtures skip: a baseline commit, then the hold released so the gate reads open. */
function openGate(planId: string, executionId: string): void {
  const row = wired.executions.change(executionId, 'api')!
  expect(wired.executions.transition(executionId, 'api', row, { baselineCommit: 'base' })).not.toBeNull()
  const released = wired.holds.release({ teamId: wired.teamId, holdId: wired.holds.forPlan(wired.teamId, planId)[0].id, changes: ['api'], reason: 'the dispatch may go', commandId: `release-${++sequence}` })
  expect(released.written).toBe(true)
}

/** One failing CI check by name (the owed fix's round rows). */
function failingCi(name: string): CiCheck {
  return { name, source: 'actions', conclusion: 'failure', link: null, runId: 11, startedAt: null, completedAt: null }
}

/** The production planner over the bench stores — the executor's exact readers, so the plan is what a tick would run. */
function planFor() {
  const snapshot = executionSnapshot(wired.teamId, wired.world.repo, wired.executions, wired.bench.plans,
    taskId => wired.tasks.store.results.listByTask(taskId)
      .map(result => ({ id: result.id, commit: result.commit, taskRevision: result.taskRevision, submittedBySession: result.submittedBy.kind === 'agent' ? result.submittedBy.sessionId : null }))
      .reverse(),
    taskId => wired.tasks.store.get(taskId)?.revision ?? 1,
    taskId => wired.tasks.store.get(taskId)?.status ?? 'active',
    taskId => {
      const outstanding = wired.tasks.store.assignmentsOf(taskId).filter(row => row.supersededBy === null).at(-1)
      if (outstanding === undefined) return null
      const state = assignmentState(outstanding, outstanding.messageId !== null ? wired.bench.mail.get(outstanding.messageId) : null)
      return { id: outstanding.id, state: state.state, reason: state.reason, requestKey: outstanding.requestKey ?? null }
    },
    taskId => wired.tasks.store.assignmentsOf(taskId).map(row => ({ requestKey: row.requestKey })),
    planId => wired.holds.active(wired.teamId, planId).map(hold => ({ id: hold.id, scope: hold.scope, changes: hold.changes })),
    planId => wired.pauses.forPlan(wired.teamId, planId, true).flatMap(pause => wired.pauses.targets(pause.id).map(row => ({ pauseId: pause.id, change: row.change, decision: row.decision }))))
  return planSteps(snapshot, wired.now().toISOString())
}

// T5 | paused (attempt) | restart | an owed row, and a pending revision |
// accepted — H3's own-row insert and H4: whatever the older rows were, the
// restart mints exactly ONE new attempt carrying the checkpoint and its
// startCommit, dispatches it once with the gate open, and the older owed
// row never dispatches; the implement step does not duplicate the new row
// and no D9 fix follows.
test('T5: Restart over an owed row and over a pending revision makes exactly one attempt carrying checkpoint and startCommit; the owed row never dispatches, the implement step does not duplicate it, and no D9 fix follows', async () => {
  // (a) over an owed fix row (a failed round's D12 fix, pre-gate).
  const owedWorld = await wired.pausing({ checkpoint: { kind: 'commit', effectState: 'done' } })
  const owedRound = wired.answerNewestRow(owedWorld.executionId, 'api', 1)
  wired.executions.setRoundCi(owedRound, [failingCi('lint')], null)
  wired.executions.decideRound(owedRound, 'fail')
  const owedRow = wired.executions.change(owedWorld.executionId, 'api')!
  expect(wired.executions.transition(owedWorld.executionId, 'api', owedRow, { state: 'implementing', baselineCommit: 'base' })).not.toBeNull()
  const owedResult = wired.tasks.store.results.listByTask(owedWorld.taskId).at(-1)!
  wired.mintOwed(owedWorld.executionId, 'api', 'fix', {
    ...wired.manifest(),
    answers: { resultId: owedResult.id, roundId: owedRound, failingChecks: [], findingsIds: [] },
  })
  wired.toPaused(owedWorld.pauseId, 'api')
  openGate(owedWorld.planId, owedWorld.executionId)
  ok(await wired.resolve({ planId: owedWorld.planId, pauseId: owedWorld.pauseId, change: 'api', choice: 'restart' }))
  const owedAttempts = wired.executions.attempts(owedWorld.executionId, 'api')
  expect(owedAttempts).toHaveLength(3)
  expect(owedAttempts[2].kind).toBe('fix')
  expect(owedAttempts[2].assignmentId).not.toBeNull()
  expect(owedAttempts[2].manifest.task).toMatchObject({ id: owedWorld.taskId, revision: 1 })
  expect(owedAttempts[2].manifest.startCommit).toBe('checkpoint-sha')
  const checkpoint = wired.checkpoints.newest(owedWorld.pauseId, 'api')
  expect(owedAttempts[2].manifest.checkpoint).toEqual({ id: checkpoint!.id, commit: 'checkpoint-sha' })
  // The owed row's key never went out.
  expect(wired.tasks.store.assignmentsOf(owedWorld.taskId).some(row => row.requestKey?.includes(`attempt:${owedAttempts[1].number}:`))).toBe(false)
  // The new row is stamped: no owed dispatch, no implement duplicate, no
  // D9 fix for the failed round.
  const owedPlan = planFor()
  expect(owedPlan.dispatches.filter(step => step.change === 'api')).toHaveLength(0)
  expect(owedPlan.stages.filter(step => step.change === 'api')).toHaveLength(0)

  // (b) over a passable round pending a revision: the ROUND RULE
  // supersedes it (it pins revision 1, the restart works from 2), one new
  // implement row mints at revision 2 carrying the checkpoint, and no D9
  // fix follows the supersession.
  const pendingWorld = await wired.pausing({ checkpoint: { kind: 'commit', effectState: 'done' } })
  wired.toPaused(pendingWorld.pauseId, 'api')
  const pendingRound = wired.answerNewestRow(pendingWorld.executionId, 'api', 1)
  wired.republish(pendingWorld.taskId)
  openGate(pendingWorld.planId, pendingWorld.executionId)
  ok(await wired.resolve({ planId: pendingWorld.planId, pauseId: pendingWorld.pauseId, change: 'api', choice: 'restart' }))
  expect(wired.executions.round(pendingRound)?.outcome).toBe('superseded')
  const pendingAttempts = wired.executions.attempts(pendingWorld.executionId, 'api')
  expect(pendingAttempts).toHaveLength(2)
  expect(pendingAttempts[1].kind).toBe('implement')
  expect(pendingAttempts[1].assignmentId).not.toBeNull()
  expect(pendingAttempts[1].manifest.task).toMatchObject({ id: pendingWorld.taskId, revision: 2 })
  expect(pendingAttempts[1].manifest.startCommit).toBe('checkpoint-sha')
  const pendingCheckpoint = wired.checkpoints.newest(pendingWorld.pauseId, 'api')
  expect(pendingAttempts[1].manifest.checkpoint).toEqual({ id: pendingCheckpoint!.id, commit: 'checkpoint-sha' })
  expect(wired.tasks.store.assignmentsOf(pendingWorld.taskId).some(row => row.requestKey?.includes(`attempt:1:`))).toBe(false)
  const pendingPlan = planFor()
  expect(pendingPlan.dispatches.filter(step => step.change === 'api')).toHaveLength(0)
  expect(pendingPlan.stages.filter(step => step.change === 'api')).toHaveLength(0)
})

// R01 (carried I6) | paused (attempt) | restart and continue | * | accepted
// — the rows survive the decision: the execution row, the attempt rows, and
// this pause's own checkpoint row all keep their identity through a
// restart, and Continue mints no attempt of its own.
test('restart with a Paused target keeps execution, attempt, and checkpoint; continue creates no attempt', async () => {
  const restartWorld = await wired.pausing({ checkpoint: { kind: 'commit', effectState: 'done' } })
  wired.toPaused(restartWorld.pauseId, 'api')
  const beforeCheckpoint = wired.checkpoints.newest(restartWorld.pauseId, 'api')
  expect(beforeCheckpoint).not.toBeNull()
  openGate(restartWorld.planId, restartWorld.executionId)
  ok(await wired.resolve({ planId: restartWorld.planId, pauseId: restartWorld.pauseId, change: 'api', choice: 'restart' }))
  const execution = wired.executions.execution(restartWorld.executionId)
  expect(execution).not.toBeNull()
  expect(execution).toMatchObject({ id: restartWorld.executionId, planId: restartWorld.planId, state: 'running' })
  expect(wired.executions.attempts(restartWorld.executionId, 'api')).toHaveLength(2)
  const afterCheckpoint = wired.checkpoints.newest(restartWorld.pauseId, 'api')
  expect(afterCheckpoint?.id).toBe(beforeCheckpoint!.id)

  const continueWorld = await wired.pausedAttempt()
  ok(await wired.resolve({ planId: continueWorld.planId, pauseId: continueWorld.pauseId, change: 'api', choice: 'continue' }))
  expect(wired.executions.attempts(continueWorld.executionId, 'api')).toHaveLength(1)
  expect(targetOf(wired, continueWorld.pauseId, 'api').decision).toBe('continue')
})
