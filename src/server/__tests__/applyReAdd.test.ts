// A name an Apply removed, added back by a later Apply of the same run
// (plan-revision-apply CH7–CH10, review F2) over the Apply bench. The
// cancelled row is restored as fresh waiting work: no task, owned again, its
// generation bumped, scheduled by its dependencies. The removal's
// publication row names the task it retired; that task's attempts and
// rounds stay in the database as history and are no longer the change's
// current ones, so the implement dispatch creates a new task and mints the
// next attempt number. The owner index still refuses a name another running
// execution owns, and a landing fact restores the row landed without
// ownership.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import type { PlanChange, PlanContent } from '../../shared/plans'
import type { FloorMap } from '../../shared/planExecution'
import { dispatchImplementAttempt } from '../plans/execution/executionDispatch'
import { TaskService } from '../team/TaskService'
import { applyBench, type ApplyBench } from './applyBench'

/** The contract read's path inside the bench's temporary repository (no file of this repository). */
const DESIGN = ['openspec', 'changes', 'ui', 'design.md'].join('/')

let wired: ApplyBench

beforeAll(async () => {
  wired = await applyBench('apply-re-add')
})
afterAll(() => wired.close())

const base = { dependsOn: [] as string[], group: 'middle-devs', acceptance: [] as string[], extraChecks: [], guidance: '', reviewGroup: null }
const drop = (change: string) => (content: PlanContent): PlanContent => ({ ...content, changes: content.changes.filter(entry => entry.change !== change) })
const append = (entry: PlanChange) => (content: PlanContent): PlanContent => ({ ...content, changes: [...content.changes, entry] })

function ok<T extends { ok: boolean }>(outcome: T): Extract<T, { ok: true }> {
  if (!outcome.ok) throw new Error(`Apply refused: ${JSON.stringify(outcome)}`)
  return outcome as Extract<T, { ok: true }>
}

type Applied = { applied: { changes: Array<{ change: string }> } }
const publication = (outcome: Applied, change: string) => outcome.applied.changes.find(row => row.change === change)

const raw = (table: string, executionId: string, change: string): number =>
  (wired.bench.db.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE execution_id = ? AND change = ?`).get(executionId, change) as { n: number }).n

/** Remove ui, then add it back, each through an approved revision and the owner's Apply. */
async function removeThenReAdd(planId: string, executionId: string) {
  await wired.approveNext(planId, drop('ui'))
  const removed = ok(await wired.applyAs({ executionId }))
  expect(wired.executions.change(executionId, 'ui')).toMatchObject({ state: 'cancelled', owns: false })
  const cancelled = wired.executions.change(executionId, 'ui')!
  await wired.approveNext(planId, append({ ...base, change: 'ui' }))
  return { removed, cancelled }
}

describe('a removed change added back in the same run (CH7, F2)', () => {
  // @covers: plan-revision-apply › Each choice publishes or dispatches as recorded › A removed change is cancelled
  test('CH7 re-add of an unprovisioned removed change: the cancelled row is restored waiting and owned, and the planner provisions it', async () => {
    const { planId, executionId } = await wired.running()
    await wired.inFlightByKawai(executionId, 'api', 'dev')
    const { removed, cancelled } = await removeThenReAdd(planId, executionId)
    expect(publication(removed, 'ui')).toMatchObject({ class: 'removed', taskId: null })
    const readded = ok(await wired.applyAs({ executionId }))
    expect(publication(readded, 'ui')).toMatchObject({ class: 'added', choice: null })
    const row = wired.executions.change(executionId, 'ui')!
    expect(row).toMatchObject({ state: 'waiting', owns: true, taskId: null, step: null, stopReason: null })
    expect(row.generation).toBeGreaterThan(cancelled.generation)
    expect(wired.executions.changes(executionId).map(entry => entry.change)).toEqual(['api', 'ui'])
    expect(wired.planFor().transitions).toContainEqual(expect.objectContaining({ executionId, change: 'ui', patch: { state: 'provisioning' } }))
  })

  test('CH7 re-add of a removed change with a task, an attempt, and a round: fresh work with no task; the retired task\'s rows stay as history and are no longer current; the next implement dispatch creates a new task', async () => {
    const { planId, executionId } = await wired.running()
    // ui in flight: Kawai's task, its dispatched attempt naming that task, and a round answering it.
    const flight = await wired.inFlight(executionId, 'ui', 'dev', 'claim', false)
    wired.bench.db.db.prepare("UPDATE team_tasks SET creator_kind = 'system', creator_session = NULL WHERE id = ?").run(flight.taskId)
    const execution = wired.executions.execution(executionId)!
    const old = wired.executions.insertAttempt({
      executionId, change: 'ui', kind: 'implement', assignmentId: flight.assignmentId, manifestHash: 'mh-old',
      manifest: {
        version: 1, plan: { id: planId, revision: execution.revision, contentHash: execution.contentHash }, execution: executionId,
        task: { id: flight.taskId, revision: 1 }, validation: { reportId: 'rep-1', inputHash: 'ih-1' }, baseline: 'base-sha', startCommit: 'base-sha', artifacts: {}, roleProfiles: [],
      },
    })
    wired.answerNewestRow(executionId, 'ui', 1)
    expect(wired.executions.rounds(executionId, 'ui')).toHaveLength(1)
    const { removed } = await removeThenReAdd(planId, executionId)
    // The removal names the task it retired; the cancelled row still shows its own history.
    expect(publication(removed, 'ui')).toMatchObject({ class: 'removed', taskId: flight.taskId })
    expect(wired.tasks.store.get(flight.taskId)!.status).toBe('cancelled')
    ok(await wired.applyAs({ executionId }))
    expect(wired.executions.change(executionId, 'ui')).toMatchObject({
      state: 'waiting', owns: true, taskId: null, worktree: null, branch: null, baselineCommit: null, prNumber: null, fixRounds: 0, passedAt: null,
    })
    expect({ attempts: wired.executions.attempts(executionId, 'ui'), rounds: wired.executions.rounds(executionId, 'ui'), pin: wired.executions.latestAttemptForChange(executionId, 'ui') })
      .toEqual({ attempts: [], rounds: [], pin: null })
    expect({ attempts: raw('plan_execution_attempts', executionId, 'ui'), rounds: raw('plan_execution_rounds', executionId, 'ui') }).toEqual({ attempts: 1, rounds: 1 })
    // Provisioned again, the change is the implement dispatch's: a new task and the next attempt number.
    fs.mkdirSync(path.join(wired.world.repo, 'openspec', 'changes', 'ui'), { recursive: true })
    const waiting = wired.executions.change(executionId, 'ui')!
    expect(wired.executions.transition(executionId, 'ui', waiting, { state: 'implementing', worktree: wired.world.repo, branch: 'ui', baselineCommit: 'base-sha' })).not.toBeNull()
    expect(wired.planFor().dispatches).toContainEqual(expect.objectContaining({ executionId, change: 'ui', kind: 'implement' }))
    const linking = new TaskService(wired.bench.tasks, { getSession: id => wired.bench.records.get(id) ?? null, plans: wired.bench.plans })
    await dispatchImplementAttempt({
      team: wired.world.team, executions: wired.executions, plans: wired.bench.plans, tasks: linking, assignments: wired.assignments, results: {} as never,
      showFile: async (cwd, rev, file) => {
        expect({ cwd, rev, file }).toEqual({ cwd: wired.world.repo, rev: 'base-sha', file: DESIGN })
        return { ok: false, missing: true }
      },
    }, { executionId, change: 'ui', group: 'middle-devs' })
    const taskId = wired.executions.change(executionId, 'ui')!.taskId
    expect(taskId).not.toBeNull()
    expect(taskId).not.toBe(flight.taskId)
    const current = wired.executions.attempts(executionId, 'ui')
    expect(current.map(row => ({ number: row.number, task: row.manifest.task.id, sent: row.assignmentId !== null })))
      .toEqual([{ number: old.number + 1, task: taskId!, sent: true }])
    expect(wired.tasks.store.get(flight.taskId)!.status).toBe('cancelled')
    expect(raw('plan_execution_attempts', executionId, 'ui')).toBe(2)
  })

  test('CH7 re-add while another running execution owns the name: refused as changes-unclaimed, nothing written', async () => {
    const { planId, executionId } = await wired.running()
    await removeThenReAdd(planId, executionId)
    wired.executions.insertExecution({
      teamId: wired.teamId, planId: 'plan-elsewhere', revision: 1, contentHash: 'h', reportId: 'r', inputHash: 'i',
      landingMode: 'direct', baseBranch: 'master', baseCommit: 'base', floor: { version: 1, map: {} as FloorMap },
      maxParallel: 1, mergeMethod: 'merge', changes: [{ change: 'ui', landed: false }],
    })
    const before = wired.counts()
    const outcome = await wired.applyAs({ executionId })
    expect(outcome.ok).toBe(false)
    expect(JSON.stringify(outcome)).toContain('changes-unclaimed')
    expect(wired.counts()).toEqual(before)
    expect(wired.executions.change(executionId, 'ui')).toMatchObject({ state: 'cancelled', owns: false })
  })

  test('CH8 re-add after the name landed elsewhere in the plan: the cancelled row is restored landed, without ownership', async () => {
    const { planId, executionId } = await wired.running()
    await removeThenReAdd(planId, executionId)
    wired.executions.insertLanding({
      planId, change: 'ui', executionId: 'exec-earlier', teamId: wired.teamId, mechanism: 'direct', prNumber: null, prUrl: null,
      headSha: 'h', baseSha: 'b', mergeSha: 'm', treeVerified: true,
    })
    ok(await wired.applyAs({ executionId }))
    expect(wired.executions.change(executionId, 'ui')).toMatchObject({ state: 'landed', owns: false, taskId: null })
    expect(wired.planFor().transitions.filter(step => step.change === 'ui')).toEqual([])
  })
})
