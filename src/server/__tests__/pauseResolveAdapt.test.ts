// The resolve command's adapt rows (revision-control 4.4, A3's A-rows):
// the state rows and the two dispatch arms here; the row-variant table and
// the completeness grid live in pauseResolveAdaptRows.test.ts. The bench
// wiring and the paused-target worlds live in pauseResolveBench.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { REVISION_NOTICE_TAG } from '../team/taskNotices'
import { pauseResolveBench, targetOf, type PauseResolveBench } from './pauseResolveBench'

let wired: PauseResolveBench
let sequence = 0

beforeAll(async () => {
  wired = await pauseResolveBench('pause-resolve-adapt')
})

afterAll(() => {
  wired.close()
})

function ok<T>(outcome: { ok: boolean; result?: T; message?: string }): T {
  if (!outcome.ok || outcome.result === undefined) throw new Error(outcome.ok ? 'the command wrote nothing' : (outcome.message ?? 'refused'))
  return outcome.result
}

function refusal(outcome: { ok: boolean; reason?: string; message?: string }): { reason: string; message: string } {
  if (outcome.ok) throw new Error('expected a refusal')
  return { reason: outcome.reason ?? '', message: outcome.message ?? '' }
}

function noticeMails(taskId: string) {
  return wired.bench.mail.forTask(taskId).filter(message => message.tags.includes(REVISION_NOTICE_TAG))
}

// A1r | decided | adapt | * | * | refused, naming the standing decision (I1)
test('A1r: a decided target refuses adapt naming the standing decision (I1 before the choice dispatch, N2)', async () => {
  const world = await wired.pausedAttempt()
  const decided = await wired.resolve({ planId: world.planId, pauseId: world.pauseId, change: 'api', choice: 'continue' })
  expect(decided.ok).toBe(true)
  const outcome = await wired.resolve({ planId: world.planId, pauseId: world.pauseId, change: 'api', choice: 'adapt', adapt: 'Rework it', rationale: 'the direction moved' })
  const { reason, message } = refusal(outcome)
  expect(reason).toBe('state')
  // The refusal names the standing decision — the pre-move stub refused the
  // choice first with a message that named none, so this detects its return.
  expect(message).toMatch(/already decided \(continue\)/)
  expect(message).toMatch(/Nothing was written/)
})

// A9r | pausing·* | adapt | * | * | refused `not-paused`
test('A9r: a still-pausing target refuses adapt with not-paused', async () => {
  const { planId, executionId } = await wired.executionWith(['api'])
  await wired.inFlight(executionId, 'api')
  const hold = wired.placeHold(planId, ['api'], `hold-${++sequence}`)
  const pause = ok(wired.pause({ planId, holdId: hold.id, commandId: `pause-${++sequence}` })).pause
  expect(refusal(await wired.resolve({ planId, pauseId: pause.id, change: 'api', choice: 'adapt', adapt: 'Rework', rationale: 'move' })).reason).toBe('not-paused')
  expect(wired.resolvedEvents(planId)).toHaveLength(0)
})

// A10r | review target | adapt | * | * | refused `review-target`
test('A10r: a review target refuses adapt with review-target', async () => {
  const world = await wired.pausedReview()
  const { reason } = refusal(await wired.resolve({ planId: world.planId, pauseId: world.pauseId, change: 'api', choice: 'adapt', adapt: 'Rework', rationale: 'move' }))
  expect(reason).toBe('review-target')
  expect(wired.resolvedEvents(world.planId)).toHaveLength(0)
  expect(wired.executions.rounds(world.executionId, 'api')[0].outcome).toBeNull()
})

// A8r | paused·withdrawn (attempt stage) | adapt | * | * | accepted - the
// withdraw recorded Paused; publishes; the stop-branch supersession is a
// no-op (the assignment is already superseded), so no live holder is notified
test('A8r: adapt over a withdrawn target publishes and notifies no one', async () => {
  const { planId, executionId } = await wired.executionWith(['api'])
  const flight = await wired.inFlight(executionId, 'api', 'dev', 'queued')
  const hold = wired.placeHold(planId, ['api'], `hold-${++sequence}`)
  const pause = ok(wired.pause({ planId, holdId: hold.id, commandId: `pause-${++sequence}` })).pause
  ok(await wired.resolve({ planId, pauseId: pause.id, change: 'api', choice: 'adapt', adapt: 'Reworked direction', rationale: 'the lead rethought it' }))
  const target = targetOf(wired, pause.id, 'api')
  expect(target.decision).toBe('adapt')
  expect(target.decisionDetail?.release).toBe('never')
  // The publication stands; nobody is notified — the withdrawn target has
  // no outstanding assignment to name a claimant.
  const revisions = wired.tasks.store.revisions(flight.taskId)
  expect(revisions).toHaveLength(2)
  expect(revisions[1].direction).toBe('Reworked direction')
  expect(noticeMails(flight.taskId)).toHaveLength(0)
  // The stop-branch writes were no-ops: the instruction stays as the
  // withdraw left it (cancelled), the row superseded by the pause.
  expect(wired.bench.mail.get(flight.assignmentId === undefined ? '' : (wired.bench.assignmentStore.byId(flight.assignmentId)?.messageId ?? ''))?.state).toBe('cancelled')
  expect(wired.bench.assignmentStore.byId(flight.assignmentId)?.supersededBy).toBe(pause.id)
  // The new fix row is owed (the hold still covers the change).
  const attempts = wired.executions.attempts(executionId, 'api')
  expect(attempts).toHaveLength(2)
  expect(attempts[1].kind).toBe('fix')
  expect(attempts[1].assignmentId).toBeNull()
})

// A11r | paused·gone (attempt stage) | adapt | * | * | accepted - no
// holder-gone refusal; the notices to the gone session dead-letter at
// enqueue (Q-A7)
test('A11r: adapt over a paused target whose holder is gone publishes, dead-letters the notice', async () => {
  const world = await wired.pausedAttempt({ holder: 'ghost' })
  ok(await wired.resolve({ planId: world.planId, pauseId: world.pauseId, change: 'api', choice: 'adapt', adapt: 'Rework it', rationale: 'the direction moved' }))
  const target = targetOf(wired, world.pauseId, 'api')
  expect(target.decision).toBe('adapt')
  const notices = noticeMails(world.taskId)
  expect(notices).toHaveLength(1)
  expect(notices[0].state).toBe('dead')
  // The new fix row exists; the held assignment is superseded.
  const attempts = wired.executions.attempts(world.executionId, 'api')
  expect(attempts).toHaveLength(2)
  expect(wired.bench.assignmentStore.byId(world.assignmentId)?.supersededBy).toBe(world.pauseId)
})

// A2r | paused (attempt stage) | adapt | * | — | accepted — the owed arm:
// the hold still covers the change, so the new row dispatches once the gate
// opens (dispatched by the owed step on release)
test('A2r: adapt over a target with no attempt row publishes revision N+1 and mints one owed fix row', async () => {
  const world = await wired.pausedAttempt({ mintAttempt: false })
  const before = wired.resolvedEvents(world.planId).length
  ok(await wired.resolve({ planId: world.planId, pauseId: world.pauseId, change: 'api', choice: 'adapt', adapt: 'Build it wider', rationale: 'scope grew', commandId: 'adapt-owed-1' }))
  // The publication: revision 2 under `pause:<commandId>`, notify carried.
  const revisions = wired.tasks.store.revisions(world.taskId)
  expect(revisions).toHaveLength(2)
  expect(revisions[1].direction).toBe('Build it wider')
  expect(revisions[1].notify).toBe(true)
  const key = wired.bench.db.db.prepare('SELECT request_key FROM team_task_revisions WHERE task_id = ? AND revision = 2').get(world.taskId) as { request_key: string | null }
  expect(key.request_key).toBe('pause:adapt-owed-1')
  // The notice reached the paused holder BEFORE the supersession; no resume.
  const notices = noticeMails(world.taskId)
  expect(notices).toHaveLength(1)
  expect(notices[0].state).toBe('queued')
  expect(wired.resumeMails(world.taskId)).toHaveLength(0)
  // The decision {release 'never'}, the held assignment superseded through
  // the stop branch, its claimed instruction untouched (P-I2).
  const target = targetOf(wired, world.pauseId, 'api')
  expect(target.decision).toBe('adapt')
  expect(target.decisionDetail).toMatchObject({ release: 'never', taskRevision: 2 })
  expect(wired.bench.assignmentStore.byId(world.assignmentId)?.supersededBy).toBe(world.pauseId)
  const held = wired.bench.assignmentStore.byId(world.assignmentId)
  expect(wired.bench.mail.get(held?.messageId ?? '')?.state).toBe('claimed')
  // ONE new attempt row: kind fix at revision N+1, startCommit from the
  // pre-transaction read; owed (the hold covers the change).
  const attempts = wired.executions.attempts(world.executionId, 'api')
  expect(attempts).toHaveLength(1)
  expect(attempts[0].kind).toBe('fix')
  expect(attempts[0].assignmentId).toBeNull()
  expect(attempts[0].manifest.task).toMatchObject({ id: world.taskId, revision: 2 })
  expect(attempts[0].manifest.startCommit).toBe('adapt-head-sha')
  expect(wired.executions.change(world.executionId, 'api')?.state).toBe('implementing')
  expect(wired.resolvedEvents(world.planId)).toHaveLength(before + 1)
})

// A2r's inline arm: with the hold released before the resolve, the gate —
// read after the decision — is open, and the new row dispatches in the
// resolve's own transaction under its attempt key.
test('A2r: with the gate open the new fix row dispatches inline under its attempt key', async () => {
  const world = await wired.pausedAttempt()
  expect(wired.executions.attempts(world.executionId, 'api')).toHaveLength(1)
  // The bench's inFlight skips provisioning: the baseline commit lands with
  // the worktree in production. The dispatch's facts guard needs it.
  const row = wired.executions.change(world.executionId, 'api')!
  expect(wired.executions.transition(world.executionId, 'api', row, { baselineCommit: 'base' })).not.toBeNull()
  const released = wired.holds.release({ teamId: wired.teamId, holdId: wired.holds.forPlan(wired.teamId, world.planId)[0].id, changes: ['api'], reason: 'the dispatch may go', commandId: `release-${++sequence}` })
  expect(released.written).toBe(true)
  ok(await wired.resolve({ planId: world.planId, pauseId: world.pauseId, change: 'api', choice: 'adapt', adapt: 'Build it wider', rationale: 'scope grew' }))
  const attempts = wired.executions.attempts(world.executionId, 'api')
  expect(attempts).toHaveLength(2)
  expect(attempts[1].kind).toBe('fix')
  // The row is stamped: the dispatch committed inside the transaction.
  expect(attempts[1].assignmentId).not.toBeNull()
  const assignment = wired.bench.assignmentStore.byId(attempts[1].assignmentId!)
  expect(assignment).not.toBeNull()
  const generation = wired.executions.change(world.executionId, 'api')!.generation
  expect(assignment?.requestKey).toBe(`exec:${world.executionId}:api:attempt:2:${generation}`)
  // The instruction mail: one normal group message from Kawai.
  const instruction = wired.bench.mail.get(assignment?.messageId ?? '')
  expect(instruction?.toKind).toBe('group')
  expect(instruction?.toId).toBe('middle-devs')
  expect(instruction?.fromKind).toBe('system')
  expect(instruction?.body).toContain('revision 2')
  expect(instruction?.body).toContain('Re-apply your work on top of the new direction')
  // The superseded implement attempt's round stays untouched; the event stands.
  expect(wired.executions.rounds(world.executionId, 'api')).toHaveLength(0)
  expect(wired.resolvedEvents(world.planId)).toHaveLength(1)
})
