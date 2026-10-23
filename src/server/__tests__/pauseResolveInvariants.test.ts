// The resolve-side §8 invariants (revision-control 4.4, rev4 note-53b0d562's
// T2/T3/T4/T7/T8): the ROUND RULE's supersede-and-drop, the owed fix's
// dispatch-once after the release (H6), Adapt's single new attempt over
// every older row shape (H3 + note-853b6923's dispatch-once), the send-time
// rebuild of an owed failed-round fix (T7), and the review target's
// pending-revision continue (T8). The row tables live in pauseResolve.test.ts
// and pauseResolveAdapt.test.ts; the bench wiring and the paused-target
// worlds live in pauseResolveBench.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import type { AttemptManifest, CiCheck } from '../../shared/planExecution'
import { planSteps, type PlanSteps } from '../plans/execution/executionPlanner'
import { executionSnapshot } from '../plans/execution/executionSnapshot'
import { dispatchOwedAttempt, type DispatchDeps } from '../plans/execution/executionDispatch'
import { applyRoundStage } from '../plans/execution/executionRounds'
import { assignmentState } from '../team/assignmentStore'
import { REVISION_NOTICE_TAG } from '../team/taskNotices'
import { pauseResolveBench, targetOf, type PauseResolveBench } from './pauseResolveBench'

let wired: PauseResolveBench
let sequence = 0

beforeAll(async () => {
  wired = await pauseResolveBench('pause-resolve-invariants')
})

afterAll(() => {
  wired.close()
})

function ok<T>(outcome: { ok: boolean; result?: T; message?: string }): T {
  if (!outcome.ok || outcome.result === undefined) throw new Error(outcome.ok ? 'the command wrote nothing' : (outcome.message ?? 'refused'))
  return outcome.result
}

function noticeMails(taskId: string) {
  return wired.bench.mail.forTask(taskId).filter(message => message.tags.includes(REVISION_NOTICE_TAG))
}

/** The inline-dispatch precondition the bench's fixtures skip: a baseline commit, then the hold released so the gate reads open. */
function openGate(planId: string, executionId: string): void {
  const row = wired.executions.change(executionId, 'api')!
  expect(wired.executions.transition(executionId, 'api', row, { baselineCommit: 'base' })).not.toBeNull()
  const released = wired.holds.release({ teamId: wired.teamId, holdId: wired.holds.forPlan(wired.teamId, planId)[0].id, changes: ['api'], reason: 'the dispatch may go', commandId: `release-${++sequence}` })
  expect(released.written).toBe(true)
}

/** A dispatch key on the change's newest attempt row. */
function attemptKey(executionId: string, change: string): string {
  const generation = wired.executions.change(executionId, change)!.generation
  const number = wired.executions.attempts(executionId, change).at(-1)!.number
  return `exec:${executionId}:${change}:attempt:${number}:${generation}`
}

/** One failing CI check by name (the round rows T7's rebuild reads). */
function failingCi(name: string): CiCheck {
  return { name, source: 'actions', conclusion: 'failure', link: null, runId: 11, startedAt: null, completedAt: null }
}

/** The production planner over the bench stores — the executor's exact readers, so the plan is what a tick would run. */
function planFor(): PlanSteps {
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

/** The dispatch deps behind `dispatchOwedAttempt` — the bench stores behind the executor's shapes. */
function depsFor(): DispatchDeps {
  return {
    team: wired.world.team,
    executions: wired.executions,
    plans: wired.bench.plans,
    tasks: wired.tasks,
    assignments: wired.assignments,
    results: wired.roundDeps().results,
  }
}

// T2 | paused (attempt) | continue | passable round pends N | accepted —
// the supersede alone is the drop: the round reads superseded, its live
// effects are cancelled, the change stays where the round insert put it
// (gating, no step — the slot-releasing transition never runs, N4), no new
// attempt mints, and one resume names the newest revision. The
// revisionPending-guarded drop leaves the planner nothing to dispatch (the
// H5 write-nothing under the still-covered gate).
test('T2: Continue on an attempt target supersedes the passable pending round, leaves the change at the round\'s own gating state with no slot-releasing transition, creates no attempt, and sends one resume naming the newest revision', async () => {
  const world = await wired.pausedAttempt()
  const roundId = wired.answerNewestRow(world.executionId, 'api', 1)
  const effect = wired.executions.insertEffect({ executionId: world.executionId, change: 'api', roundId, kind: 'push', effectKey: `push:${roundId}`, command: {} })
  wired.republish(world.taskId)
  ok(await wired.resolve({ planId: world.planId, pauseId: world.pauseId, change: 'api', choice: 'continue' }))
  const round = wired.executions.round(roundId)!
  expect(round.outcome).toBe('superseded')
  expect(wired.executions.effectsOf(world.executionId).find(candidate => candidate.id === effect.id)?.state).toBe('cancelled')
  expect(wired.executions.attempts(world.executionId, 'api')).toHaveLength(1)
  expect(wired.executions.change(world.executionId, 'api')).toMatchObject({ state: 'gating', step: null })
  const resumes = wired.resumeMails(world.taskId)
  expect(resumes).toHaveLength(1)
  expect(resumes[0].body).toContain('revision 2')
  expect(resumes[0].body).not.toContain('Continue from checkpoint')
  const steps = planFor()
  expect(steps.dispatches.filter(step => step.change === 'api')).toHaveLength(0)
  expect(steps.stages.filter(step => step.change === 'api')).toHaveLength(0)
})

/** A failed round with its D12 fix step applied by hand: the round fails CI, the change returns to `implementing` with its dispatch facts (the fix dispatch's guard needs the baseline), and the owed fix row answers the round — the world every pre-gate owed-fix test starts from. */
async function failedRoundWithOwedFix(taskId: string, executionId: string): Promise<string> {
  const roundId = wired.answerNewestRow(executionId, 'api', 1)
  wired.executions.setRoundCi(roundId, [failingCi('lint')], null)
  wired.executions.decideRound(roundId, 'fail')
  const row = wired.executions.change(executionId, 'api')!
  // The D12 fix step's own transition: the owed step plans a fix only at
  // `implementing`, and the dispatch facts ride the same transition.
  expect(wired.executions.transition(executionId, 'api', row, { state: 'implementing', baselineCommit: 'base' })).not.toBeNull()
  const result = wired.tasks.store.results.listByTask(taskId).at(-1)!
  wired.mintOwed(executionId, 'api', 'fix', {
    ...wired.manifest(),
    answers: { resultId: result.id, roundId, failingChecks: [], findingsIds: [] },
  })
  return roundId
}

// T3 | paused (attempt) | continue | a pre-gate owed fix | the H6 owed
// step: the resolution touches the owed row and dispatches nothing while
// the hold stands; the release opens the gate, the planner owes the owed
// dispatch exactly once, and `dispatchOwedAttempt` sends one fix handoff
// under the row's own key — a second pass owes nothing.
test('T3: a pre-gate owed fix dispatches exactly once after Continue and the hold\'s release', async () => {
  const world = await wired.pausedAttempt()
  await failedRoundWithOwedFix(world.taskId, world.executionId)
  ok(await wired.resolve({ planId: world.planId, pauseId: world.pauseId, change: 'api', choice: 'continue' }))
  expect(wired.resumeMails(world.taskId)).toHaveLength(1)
  expect(planFor().dispatches.filter(step => step.change === 'api')).toHaveLength(0)
  const released = wired.holds.release({ teamId: wired.teamId, holdId: wired.holds.forPlan(wired.teamId, world.planId)[0].id, changes: ['api'], reason: 'resume', commandId: `release-${++sequence}` })
  expect(released.written).toBe(true)
  expect(planFor().dispatches.filter(step => step.change === 'api'))
    .toEqual([{ executionId: world.executionId, change: 'api', group: 'middle-devs', kind: 'owed' }])
  const mails = wired.bench.mail.forTask(world.taskId).length
  await dispatchOwedAttempt(depsFor(), { executionId: world.executionId, change: 'api', group: 'middle-devs' })
  const row = wired.executions.attempts(world.executionId, 'api').at(-1)!
  expect(row.kind).toBe('fix')
  expect(row.assignmentId).not.toBeNull()
  expect(wired.bench.assignmentStore.byId(row.assignmentId!)?.requestKey).toBe(attemptKey(world.executionId, 'api'))
  expect(wired.bench.mail.forTask(world.taskId)).toHaveLength(mails + 1)
  expect(planFor().dispatches.filter(step => step.change === 'api')).toHaveLength(0)
})

// T4's shared assertions: with the gate opened before the resolve, Adapt
// publishes revision N+1, mints exactly ONE new fix row carrying the newest
// revision and the pre-transaction head, dispatches it inline under its own
// key, and never sends an older row's key. `olderNumbers` are the attempt
// numbers that must stay dispatch-free; `assertRound` reads the world's
// round expectation.
async function assertAdaptOnce(world: { planId: string; executionId: string; taskId: string; pauseId: string }, olderNumbers: number[], assertRound: (roundId: string | null) => void, revisionsBefore: number): Promise<void> {
  openGate(world.planId, world.executionId)
  const rounds = wired.executions.rounds(world.executionId, 'api')
  const mails = wired.bench.mail.forTask(world.taskId).length
  ok(await wired.resolve({ planId: world.planId, pauseId: world.pauseId, change: 'api', choice: 'adapt', adapt: 'Build it wider', rationale: 'scope grew' }))
  assertRound(rounds.length > 0 ? rounds[0].id : null)
  expect(wired.tasks.store.revisions(world.taskId)).toHaveLength(revisionsBefore + 1)
  expect(noticeMails(world.taskId)).toHaveLength(1)
  const attempts = wired.executions.attempts(world.executionId, 'api')
  expect(attempts.at(-1)!.kind).toBe('fix')
  expect(attempts.at(-1)!.manifest.task).toMatchObject({ id: world.taskId, revision: revisionsBefore + 1 })
  expect(attempts.at(-1)!.manifest.startCommit).toBe('adapt-head-sha')
  expect(attempts.at(-1)!.assignmentId).not.toBeNull()
  expect(wired.bench.assignmentStore.byId(attempts.at(-1)!.assignmentId!)?.requestKey).toBe(attemptKey(world.executionId, 'api'))
  for (const number of olderNumbers) {
    expect(wired.tasks.store.assignmentsOf(world.taskId).some(row => row.requestKey?.includes(`attempt:${number}:`))).toBe(false)
  }
  // One dispatch: exactly one new instruction mail beside the notice.
  expect(wired.bench.mail.forTask(world.taskId)).toHaveLength(mails + 2)
}

// T4 | paused (attempt) | adapt | every older-row shape | accepted — H3's
// own-row insert plus note-853b6923's dispatch-once: whatever the newest
// row was (no row, a claimed failed-round fix, an owed fix, a passable
// round), Adapt mints exactly one new fix row at revision N+1 and dispatches
// it once; the older rows' keys never go out.
test('T4: Adapt makes exactly one new attempt naming revision N+1 — over no round, a claimed failed-round fix, an owed one, and a pending passable round — with one dispatch, and the older row never dispatched', async () => {
  // (a) over no attempt row at all.
  const noRow = await wired.pausedAttempt({ mintAttempt: false })
  await assertAdaptOnce(noRow, [], () => undefined, 1)

  // (b) over a claimed failed-round fix (A6r's world: the fix goes out
  // before the pause, so the pause target names it): the failed round is
  // not passable, so the ROUND RULE leaves it (H2's narrowing — the new row
  // carries the revision instead), and the claimed fix's key is never
  // re-sent.
  const failedWorld = await wired.executionWith(['api'])
  const failedFlight = await wired.inFlight(failedWorld.executionId, 'api')
  const failedRound = wired.answerNewestRow(failedWorld.executionId, 'api', 1)
  wired.executions.setRoundCi(failedRound, [failingCi('lint')], null)
  wired.executions.decideRound(failedRound, 'fail')
  const fixRow = wired.executions.change(failedWorld.executionId, 'api')!
  expect(wired.executions.transition(failedWorld.executionId, 'api', fixRow, { state: 'implementing' })).not.toBeNull()
  const roundResult = wired.tasks.store.results.listByTask(failedFlight.taskId).at(-1)!
  await wired.mintAttempt(failedWorld.executionId, 'api', 'fix', 'dev2', {
    ...wired.manifest(),
    answers: { resultId: roundResult.id, roundId: failedRound, failingChecks: [], findingsIds: [] },
  })
  // The D7 handoff superseded the implement stage's assignment when the fix
  // went out; the bench mints by hand, so the supersede rides here.
  wired.bench.assignmentStore.supersede(failedFlight.assignmentId, 'successor')
  const failedHold = wired.placeHold(failedWorld.planId, ['api'], `hold-${++sequence}`)
  const failedPause = ok(wired.pause({ planId: failedWorld.planId, holdId: failedHold.id, commandId: `pause-${++sequence}` })).pause
  wired.toPaused(failedPause.id, 'api')
  await assertAdaptOnce({ planId: failedWorld.planId, executionId: failedWorld.executionId, taskId: failedFlight.taskId, pauseId: failedPause.id }, [1, 2], roundId => {
    expect(wired.executions.round(roundId!)?.outcome).toBe('fail')
  }, 1)

  // (c) over an owed fix row.
  const owedFix = await wired.pausedAttempt()
  wired.mintOwed(owedFix.executionId, 'api', 'fix')
  await assertAdaptOnce(owedFix, [1, 2], () => undefined, 1)

  // (d) over a passable round pending a revision: the ROUND RULE supersedes
  // it (it pins revision 1, the resolution works from the published 2).
  const pendingRound = await wired.pausedAttempt()
  const supersededRound = wired.answerNewestRow(pendingRound.executionId, 'api', 1)
  wired.republish(pendingRound.taskId)
  await assertAdaptOnce(pendingRound, [1], roundId => {
    expect(wired.executions.round(roundId!)?.outcome).toBe('superseded')
  }, 2)
})

// T7 | paused (attempt) | continue + releaseHold | an owed failed-round fix
// and a revision under the hold | the send-time rebuild: the failed round
// never plans a revision stage (H2), the owed step owes exactly one
// dispatch, and the fix instruction is rebuilt at send time from the round
// it answers — naming the round's failing checks — and goes out exactly
// once (the newest revision rides the task-mail header, not the body).
test('T7: an owed failed-round fix plus a revision under a hold: the release sends exactly one fix, naming its checks', async () => {
  const world = await wired.pausedAttempt()
  await failedRoundWithOwedFix(world.taskId, world.executionId)
  wired.republish(world.taskId)
  ok(await wired.resolve({ planId: world.planId, pauseId: world.pauseId, change: 'api', choice: 'continue', releaseHold: true }))
  // The release landed inside the resolve; the failed round plans no stage.
  expect(wired.holds.forPlan(wired.teamId, world.planId)[0].releasedAt).not.toBeNull()
  expect(planFor().stages.filter(step => step.change === 'api')).toHaveLength(0)
  expect(planFor().dispatches.filter(step => step.change === 'api'))
    .toEqual([{ executionId: world.executionId, change: 'api', group: 'middle-devs', kind: 'owed' }])
  const mails = wired.bench.mail.forTask(world.taskId).length
  await dispatchOwedAttempt(depsFor(), { executionId: world.executionId, change: 'api', group: 'middle-devs' })
  const row = wired.executions.attempts(world.executionId, 'api').at(-1)!
  const instruction = wired.bench.mail.get(wired.bench.assignmentStore.byId(row.assignmentId!)?.messageId ?? '')
  expect(instruction?.body).toContain('lint')
  expect(instruction?.body).toContain('- lint: failure')
  expect(wired.bench.mail.forTask(world.taskId)).toHaveLength(mails + 1)
  expect(planFor().dispatches.filter(step => step.change === 'api')).toHaveLength(0)
})

// T8 (continue side of H5) | paused (review) | continue | a passable round
// pends a revision | accepted — no drop and no resume: the decision records
// `revisionPending N` and the round stays open. The revision stage is a
// decision stage and plans under the hold; its fix dispatch is gated
// inside — the row mints owed, no handoff. The release sends it exactly
// once, naming the republished revision; a second pass owes nothing.
test('T8: a review target with a passable round pending a revision: no drop and no resume; the detail records revisionPending N; after the decision D9\'s fix dispatches once', async () => {
  const world = await wired.pausedReview({ pending: true })
  ok(await wired.resolve({ planId: world.planId, pauseId: world.pauseId, change: 'api', choice: 'continue' }))
  expect(targetOf(wired, world.pauseId, 'api').decisionDetail).toMatchObject({ revisionPending: 2 })
  expect(wired.resumeMails(world.taskId)).toHaveLength(0)
  const roundId = wired.executions.rounds(world.executionId, 'api')[0].id
  expect(wired.executions.round(roundId)?.outcome).toBeNull()
  // The dispatch facts the fix attempt's guard needs (the bench's fixtures
  // skip provisioning); the hold stays active.
  const row = wired.executions.change(world.executionId, 'api')!
  expect(wired.executions.transition(world.executionId, 'api', row, { baselineCommit: 'base' })).not.toBeNull()
  const heldStages = planFor().stages.filter(step => step.change === 'api')
  expect(heldStages).toEqual([{ executionId: world.executionId, change: 'api', kind: 'revision', roundId, resultId: null }])
  const mails = wired.bench.mail.forTask(world.taskId).length
  await applyRoundStage({ ...wired.roundDeps(), gate: () => true }, wired.executions.change(world.executionId, 'api')!, heldStages[0])
  // The gated stage: the round supersedes, the fix row mints OWED, and no
  // handoff rides it.
  expect(wired.executions.round(roundId)?.outcome).toBe('superseded')
  expect(wired.executions.change(world.executionId, 'api')).toMatchObject({ state: 'implementing', step: null })
  expect(wired.executions.attempts(world.executionId, 'api')).toHaveLength(2)
  expect(wired.executions.attempts(world.executionId, 'api')[1].kind).toBe('fix')
  expect(wired.executions.attempts(world.executionId, 'api')[1].assignmentId).toBeNull()
  expect(wired.bench.mail.forTask(world.taskId)).toHaveLength(mails)
  const released = wired.holds.release({ teamId: wired.teamId, holdId: wired.holds.forPlan(wired.teamId, world.planId)[0].id, changes: ['api'], reason: 'resume', commandId: `release-${++sequence}` })
  expect(released.written).toBe(true)
  expect(planFor().dispatches.filter(step => step.change === 'api'))
    .toEqual([{ executionId: world.executionId, change: 'api', group: 'middle-devs', kind: 'owed' }])
  await dispatchOwedAttempt(depsFor(), { executionId: world.executionId, change: 'api', group: 'middle-devs' })
  const fixRow = wired.executions.attempts(world.executionId, 'api')[1]
  const instruction = wired.bench.mail.get(wired.bench.assignmentStore.byId(fixRow.assignmentId!)?.messageId ?? '')
  expect(instruction?.body).toContain('revision 2')
  expect(wired.bench.mail.forTask(world.taskId)).toHaveLength(mails + 1)
  const second = planFor()
  expect(second.stages.filter(step => step.change === 'api')).toHaveLength(0)
  expect(second.dispatches.filter(step => step.change === 'api')).toHaveLength(0)
})
