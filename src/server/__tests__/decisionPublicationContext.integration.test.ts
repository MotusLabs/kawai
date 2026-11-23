import { expect, test } from 'bun:test'
import { mulberry32 } from '../../shared/__tests__/contractFixtures'
import { ExecutionStore } from '../plans/execution/executionStore'
import { ExecutionRevisionStore } from '../plans/revisionControl/executionRevisionStore'
import { PauseStore } from '../plans/revisionControl/pauseStore'
import { HUMAN } from './helpers/decisionPublicationBench'
import { beginAfterCheck, bind, ordinary, prepare, prepared, type ApprovalCommand, type PublicationRuntime } from './helpers/decisionPublicationCommands'
import { publicationRuntime } from './helpers/decisionPublicationRuntime'
import { propertyCases } from './helpers/propertyCases'

async function refuseStale(runtime: PublicationRuntime, approve: ApprovalCommand, reason: string) {
  await runtime.settleDelivery()
  const before = runtime.snapshot()
  const failed = await runtime.routed('team-plan-result', approve)
  expect(failed).toMatchObject({ reason: 'stale', error: expect.stringContaining(reason) })
  expect(failed.publication).toBeUndefined()
  expect(failed.decision).toBeUndefined()
  expect(runtime.snapshot()).toEqual(before)
}

const CONTEXT_MOVES: Array<[string, string, (runtime: PublicationRuntime) => void]> = [
  ['current approval', 'approvedPlanRevision', runtime => { runtime.advanceApproval() }],
  ['execution revision', 'execution', ({ db, execution, approved }) => {
    db.db.query('UPDATE plan_executions SET revision = ?, content_hash = ? WHERE id = ?').run(approved.revision, approved.contentHash, execution.id)
    new ExecutionRevisionStore(db.db).recordAt(2, {
      executionId: execution.id, revision: approved.revision, contentHash: approved.contentHash, reportId: execution.reportId,
      inputHash: execution.inputHash, rationale: 'Execution adopted the later pin', commandId: null, payload: null, appliedAt: execution.startedAt,
    }, [])
  }],
  ['execution owner', 'owning execution', ({ db, execution }) => {
    db.db.query("UPDATE plan_execution_changes SET owns = 0 WHERE execution_id = ? AND change = 'api'").run(execution.id)
  }],
  ['new attempt', 'execution', ({ db, attempt, execution }) => {
    const store = new ExecutionStore(db.db)
    store.insertAttempt({ executionId: execution.id, change: 'api', kind: 'fix', assignmentId: null,
      manifest: attempt.manifest, manifestHash: attempt.manifestHash })
  }],
  ['change generation', 'execution', ({ db, execution }) => {
    db.db.query("UPDATE plan_execution_changes SET generation = generation + 1 WHERE execution_id = ? AND change = 'api'").run(execution.id)
  }],
]

// @covers: plan-decisions › Fresh approval publishes only the reviewed handoff › A moved base or scope refuses approval
test.each(CONTEXT_MOVES)('W03 moved %s refuses approval while authorized binding replay still works', async (_fact, reason, move) => {
  const runtime = await publicationRuntime()
  try {
    const handoff = await prepare(runtime)
    const { approve, ask, read } = await bind(runtime, handoff)
    move(runtime)
    expect(runtime.manager.tasks.store.get(runtime.task.id)?.revision).toBe(1)
    await refuseStale(runtime, approve, reason)
    const before = runtime.snapshot()
    expect(await runtime.leadTool('decision_ask', ask)).toMatchObject({ card_id: approve.cardId, replayed: true })
    expect((await read()).publication?.receipt).toBeNull()
    expect(runtime.snapshot()).toEqual(before)
  } finally { await runtime.teardown() }
})

test('W03 routed Stop and Retry leave the old review ineligible', async () => {
  const runtime = await publicationRuntime()
  try {
    const { teamPath, routed, execution, task, db } = runtime
    const { approve } = await bind(runtime, await prepare(runtime))
    const store = new ExecutionStore(db.db)
    // Fixture the stopped-change fact produced by an instruction failure.
    // Routing Retry, completing it and trying the prior review use production.
    const row = store.change(execution.id, 'api')!
    expect(store.transition(execution.id, 'api', row, { state: 'stopped', stopReason: 'instruction-failed' })).not.toBeNull()
    const retry = await routed('team-plan-result', { type: 'team-plan-execution-retry', teamPath, requestId: 'real-retry',
      executionId: execution.id, change: 'api', commandId: 'retry-implement' })
    expect(retry.error).toBeUndefined()
    expect(store.change(execution.id, 'api')!.generation).toBeGreaterThan(row.generation)
    expect(runtime.manager.tasks.store.get(task.id)?.revision).toBe(1)
    await refuseStale(runtime, approve, 'execution')
    const stopped = await routed('team-plan-result', { type: 'team-plan-execution-stop', teamPath, requestId: 'real-stop',
      executionId: execution.id, reason: 'Stop this run', commandId: 'stop-execution' })
    expect(stopped.error).toBeUndefined()
    expect(store.execution(execution.id)).toMatchObject({ outcome: 'stopped' })
    expect(runtime.manager.tasks.store.get(task.id)).toMatchObject({ revision: 1, status: 'cancelled' })
    await refuseStale(runtime, { ...approve, requestId: 'after-stop' }, 'closed')
  } finally { await runtime.teardown() }
})

test('W03 a manual linked task without competing execution ownership can be approved', async () => {
  const runtime = await publicationRuntime()
  try {
    const { manager, team, plan, routed, task } = runtime
    const manual = manager.tasks.store.create({ teamId: team.teamId, planId: plan.planId, planChange: 'ui', creator: HUMAN,
      title: 'Manual UI task', direction: 'Write initial copy' })
    runtime.db.db.query("UPDATE plan_execution_changes SET owns = 0 WHERE execution_id = ? AND change = 'ui'").run(runtime.execution.id)
    const handoff = await prepare(runtime, manual.id)
    const { approve, review } = await bind(runtime, handoff)
    expect(review).toMatchObject({ execution: null, change: 'ui', link: { taskId: manual.id } })
    expect(await routed('team-plan-result', approve)).toMatchObject({ publication: { taskId: manual.id, publishedRevision: 2, noticeMessageIds: [] } })
    expect(manager.tasks.store.get(task.id)?.revision).toBe(1)
  } finally { await runtime.teardown() }
})

async function placeHold(runtime: PublicationRuntime, changes: string[]) {
  const { teamPath, plan, routed } = runtime
  const placed = await routed('team-plan-result', { type: 'team-plan-hold-place', teamPath, planId: plan.planId, requestId: 'place-hold',
    scope: 'changes', changes, rationale: 'Owner reviews scope', deadline: new Date(Date.now() + 1800_000).toISOString(), commandId: 'hold-changes' })
  if (!placed.hold) throw new Error(placed.error ?? 'No hold was placed')
  return placed.hold
}

async function pause(runtime: PublicationRuntime) {
  const hold = await placeHold(runtime, ['api'])
  const { routed, teamPath, plan } = runtime
  const paused = await routed('team-plan-result', { type: 'team-plan-pause', teamPath, planId: plan.planId, requestId: 'pause-target',
    holdId: hold.id, deadline: hold.deadline, commandId: 'pause-api' })
  if (!paused.pause) throw new Error(paused.error ?? 'No pause opened')
  return paused.pause
}

async function resolve(runtime: PublicationRuntime, pauseId: string, choice: 'continue' | 'adapt') {
  // The fixture records the settled checkpoint observation, then runs the real resolve command.
  new PauseStore(runtime.db.db).recordPaused(pauseId, 'api', null)
  const outcome = await runtime.routed('team-plan-result', {
    type: 'team-plan-pause-resolve', teamPath: runtime.teamPath, planId: runtime.plan.planId, requestId: 'resolve-target',
    pauseId, change: 'api', choice, adapt: 'Adapted direction', rationale: 'The owner updated scope', commandId: 'resolve-api',
  })
  expect(outcome.error).toBeUndefined()
  expect(outcome.resolution).toMatchObject({ change: 'api', decision: choice })
}

test('I2 seeded execution histories retain the serialized Pause, Continue, Adapt, Stop and Retry winners', async () => {
  const histories = ['continue', 'adapt', 'stop', 'retry'] as const
  for (const [index, mode] of histories.entries()) {
    const runtime = await publicationRuntime()
    const random = mulberry32(0xDEC10002 ^ index)
    try {
      const { routed, teamPath, task, execution, db } = runtime
      const handoff = await prepare(runtime)
      const { approve, ask, read } = await bind(runtime, handoff)
      const scope = { teamPath, executionId: execution.id }
      const executions = new ExecutionStore(db.db)
      let winnerCommands = 1
      if (mode === 'adapt' || mode === 'continue') {
        const opened = await pause(runtime)
        expect(new PauseStore(db.db).target(opened.id, 'api')).toMatchObject({ decision: null })
        await refuseStale(runtime, approve, 'undecided')
        await resolve(runtime, opened.id, mode)
        expect(new PauseStore(db.db).target(opened.id, 'api')).toMatchObject({ decision: mode })
        winnerCommands = 4
      } else if (mode === 'stop') {
        expect((await routed('team-plan-result', { ...scope, type: 'team-plan-execution-stop', reason: 'Owner stopped this run',
          requestId: 'history-stop', commandId: 'history-stop' })).error).toBeUndefined()
        expect(executions.execution(execution.id)?.outcome).toBe('stopped')
      } else {
        const before = executions.change(execution.id, 'api')!
        executions.transition(execution.id, 'api', before, { state: 'stopped', stopReason: 'instruction-failed' })
        expect((await routed('team-plan-result', { ...scope, type: 'team-plan-execution-retry', change: 'api',
          requestId: 'history-retry', commandId: 'history-retry' })).error).toBeUndefined()
        expect(executions.change(execution.id, 'api')!.generation).toBeGreaterThan(before.generation)
      }
      const revision = mode === 'adapt' ? 2 : 1
      expect(runtime.manager.tasks.store.get(task.id)).toMatchObject({ revision, ...(mode === 'stop' ? { status: 'cancelled' } : {}) })
      expect(runtime.manager.tasks.handoffs.store.get(handoff.id)?.state).toBe(
        mode === 'adapt' ? 'stale' : mode === 'stop' ? 'closed' : 'open',
      )
      await runtime.settleDelivery()
      const winner = runtime.snapshot()
      // The opening contains prepare, ask and review plus its routed winner.
      // Use the same seed at both profiles and vary the remaining typed commands.
      const count = 12 + Math.floor(random() * 9) - 3 - winnerCommands
      for (let step = 0; step < count; step++) {
        const command = step === 0 ? 0 : Math.floor(random() * 3)
        if (command === 0) expect(await routed('team-plan-result', { ...approve, requestId: `loser-${step}` })).toMatchObject({ reason: 'stale' })
        if (command === 1) expect(await runtime.leadTool('decision_ask', ask)).toMatchObject({ card_id: approve.cardId, replayed: true })
        if (command === 2) expect(await read()).toMatchObject({ state: 'open', publication: { receipt: null } })
        expect(runtime.snapshot()).toEqual(winner)
        expect(runtime.manager.tasks.store.revisions(task.id)).toHaveLength(revision)
      }
    } finally { await runtime.teardown() }
  }
  expect(propertyCases(200)).toBeGreaterThanOrEqual(histories.length)
})

// @covers: task-revision-publication › A decision-bound publication preserves execution gates › A pause or Adapt wins independently
test('W04 an affected draining pause arriving after preflight and later Continue both stale the review', async () => {
  const runtime = await publicationRuntime()
  let resume = () => {}
  try {
    const { approve, read } = await bind(runtime, await prepare(runtime))
    const pending = await beginAfterCheck(runtime, approve)
    resume = pending.resume
    const opened = await pause(runtime)
    const target = new PauseStore(runtime.db.db).target(opened.id, 'api')
    expect(target).toMatchObject({ decision: null, pausedAt: null, holderSession: runtime.holder })
    await runtime.settleDelivery()
    const before = runtime.snapshot()
    resume()
    expect(await pending.result).toMatchObject({ reason: 'stale', error: expect.stringContaining('undecided') })
    expect(runtime.snapshot()).toEqual(before)
    await refuseStale(runtime, { ...approve, requestId: 'with-draining-pause' }, 'undecided')
    await resolve(runtime, opened.id, 'continue')
    expect(runtime.manager.tasks.store.get(runtime.task.id)?.revision).toBe(1)
    await refuseStale(runtime, { ...approve, requestId: 'with-continue-history' }, 'execution')
    expect((await read()).publication?.receipt).toBeNull()
  } finally { resume(); await runtime.teardown() }
})

// @covers: task-revision-publication › A decision-bound publication preserves execution gates › A pause or Adapt wins independently
test('W04 shipped Adapt publishes once, leaves an owed fix behind the hold and leaves the card open', async () => {
  const runtime = await publicationRuntime()
  try {
    const { manager, task, db, execution } = runtime
    const { approve, read } = await bind(runtime, await prepare(runtime))
    const opened = await pause(runtime)
    new PauseStore(db.db).recordPaused(opened.id, 'api', null)
    await refuseStale(runtime, approve, 'undecided')
    await resolve(runtime, opened.id, 'adapt')
    expect(manager.tasks.store.revisions(task.id).at(-1)).toMatchObject({ revision: 2, direction: 'Adapted direction' })
    const attempts = new ExecutionStore(db.db).attempts(execution.id, 'api')
    expect(attempts.at(-1)).toMatchObject({ kind: 'fix', assignmentId: null })
    await refuseStale(runtime, { ...approve, requestId: 'after-adapt' }, 'base moved')
    expect(await read()).toMatchObject({ state: 'open', publication: { receipt: null } })
  } finally { await runtime.teardown() }
})

// @covers: task-revision-publication › A decision-bound publication preserves execution gates › Unrelated pauses and holds preserve normal behavior
test('W04 unrelated pauses and a standing hold preserve publication and execution waits', async () => {
  const runtime = await publicationRuntime()
  try {
    const { task, db, team, execution, plan, routed } = runtime
    const { approve } = await bind(runtime, await prepare(runtime))
    const hold = await placeHold(runtime, ['api'])
    const pauses = new PauseStore(db.db)
    // Seed unrelated historical targets. They cannot resolve this approval's owning change.
    for (const [executionId, change] of [[execution.id, 'ui'], ['unrelated-execution', 'api']] as const) {
      pauses.insert({ teamId: team.teamId, planId: plan.planId, executionId, holdId: hold.id, deadline: hold.deadline,
        note: null, commandId: `${executionId}:${change}` },
      [{ change, stage: 'attempt', attemptId: null, assignmentId: 'unrelated-assignment', holderSession: null }])
    }
    const before = runtime.snapshot()
    expect(await routed('team-plan-result', approve)).toMatchObject({ publication: { taskId: task.id, publishedRevision: 2 } })
    await runtime.settleDelivery()
    const after = runtime.snapshot()
    for (const key of Object.keys(before).filter(key => /^(plan_(pause|hold|execution)|team_task_assignments)/.test(key))) {
      expect([key, after[key]]).toEqual([key, before[key]])
    }
  } finally { await runtime.teardown() }
})

const DISPOSITIONS = ['closed', 'stale', 'superseded', 'declined', 'withdrawn', 'published'] as const
// @covers: plan-decisions › Fresh approval publishes only the reviewed handoff › A moved base or scope refuses approval
test.each(DISPOSITIONS)('W02 ending the exact handoff as %s cannot substitute another handoff', async (state) => {
  const runtime = await publicationRuntime()
  try {
    const { task, teamPath, routed, manager } = runtime
    const handoff = await prepare(runtime)
    const { approve, read } = await bind(runtime, handoff)
    if (state === 'closed') expect((await routed('team-task-result', { type: 'team-task-status', teamPath,
      taskId: task.id, requestId: 'close', status: 'cancelled' })).error).toBeUndefined()
    if (state === 'stale') expect((await routed('team-task-result', ordinary(runtime))).error).toBeUndefined()
    if (state === 'superseded') await prepare(runtime, task.id, 1, 'successor')
    if (state === 'declined') expect((await routed('team-task-result', { type: 'team-task-handoff-decline', teamPath,
      taskId: task.id, handoffId: handoff.id, requestId: 'decline', requestKey: 'decline', reason: 'Decline the prepared edit' })).error).toBeUndefined()
    if (state === 'withdrawn') await runtime.leadTool('task_settle_publication', { handoff_id: handoff.id, action: 'withdraw', reason: 'Withdraw the prepared edit' })
    if (state === 'published') expect((await routed('team-task-result', prepared(runtime, handoff))).error).toBeUndefined()
    expect(manager.tasks.handoffs.store.get(handoff.id)?.state).toBe(state)
    await refuseStale(runtime, approve, state === 'stale' || state === 'published' ? 'base moved' : state)
    expect(await read()).toMatchObject({ state: 'open', publication: { handoffId: handoff.id, receipt: null } })
  } finally { await runtime.teardown() }
})
