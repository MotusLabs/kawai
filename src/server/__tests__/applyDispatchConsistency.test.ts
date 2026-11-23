// Dispatches that meet an Apply (plan-revision-apply design D4, CH4, P4;
// review F1, F3) over the Apply bench:
// - the implement dispatch re-checks the execution's revision after its
//   awaits: an Apply that commits while it reads the contract or the branch
//   sends nothing stale, and the next pass sends the new revision; the
//   attempt, its assignment, and the stamp commit together under that check;
// - Adapt leaves one owed fix in every state: over an owed implement row (a
//   restart held at the gate) it mints a fix naming the new revisions, which
//   the release dispatches, and over an owed fix it keeps that fix's answers.
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import type { PlanContent } from '../../shared/plans'
import { dispatchImplementAttempt, dispatchOwedAttempt, ensureFixAttempt, type DispatchDeps } from '../plans/execution/executionDispatch'
import type { ShowFile } from '../plans/execution/contractSnapshot'
import { advanceExecutionRevision } from '../plans/execution/executionApplyStore'
import { TaskService } from '../team/TaskService'
import { applyBench, type ApplyBench } from './applyBench'

/** The contract read's path inside the bench's temporary repository (no file of this repository). */
const DESIGN = ['openspec', 'changes', 'ui', 'design.md'].join('/')

let wired: ApplyBench

beforeAll(async () => {
  wired = await applyBench('apply-dispatch-consistency')
})
afterAll(() => wired.close())

const reword = (change: string, guidance: string) => (content: PlanContent): PlanContent => ({
  ...content, changes: content.changes.map(entry => (entry.change === change ? { ...entry, guidance } : entry)),
})

function ok<T extends { ok: boolean }>(outcome: T): Extract<T, { ok: true }> {
  if (!outcome.ok) throw new Error(`Apply refused: ${JSON.stringify(outcome)}`)
  return outcome as Extract<T, { ok: true }>
}

/** The bench's task store behind a TaskService that resolves plan links, as a server composes it for Kawai's task creation. */
const linking = (): TaskService => new TaskService(wired.bench.tasks, { getSession: id => wired.bench.records.get(id) ?? null, plans: wired.bench.plans })

const deps = (showFile?: ShowFile): DispatchDeps => ({
  team: wired.world.team, executions: wired.executions, plans: wired.bench.plans, tasks: linking(),
  assignments: wired.assignments, results: {} as never, ...(showFile ? { showFile } : {}),
})

/** ui provisioned and implementing, with no task and no attempt: the implement dispatch's input. */
function provisioned(executionId: string): void {
  // The task links the change's OpenSpec directory, which the worktree holds.
  fs.mkdirSync(path.join(wired.world.repo, 'openspec', 'changes', 'ui'), { recursive: true })
  const row = wired.executions.change(executionId, 'ui')!
  expect(wired.executions.transition(executionId, 'ui', row, { state: 'implementing', worktree: wired.world.repo, branch: 'ui', baselineCommit: 'base-sha' })).not.toBeNull()
}

/** A contract read that checks its arguments, answers "no design", and waits for `gate` on its first call. */
function pausedShow(gate: Promise<void>, reached: () => void): { show: ShowFile; calls: Array<[string, string, string]> } {
  const calls: Array<[string, string, string]> = []
  const show: ShowFile = async (cwd, rev, file) => {
    calls.push([cwd, rev, file])
    expect({ cwd, rev, file }).toEqual({ cwd: wired.world.repo, rev: 'base-sha', file: DESIGN })
    if (calls.length === 1) {
      reached()
      await gate
    }
    return { ok: false, missing: true }
  }
  return { show, calls }
}

/** The implement assignments of ui's task: the manifest revision each names and its instruction. */
function sent(executionId: string): Array<{ revision: number; instruction: string }> {
  const taskId = wired.executions.change(executionId, 'ui')!.taskId
  if (taskId === null) return []
  return wired.executions.attempts(executionId, 'ui').filter(row => row.assignmentId !== null).map(row => ({
    revision: row.manifest.plan.revision,
    instruction: wired.tasks.store.assignmentsOf(taskId).find(entry => entry.id === row.assignmentId)!.instruction,
  }))
}

describe('the implement dispatch meets an Apply (F1)', () => {
  // @covers: plan-revision-apply › The execution keeps its revision history › Manifests keep their revision
  test('an Apply committing while the dispatch reads the contract: nothing stale is created or sent; the next pass sends the new revision', async () => {
    const { planId, executionId } = await wired.running()
    provisioned(executionId)
    const second = await wired.approveNext(planId, reword('ui', 'Smaller ui'))
    let release!: () => void
    let reached!: () => void
    const atRead = new Promise<void>(resolve => { reached = resolve })
    const { show, calls } = pausedShow(new Promise<void>(resolve => { release = resolve }), reached)
    const first = dispatchImplementAttempt(deps(show), { executionId, change: 'ui', group: 'middle-devs' })
    await atRead
    // ui has no task: no choice is needed, and the Apply commits while the dispatch waits.
    ok(await wired.applyAs({ executionId, commandId: 'f1-apply' }))
    expect(wired.executions.execution(executionId)!.revision).toBe(second.revision)
    release()
    await first
    expect({ taskId: wired.executions.change(executionId, 'ui')!.taskId, attempts: wired.executions.attempts(executionId, 'ui') }).toEqual({ taskId: null, attempts: [] })
    // The next pass reads the stored rows afresh.
    await dispatchImplementAttempt(deps(show), { executionId, change: 'ui', group: 'middle-devs' })
    expect(calls).toHaveLength(2)
    const out = sent(executionId)
    expect(out.map(entry => entry.revision)).toEqual([second.revision])
    expect(out[0]!.instruction).toContain('Smaller ui')
    expect(wired.tasks.store.get(wired.executions.change(executionId, 'ui')!.taskId!)!.direction).toContain('Smaller ui')
  })

  test('control: with no Apply during the read, the paused dispatch sends the revision it read', async () => {
    const { executionId } = await wired.running()
    provisioned(executionId)
    let reached!: () => void
    const atRead = new Promise<void>(resolve => { reached = resolve })
    let release!: () => void
    const { show } = pausedShow(new Promise<void>(resolve => { release = resolve }), reached)
    const first = dispatchImplementAttempt(deps(show), { executionId, change: 'ui', group: 'middle-devs' })
    await atRead
    release()
    await first
    expect(sent(executionId).map(entry => entry.revision)).toEqual([wired.executions.execution(executionId)!.revision])
  })

  test('the execution moving between the manifest and its commit: the transaction mints and sends nothing; the next pass names the new revision', async () => {
    const { planId, executionId } = await wired.running()
    provisioned(executionId)
    const task = wired.bench.tasks.create({ teamId: wired.teamId, title: 'ui work', direction: 'Build it', creator: { kind: 'system', sessionId: null } })
    const row = wired.executions.change(executionId, 'ui')!
    expect(wired.executions.transition(executionId, 'ui', row, { taskId: task.id })).not.toBeNull()
    const second = await wired.approveNext(planId, reword('ui', 'Smaller ui'))
    const from = wired.executions.execution(executionId)!
    // The manifest reads the task's revision after the git reads; at that instant the execution moves on, as a committed Apply moves it.
    const original = wired.tasks.store.get.bind(wired.tasks.store)
    let moved = false
    const spy = spyOn(wired.tasks.store, 'get').mockImplementation((id: string) => {
      if (!moved && id === task.id) {
        moved = true
        expect(advanceExecutionRevision(wired.bench.db.db, executionId, from.revision, { revision: second.revision, contentHash: second.hash, reportId: 'rep-next', inputHash: 'ih-next' })).toBe(true)
      }
      return original(id)
    })
    try {
      await dispatchImplementAttempt(deps(), { executionId, change: 'ui', group: 'middle-devs' })
    } finally {
      spy.mockRestore()
    }
    expect(moved).toBe(true)
    expect(wired.executions.attempts(executionId, 'ui')).toEqual([])
    expect(wired.tasks.store.assignmentsOf(task.id)).toEqual([])
    await dispatchImplementAttempt(deps(), { executionId, change: 'ui', group: 'middle-devs' })
    expect(sent(executionId).map(entry => entry.revision)).toEqual([second.revision])
  })
})

describe('Adapt leaves a fix owed in every state (F3)', () => {
  // @covers: plan-revision-apply › Each choice publishes or dispatches as recorded › Adapt notifies the developer
  test('CH4 over an owed implement row held at the gate: Adapt mints one owed fix naming the new revisions, and the release sends that fix', async () => {
    const { planId, executionId } = await wired.running()
    const ui = await wired.inFlightByKawai(executionId, 'ui', 'dev')
    const moved = wired.executions.change(executionId, 'ui')!
    expect(wired.executions.transition(executionId, 'ui', moved, { state: 'implementing', baselineCommit: 'base-sha' })).not.toBeNull()
    const hold = wired.placeHold(planId, ['ui'], 'hold-f3')
    await wired.approveNext(planId, reword('ui', 'Start over'))
    ok(await wired.applyAs({ executionId, choices: { ui: 'restart' }, commandId: 'f3-restart' }))
    const owedImplement = wired.executions.attempts(executionId, 'ui').at(-1)!
    expect(owedImplement).toMatchObject({ kind: 'implement', assignmentId: null })
    const third = await wired.approveNext(planId, reword('ui', 'Start over, smaller'))
    ok(await wired.applyAs({ executionId, choices: { ui: 'adapt' }, commandId: 'f3-adapt' }))
    const rows = wired.executions.attempts(executionId, 'ui')
    const fix = rows.at(-1)!
    expect(rows.at(-2)).toEqual(owedImplement)
    expect({ kind: fix.kind, assignmentId: fix.assignmentId, plan: fix.manifest.plan.revision, task: fix.manifest.task })
      .toEqual({ kind: 'fix', assignmentId: null, plan: third.revision, task: { id: ui.taskId, revision: 2 } })
    // Held: nothing goes out until the release.
    expect(wired.planFor().dispatches.filter(entry => entry.change === 'ui')).toEqual([])
    wired.holds.release({ teamId: wired.teamId, holdId: hold.id, changes: ['ui'], reason: 'go on', commandId: 'release-f3' })
    expect(wired.planFor().dispatches).toContainEqual(expect.objectContaining({ executionId, change: 'ui', kind: 'owed' }))
    await dispatchOwedAttempt(deps(), { executionId, change: 'ui', group: 'middle-devs' })
    const after = wired.executions.attempts(executionId, 'ui')
    // The fix itself is sent: no successor, and the owed implement row is never sent.
    expect(after).toHaveLength(rows.length)
    expect(after.at(-1)).toMatchObject({ id: fix.id, kind: 'fix' })
    expect(after.at(-1)!.assignmentId).not.toBeNull()
    expect(after.at(-2)!.assignmentId).toBeNull()
    const generation = wired.executions.change(executionId, 'ui')!.generation
    expect(wired.tasks.store.assignmentsOf(ui.taskId).map(entry => entry.requestKey)).toContain(`exec:${executionId}:ui:attempt:${fix.number}:${generation}`)
  })

  test('CH4 over an owed fix of a failed round: the re-issued fix keeps the answers it owed, naming the new revisions', async () => {
    const { planId, executionId } = await wired.running()
    const ui = await wired.inFlightByKawai(executionId, 'ui', 'dev')
    const moved = wired.executions.change(executionId, 'ui')!
    expect(wired.executions.transition(executionId, 'ui', moved, { state: 'implementing', baselineCommit: 'base-sha' })).not.toBeNull()
    const roundId = wired.answerNewestRow(executionId, 'ui', 1)
    wired.bench.db.db.prepare("UPDATE plan_execution_rounds SET outcome = 'fail' WHERE id = ?").run(roundId)
    const gating = wired.executions.change(executionId, 'ui')!
    expect(wired.executions.transition(executionId, 'ui', gating, { state: 'implementing', step: null })).not.toBeNull()
    const owedFix = await ensureFixAttempt(deps(), {
      executionId, change: 'ui', group: 'middle-devs',
      failingChecks: [{ name: 'lint', conclusion: 'failure', link: null }], findingsIds: [],
      findings: { blocking: [], blockingText: '', others: 0, legacyTexts: [] }, continueFrom: 'round-commit', fixRounds: 1,
    })
    const owedRow = wired.executions.attempts(executionId, 'ui').find(row => row.id === owedFix!.id)!
    expect(owedRow.manifest.answers).toMatchObject({ roundId, failingChecks: [expect.objectContaining({ name: 'lint' })] })
    const second = await wired.approveNext(planId, reword('ui', 'Smaller ui'))
    ok(await wired.applyAs({ executionId, choices: { ui: 'adapt' }, commandId: 'f3-adapt-fix' }))
    const fix = wired.executions.attempts(executionId, 'ui').at(-1)!
    expect(fix.id).not.toBe(owedRow.id)
    expect({ kind: fix.kind, plan: fix.manifest.plan.revision, task: fix.manifest.task, answers: fix.manifest.answers })
      .toEqual({ kind: 'fix', plan: second.revision, task: { id: ui.taskId, revision: 2 }, answers: owedRow.manifest.answers })
  })
})
