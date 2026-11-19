// What a running execution's revision means after an Apply
// (plan-revision-apply design D4, task 2.3) over the Apply bench:
// - completion counts the changes of the execution's current revision — an
//   Apply that removes the last unlanded change completes the run and the
//   plan as the system, and a change an Apply added keeps it running until
//   it lands too;
// - manifests keep their revision (I5): an owed attempt row minted before an
//   Apply moved the execution on is never sent; at dispatch the owed step
//   mints one successor naming the current revision and sends that (design
//   challenge DC1, the hold → owed at the old revision → Apply continue →
//   release sequence).
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import type { PlanChange, PlanContent } from '../../shared/plans'
import { completeIfLanded } from '../plans/execution/executionCompletion'
import { dispatchOwedAttempt } from '../plans/execution/executionDispatch'
import { applyBench, type ApplyBench } from './applyBench'

let wired: ApplyBench

beforeAll(async () => {
  wired = await applyBench('apply-readers')
})
afterAll(() => wired.close())

const base = { dependsOn: [] as string[], group: 'middle-devs', acceptance: [] as string[], extraChecks: [], guidance: '', reviewGroup: null }
const THREE = { changes: [{ ...base, change: 'api', acceptance: ['API lands'] }, { ...base, change: 'ui', dependsOn: ['api'] }, { ...base, change: 'docs' }] }

const reword = (change: string, guidance: string) => (content: PlanContent): PlanContent => ({
  ...content, changes: content.changes.map(entry => (entry.change === change ? { ...entry, guidance } : entry)),
})

function ok<T extends { ok: boolean }>(outcome: T): Extract<T, { ok: true }> {
  if (!outcome.ok) throw new Error(`Apply refused: ${JSON.stringify(outcome)}`)
  return outcome as Extract<T, { ok: true }>
}

function land(executionId: string, planId: string, change: string): void {
  wired.executions.insertLanding({
    planId, change, executionId, teamId: wired.teamId, mechanism: 'direct', prNumber: null, prUrl: null,
    headSha: 'h', baseSha: 'b', mergeSha: 'm', treeVerified: true,
  })
  const row = wired.executions.change(executionId, change)!
  if (wired.executions.transition(executionId, change, row, { state: 'landed', step: null }) === null) throw new Error('land failed')
}

const completion = () => ({ executions: wired.executions, plans: wired.bench.plans, plansService: wired.bench.service })

describe('completion reads the current revision (D4)', () => {
  // @covers: plan-revision-apply › The execution keeps its revision history › Completion after Apply
  test('an Apply removing the last unlanded change completes the execution and asks the plan\'s system completion', async () => {
    const { planId, executionId } = await wired.running(THREE)
    land(executionId, planId, 'api')
    land(executionId, planId, 'ui')
    await wired.inFlightByKawai(executionId, 'docs', 'dev')
    await wired.approveNext(planId, content => ({ ...content, changes: content.changes.filter(entry => entry.change !== 'docs') }))
    // The plan's system completion is asked for this execution (the bench's plan service reads no executions, so it refuses and the plan stays open).
    const asked = spyOn(wired.bench.service, 'completeBySystem')
    try {
      ok(await wired.applyAs({ executionId }))
      expect(asked.mock.calls).toEqual([[planId, executionId]])
    } finally {
      asked.mockRestore()
    }
    expect(wired.executions.execution(executionId)).toMatchObject({ state: 'finished', outcome: 'completed' })
  })

  test('a change an Apply added keeps the execution running after every change Start had landed, until it lands too', async () => {
    const { planId, executionId } = await wired.running()
    const added: PlanChange = { ...base, change: 'cli' }
    await wired.approveNext(planId, content => ({ ...content, changes: [...content.changes, added] }))
    ok(await wired.applyAs({ executionId }))
    land(executionId, planId, 'api')
    land(executionId, planId, 'ui')
    expect(completeIfLanded(completion(), executionId)).toBe(false)
    expect(wired.executions.execution(executionId)!.state).toBe('running')
    land(executionId, planId, 'cli')
    expect(completeIfLanded(completion(), executionId)).toBe(true)
    expect(wired.executions.execution(executionId)).toMatchObject({ state: 'finished', outcome: 'completed' })
  })

  test('a cancelled change of the current revision keeps the execution running', async () => {
    const { planId, executionId } = await wired.running()
    land(executionId, planId, 'api')
    const row = wired.executions.change(executionId, 'ui')!
    expect(wired.executions.transition(executionId, 'ui', row, { state: 'cancelled', step: null })).not.toBeNull()
    expect(completeIfLanded(completion(), executionId)).toBe(false)
    expect(wired.executions.execution(executionId)!.state).toBe('running')
  })
})

describe('manifests keep their revision (I5, DC1)', () => {
  test('DC1: a restart owed at revision 2 under a hold, an Apply to 3 choosing continue, then the release: the owed step sends a successor naming 3; the stale row is unchanged and never sent', async () => {
    const { planId, executionId } = await wired.running()
    const ui = await wired.inFlightByKawai(executionId, 'ui', 'dev')
    const moved = wired.executions.change(executionId, 'ui')!
    expect(wired.executions.transition(executionId, 'ui', moved, { state: 'implementing', baselineCommit: 'base-sha' })).not.toBeNull()
    const hold = wired.placeHold(planId, ['ui'], 'hold-dc1')
    const second = await wired.approveNext(planId, reword('ui', 'Start over'))
    ok(await wired.applyAs({ executionId, choices: { ui: 'restart' }, commandId: 'dc1-restart' }))
    const stale = wired.executions.attempts(executionId, 'ui').at(-1)!
    expect(stale).toMatchObject({ kind: 'implement', assignmentId: null })
    expect(stale.manifest.plan.revision).toBe(second.revision)
    // Held: the owed row waits at the gate.
    expect(wired.planFor().dispatches.filter(step => step.change === 'ui')).toEqual([])
    const third = await wired.approveNext(planId, reword('ui', 'Start over, smaller'))
    ok(await wired.applyAs({ executionId, choices: { ui: 'continue' }, commandId: 'dc1-continue' }))
    expect(wired.executions.execution(executionId)!.revision).toBe(third.revision)
    wired.holds.release({ teamId: wired.teamId, holdId: hold.id, changes: ['ui'], reason: 'go on', commandId: 'release-dc1' })
    expect(wired.planFor().dispatches).toContainEqual(expect.objectContaining({ executionId, change: 'ui', kind: 'owed' }))
    await dispatchOwedAttempt({
      team: wired.world.team, executions: wired.executions, plans: wired.bench.plans, tasks: wired.tasks,
      assignments: wired.assignments, results: {} as never,
    }, { executionId, change: 'ui', group: 'middle-devs' })
    const rows = wired.executions.attempts(executionId, 'ui')
    expect(rows).toHaveLength(3)
    // The stale row stays exactly as minted and is never sent.
    expect(rows[1]).toEqual(stale)
    const successor = rows[2]!
    expect(successor).toMatchObject({ kind: 'implement' })
    expect(successor.manifest).toEqual({
      ...stale.manifest,
      plan: { id: planId, revision: third.revision, contentHash: third.hash },
      validation: { reportId: 'rep-next', inputHash: 'ih-next' },
      task: { id: ui.taskId, revision: 1 },
    })
    expect(successor.manifestHash).not.toBe(stale.manifestHash)
    const generation = wired.executions.change(executionId, 'ui')!.generation
    const keys = wired.tasks.store.assignmentsOf(ui.taskId).map(row => row.requestKey)
    expect(keys).toContain(`exec:${executionId}:ui:attempt:${successor.number}:${generation}`)
    expect(keys).not.toContain(`exec:${executionId}:ui:attempt:${stale.number}:${generation}`)
    expect(successor.assignmentId).not.toBeNull()
    // Dispatched once: a second owed pass finds nothing owed.
    expect(wired.planFor().dispatches.filter(step => step.change === 'ui')).toEqual([])
  })

  test('an owed row naming the current revision is sent as it is, with no successor', async () => {
    const { planId, executionId } = await wired.running()
    const ui = await wired.inFlightByKawai(executionId, 'ui', 'dev')
    const moved = wired.executions.change(executionId, 'ui')!
    expect(wired.executions.transition(executionId, 'ui', moved, { state: 'implementing', baselineCommit: 'base-sha' })).not.toBeNull()
    await wired.approveNext(planId, reword('ui', 'Start over'))
    ok(await wired.applyAs({ executionId, choices: { ui: 'restart' } }))
    const owed = wired.executions.attempts(executionId, 'ui').at(-1)!
    await dispatchOwedAttempt({
      team: wired.world.team, executions: wired.executions, plans: wired.bench.plans, tasks: wired.tasks,
      assignments: wired.assignments, results: {} as never,
    }, { executionId, change: 'ui', group: 'middle-devs' })
    const rows = wired.executions.attempts(executionId, 'ui')
    expect(rows).toHaveLength(2)
    expect(rows[1]!.manifest).toEqual(owed.manifest)
    expect(rows[1]!.assignmentId).not.toBeNull()
    expect(wired.tasks.store.get(ui.taskId)!.revision).toBe(1)
  })
})
