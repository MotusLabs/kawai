// Attempt sends that meet an Apply (plan-revision-apply P4/A7, CH4/A3;
// review round 2, F1 and F3). The reviewer's two real-path probes, kept as
// regressions, and the same race on every other attempt send:
// - an owed implement send paused at the assignment service while an owner
//   Apply moves the execution on writes nothing; the next owed pass mints
//   the successor at the new revision and sends it once (F1);
// - a fix or update handoff whose manifest was minted at the old revision
//   while its git reads ran is never sent; the next owed pass sends the
//   successor with the same answers (the same defect class);
// - Adapt between the first task attachment and the first attempt mints one
//   owed fix: the in-flight implement dispatch yields, and the change gets a
//   fix naming the new plan and task revisions (F3);
// - a fix or update attempt whose git reads straddle a Restart or Adapt
//   never appends a stale row after the Apply's: the executor sends the
//   Apply's row at the new revision (round 3, F6).
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import type { PlanContent } from '../../shared/plans'
import * as git from '../git/gitCommand'
import { dispatchFixAttempt, dispatchImplementAttempt, dispatchOwedAttempt, dispatchUpdateAttempt, type DispatchDeps } from '../plans/execution/executionDispatch'
import { TaskResultService } from '../team/TaskResultService'
import { TaskService } from '../team/TaskService'
import { applyBench, type ApplyBench } from './applyBench'

let wired: ApplyBench
beforeAll(async () => { wired = await applyBench('apply-send-race') })
afterAll(() => wired.close())

const reword = (guidance: string) => (content: PlanContent): PlanContent => ({
  ...content, changes: content.changes.map(entry => (entry.change === 'ui' ? { ...entry, guidance } : entry)),
})

/** Real task, assignment, and result services over the bench stores, as the server composes them for Kawai. */
const deps = (): DispatchDeps => ({
  team: wired.world.team, executions: wired.executions, plans: wired.bench.plans,
  tasks: new TaskService(wired.bench.tasks, { getSession: id => wired.bench.records.get(id), plans: wired.bench.plans }),
  assignments: wired.assignments,
  results: new TaskResultService(wired.tasks, { getSession: id => wired.bench.records.get(id), assignments: wired.assignments }),
  showFile: async () => ({ ok: false as const, missing: true }),
})

/** A latch on the first `rev-parse HEAD`: resolves `entered` there and waits for `release`. */
function pauseAtHead(): { entered: Promise<void>; release: () => void; restore: () => void } {
  const entered = Promise.withResolvers<void>()
  const released = Promise.withResolvers<void>()
  const original = git.runGitAsync
  let paused = false
  const spy = spyOn(git, 'runGitAsync').mockImplementation(async (args, options) => {
    if (!paused && args[0] === 'rev-parse' && args[1] === 'HEAD') {
      paused = true
      entered.resolve()
      await released.promise
    }
    return original(args, options)
  })
  return { entered: entered.promise, release: () => released.resolve(), restore: () => spy.mockRestore() }
}

/** Every attempt stamp, with the execution's revision at the instant it is written (the dispatch's commit). */
function recordStamps(): { rows: Array<{ assignmentId: string; manifest: number; execution: number }>; restore: () => void } {
  const rows: Array<{ assignmentId: string; manifest: number; execution: number }> = []
  const original = wired.executions.setAttemptAssignment.bind(wired.executions)
  const spy = spyOn(wired.executions, 'setAttemptAssignment').mockImplementation((id: string, assignmentId: string) => {
    const attempt = wired.bench.db.db.prepare('SELECT execution_id AS executionId, change FROM plan_execution_attempts WHERE id = ?').get(id) as { executionId: string; change: string }
    const row = wired.executions.attempts(attempt.executionId, attempt.change).find(entry => entry.id === id)!
    if (row.assignmentId === null) rows.push({ assignmentId, manifest: row.manifest.plan.revision, execution: wired.executions.execution(attempt.executionId)!.revision })
    original(id, assignmentId)
  })
  return { rows, restore: () => spy.mockRestore() }
}

/** ui's task in flight, implementing from a baseline. */
async function inFlight(executionId: string): Promise<string> {
  const flight = await wired.inFlightByKawai(executionId, 'ui', 'dev')
  const row = wired.executions.change(executionId, 'ui')!
  expect(wired.executions.transition(executionId, 'ui', row, { state: 'implementing', baselineCommit: 'base-sha' })).not.toBeNull()
  return flight.taskId
}

/** A fix or update attempt minted while its git reads run, an Apply committing meanwhile, then the next owed pass. */
async function staleHandoff(kind: 'fix' | 'update'): Promise<void> {
  const { planId, executionId } = await wired.running()
  const taskId = await inFlight(executionId)
  const roundId = wired.answerNewestRow(executionId, 'ui', 1)
  const round = wired.executions.round(roundId)!
  if (kind === 'fix') {
    wired.bench.db.db.prepare("UPDATE plan_execution_rounds SET outcome = 'fail' WHERE id = ?").run(roundId)
    const gating = wired.executions.change(executionId, 'ui')!
    expect(wired.executions.transition(executionId, 'ui', gating, { state: 'implementing', step: null })).not.toBeNull()
  }
  const next = await wired.approveNext(planId, reword(`Revise the UI (${kind})`))
  const from = wired.executions.execution(executionId)!.revision
  const before = wired.tasks.store.assignmentsOf(taskId).length
  const stamps = recordStamps()
  const latch = pauseAtHead()
  const send = kind === 'fix'
    ? dispatchFixAttempt(deps(), {
      executionId, change: 'ui', group: 'middle-devs', failingChecks: [{ name: 'lint', conclusion: 'failure', link: null }], findingsIds: [],
      findings: { blocking: [], blockingText: '', others: 0, legacyTexts: [] }, continueFrom: 'round-commit', fixRounds: 1,
    })
    : dispatchUpdateAttempt(deps(), { executionId, change: 'ui', round, update: { base: 'base-head', files: ['a.ts'] } })
  try {
    await latch.entered
    expect(await wired.applyAs({ executionId, choices: { ui: 'continue' } })).toMatchObject({ ok: true })
  } finally {
    latch.release()
    try { await send } finally { latch.restore() }
  }
  const stale = wired.executions.attempts(executionId, 'ui').at(-1)!
  expect({ kind: stale.kind, revision: stale.manifest.plan.revision, assignmentId: stale.assignmentId })
    .toEqual({ kind, revision: from, assignmentId: null })
  expect(wired.tasks.store.assignmentsOf(taskId).length).toBe(before)
  expect(wired.planFor().dispatches).toContainEqual(expect.objectContaining({ executionId, change: 'ui', kind: 'owed' }))
  await dispatchOwedAttempt(deps(), { executionId, change: 'ui', group: 'middle-devs' })
  const sent = wired.executions.attempts(executionId, 'ui').at(-1)!
  expect({ kind: sent.kind, revision: sent.manifest.plan.revision, answers: sent.manifest.answers, staleSent: wired.executions.attempts(executionId, 'ui').find(row => row.id === stale.id)!.assignmentId })
    .toEqual({ kind, revision: next.revision, answers: stale.manifest.answers, staleSent: null })
  const added = wired.tasks.store.assignmentsOf(taskId).slice(before)
  expect(added.map(entry => ({ id: entry.id, handoffKind: entry.handoffKind, resultId: entry.resultId })))
    .toEqual([{ id: sent.assignmentId!, handoffKind: 'fix', resultId: round.resultId }])
  stamps.restore()
  expect(stamps.rows).toEqual([{ assignmentId: sent.assignmentId!, manifest: next.revision, execution: next.revision }])
}

describe('an owed send meets an Apply (F1)', () => {
  // @covers: plan-revision-apply › The execution keeps its revision history › Manifests keep their revision
  test('P4 probe: Continue during an owed implement send; every stamp commits while the execution is on its manifest revision, and one assignment goes out', async () => {
    const { planId, executionId } = await wired.running()
    const taskId = await inFlight(executionId)
    const restart = await wired.approveNext(planId, reword('Restart the UI'))
    expect(await wired.applyAs({ executionId, choices: { ui: 'restart' } })).toMatchObject({ ok: true })
    const owed = wired.executions.attempts(executionId, 'ui').at(-1)!
    expect(owed).toMatchObject({ kind: 'implement', assignmentId: null, manifest: { plan: { revision: restart.revision } } })
    const next = await wired.approveNext(planId, reword('Keep going on the UI'))
    const before = wired.tasks.store.assignmentsOf(taskId).length
    const stamps = recordStamps()
    const entered = Promise.withResolvers<void>()
    const released = Promise.withResolvers<void>()
    // The reviewer's probe: the real dispatch's awaits before its commit, widened.
    const seam = wired.assignments as unknown as { sessionTarget: (...args: unknown[]) => Promise<unknown> }
    const target = seam.sessionTarget.bind(wired.assignments)
    const spy = spyOn(seam, 'sessionTarget').mockImplementation(async (...args) => {
      entered.resolve()
      await released.promise
      return target(...args)
    })
    const pending = dispatchOwedAttempt(deps(), { executionId, change: 'ui', group: 'middle-devs' })
    try {
      await Promise.race([entered.promise, pending])
      expect(await wired.applyAs({ executionId, choices: { ui: 'continue' } })).toMatchObject({ ok: true })
      expect(wired.executions.execution(executionId)!.revision).toBe(next.revision)
    } finally {
      released.resolve()
      try { await pending } finally { spy.mockRestore() }
    }
    // A later pass sends nothing more, or the successor at the new revision.
    for (const step of wired.planFor().dispatches.filter(entry => entry.change === 'ui')) await dispatchOwedAttempt(deps(), step)
    stamps.restore()
    expect(stamps.rows.length).toBe(1)
    for (const row of stamps.rows) expect(row.manifest).toEqual(row.execution)
    expect(wired.tasks.store.assignmentsOf(taskId).slice(before).map(entry => entry.id)).toEqual(stamps.rows.map(row => row.assignmentId))
  })

  // @covers: plan-revision-apply › The execution keeps its revision history › Manifests keep their revision
  test('a fix attempt minted while its git reads run, then an Apply: the stale row is never handed off; the next owed pass sends its successor once with the same answers', () => staleHandoff('fix'))

  // @covers: plan-revision-apply › The execution keeps its revision history › Manifests keep their revision
  test('an update attempt minted while its git reads run, then an Apply: the stale row is never handed off; the next owed pass sends its successor once with the same answers', () => staleHandoff('update'))
})

describe('Adapt before the first attempt (F3)', () => {
  // @covers: plan-revision-apply › Each choice publishes or dispatches as recorded › Adapt notifies the developer
  test('CH4 probe: Adapt after the task is attached and before the first attempt exists mints one owed fix; the in-flight implement yields and the fix is sent with both new pins', async () => {
    const { planId, executionId } = await wired.running()
    fs.mkdirSync(path.join(wired.world.repo, 'openspec', 'changes', 'ui'), { recursive: true })
    const current = wired.executions.change(executionId, 'ui')!
    expect(wired.executions.transition(executionId, 'ui', current, {
      state: 'implementing', worktree: wired.world.repo, branch: 'ui', baselineCommit: 'base-sha',
    })).not.toBeNull()
    const next = await wired.approveNext(planId, reword('Adapt the UI'))
    const latch = pauseAtHead()
    const pending = dispatchImplementAttempt(deps(), { executionId, change: 'ui', group: 'middle-devs' })
    let taskId = null as string | null
    try {
      await latch.entered
      taskId = wired.executions.change(executionId, 'ui')!.taskId
      expect(taskId).not.toBeNull()
      expect(wired.executions.attempts(executionId, 'ui')).toEqual([])
      expect(await wired.applyAs({ executionId, choices: { ui: 'adapt' } })).toMatchObject({ ok: true })
      expect(wired.tasks.store.get(taskId!)!.revision).toBe(2)
      // The Apply transaction itself persisted the owed fix.
      expect(wired.executions.attempts(executionId, 'ui').map(row => ({ kind: row.kind, assignmentId: row.assignmentId, plan: row.manifest.plan.revision, task: row.manifest.task })))
        .toEqual([{ kind: 'fix', assignmentId: null, plan: next.revision, task: { id: taskId!, revision: 2 } }])
    } finally {
      latch.release()
      try { await pending } finally { latch.restore() }
    }
    // The in-flight implement dispatch yielded: no implement row, no assignment.
    expect(wired.executions.attempts(executionId, 'ui').map(row => row.kind)).toEqual(['fix'])
    expect(wired.tasks.store.assignmentsOf(taskId!)).toEqual([])
    const steps = wired.planFor().dispatches.filter(step => step.change === 'ui')
    expect(steps.map(step => step.kind)).toEqual(['owed'])
    for (const step of steps) await dispatchOwedAttempt(deps(), step)
    const rows = wired.executions.attempts(executionId, 'ui')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.assignmentId).not.toBeNull()
    expect(rows[0]!.manifest).toMatchObject({ plan: { revision: next.revision }, task: { id: taskId, revision: 2 } })
    expect(rows[0]!.kind).toBe('fix')
    expect(wired.tasks.store.assignmentsOf(taskId!).map(entry => entry.id)).toEqual([rows[0]!.assignmentId!])
  })
})

/** A fix or update mint paused at its git reads while an Apply under `choice` commits; `minted` is the row the Apply's own transaction appends (null: Adapt on a passed round appends none). */
async function mintMeetsApply(kind: 'fix' | 'update', choice: 'restart' | 'adapt', minted: 'implement' | 'fix' | null): Promise<void> {
  const { planId, executionId } = await wired.running()
  const taskId = await inFlight(executionId)
  const roundId = wired.answerNewestRow(executionId, 'ui', 1)
  const round = wired.executions.round(roundId)!
  if (kind === 'fix') {
    wired.bench.db.db.prepare("UPDATE plan_execution_rounds SET outcome = 'fail' WHERE id = ?").run(roundId)
    const gating = wired.executions.change(executionId, 'ui')!
    expect(wired.executions.transition(executionId, 'ui', gating, { state: 'implementing', step: null })).not.toBeNull()
  } else {
    wired.bench.db.db.prepare("UPDATE plan_execution_rounds SET outcome = 'pass' WHERE id = ?").run(roundId)
  }
  const next = await wired.approveNext(planId, reword(`${choice} the UI (${kind})`))
  const before = wired.tasks.store.assignmentsOf(taskId).length
  const latch = pauseAtHead()
  const send = kind === 'fix'
    ? dispatchFixAttempt(deps(), {
      executionId, change: 'ui', group: 'middle-devs', failingChecks: [{ name: 'lint', conclusion: 'failure', link: null }], findingsIds: [],
      findings: { blocking: [], blockingText: '', others: 0, legacyTexts: [] }, continueFrom: 'round-commit', fixRounds: 1,
    })
    : dispatchUpdateAttempt(deps(), { executionId, change: 'ui', round, update: { base: 'base-head', files: ['a.ts'] } })
  let applied: string | null = null
  try {
    await latch.entered
    expect(await wired.applyAs({ executionId, choices: { ui: choice } })).toMatchObject({ ok: true })
    const row = wired.executions.attempts(executionId, 'ui').at(-1)!
    if (minted !== null) {
      expect({ kind: row.kind, revision: row.manifest.plan.revision, assignmentId: row.assignmentId }).toEqual({ kind: minted, revision: next.revision, assignmentId: null })
      applied = row.id
    }
  } finally {
    latch.release()
    try { await send } finally { latch.restore() }
  }
  // The late mint yielded to the Apply's row, which is still the newest.
  if (applied !== null) expect(wired.executions.attempts(executionId, 'ui').at(-1)!.id).toBe(applied)
  expect(wired.tasks.store.assignmentsOf(taskId).length).toBe(before)
  const executor = wired.executor()
  await executor.tick(wired.teamId)
  await executor.tick(wired.teamId)
  const rows = wired.executions.attempts(executionId, 'ui')
  const sent = rows.at(-1)!
  expect({ id: applied ?? sent.id, revision: sent.manifest.plan.revision, staleSent: rows.filter(row => row.manifest.plan.revision !== next.revision && row.kind === kind && row.assignmentId !== null).length })
    .toEqual({ id: sent.id, revision: next.revision, staleSent: 0 })
  expect(sent.assignmentId).not.toBeNull()
  // Every assignment that went out is the stamp of a row at the new revision; with the Apply's own row, exactly that one.
  const added = wired.tasks.store.assignmentsOf(taskId).slice(before).map(entry => entry.id)
  expect(added.map(id => rows.find(row => row.assignmentId === id)?.manifest.plan.revision)).toEqual(added.map(() => next.revision))
  if (minted !== null) expect(added).toEqual([sent.assignmentId!])
}

describe('an attempt mint meets an Apply that minted its own row (F6)', () => {
  // @covers: plan-revision-apply › The execution keeps its revision history › Manifests keep their revision
  test('F6 probe: an update mint paused at its git reads, then Restart: no stale update follows the Apply implement row, and two executor ticks send that row once at the new revision', () => mintMeetsApply('update', 'restart', 'implement'))

  // @covers: plan-revision-apply › The execution keeps its revision history › Manifests keep their revision
  test('F6 a fix mint paused at its git reads, then Restart: no stale fix follows the Apply implement row, and two executor ticks send that row once at the new revision', () => mintMeetsApply('fix', 'restart', 'implement'))

  // @covers: plan-revision-apply › The execution keeps its revision history › Manifests keep their revision
  // @covers: plan-revision-apply › Each choice publishes or dispatches as recorded › Adapt notifies the developer
  test('F6 a fix mint paused at its git reads, then Adapt: no stale fix follows the Apply fix row, and two executor ticks send that row once at the new revision', () => mintMeetsApply('fix', 'adapt', 'fix'))

  // @covers: plan-revision-apply › The execution keeps its revision history › Manifests keep their revision
  test('F6 an update mint paused at its git reads, then Adapt on the passed round: the Apply appends no row, the late row is never sent, and every send names the new revision', () => mintMeetsApply('update', 'adapt', null))
})
