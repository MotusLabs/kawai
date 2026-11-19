// Fix attempts after a failed review name the execution's current revision
// (plan-revision-apply D4, invariant I5; plan-execution "A running execution
// keeps its revision") over the Apply bench and the real fix dispatch
// (`dispatchFixAttempt`, the step a failed round takes): with a newer
// revision approved but not applied, the fix attempt's manifest and
// instruction still name the running revision; after an Apply choosing
// continue, the running attempt's manifest is unchanged and the fix attempt's
// names the applied revision.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { PlanContent } from '../../shared/plans'
import { dispatchFixAttempt } from '../plans/execution/executionDispatch'
import { fixFindings } from '../plans/execution/fixFindings'
import { applyBench, type ApplyBench } from './applyBench'

let wired: ApplyBench

beforeAll(async () => {
  wired = await applyBench('apply-fix-manifests')
})
afterAll(() => wired.close())

const reword = (change: string, guidance: string) => (content: PlanContent): PlanContent => ({
  ...content, changes: content.changes.map(entry => (entry.change === change ? { ...entry, guidance } : entry)),
})

/** A running execution whose `ui` attempt was dispatched at revision 1 and whose review round failed. */
async function failedRound() {
  const { planId, executionId } = await wired.running()
  const ui = await wired.inFlightByKawai(executionId, 'ui', 'dev')
  const moved = wired.executions.change(executionId, 'ui')!
  expect(wired.executions.transition(executionId, 'ui', moved, { state: 'implementing', baselineCommit: 'base-sha' })).not.toBeNull()
  wired.answerNewestRow(executionId, 'ui', 1)
  const running = wired.executions.attempts(executionId, 'ui').at(-1)!
  expect(running.manifest.plan.revision).toBe(1)
  return { planId, executionId, ui, running }
}

/** The failed round's fix, as the gated fix step sends it; returns the new attempt and the instruction its handoff carried. */
async function sendFix(executionId: string, taskId: string) {
  const handoffs: Array<{ taskId: string; input: { kind: string; resultId: string; instructions: string; requestKey: string } }> = []
  // The result handoff double records what it is asked and answers with an assignment id.
  const results = {
    handoff: async (_caller: unknown, task: string, input: { kind: string; resultId: string; instructions: string; requestKey: string }) => {
      handoffs.push({ taskId: task, input })
      return { assignment: { id: `assignment-fix-${handoffs.length}-${executionId}` } }
    },
  }
  const round = wired.executions.rounds(executionId, 'ui').at(-1)!
  await dispatchFixAttempt({
    team: wired.world.team, executions: wired.executions, plans: wired.bench.plans, tasks: wired.tasks,
    assignments: wired.assignments, results: results as never,
  }, {
    executionId, change: 'ui', group: 'middle-devs', failingChecks: [{ name: 'unit-tests', conclusion: 'failure', link: null }],
    findingsIds: [], findings: fixFindings(wired.tasks.store, taskId, null), continueFrom: 'base-sha', fixRounds: 0,
  })
  const fix = wired.executions.attempts(executionId, 'ui').at(-1)!
  expect(fix.kind).toBe('fix')
  expect(handoffs).toHaveLength(1)
  const generation = wired.executions.change(executionId, 'ui')!.generation
  expect(handoffs[0]).toMatchObject({ taskId, input: { kind: 'fix', resultId: round.resultId, requestKey: `exec:${executionId}:ui:attempt:${fix.number}:${generation}` } })
  expect(fix.assignmentId).toBe(`assignment-fix-1-${executionId}`)
  return { fix, instruction: handoffs[0]!.input.instructions }
}

describe('fix attempts name the execution\'s current revision', () => {
  // @covers: plan-execution › A running execution keeps its revision › Later instructions keep the revision
  test('a newer revision approved but not applied: the failed review\'s fix attempt still names revision 1 in its manifest and instruction', async () => {
    const world = await failedRound()
    const next = await wired.approveNext(world.planId, reword('ui', 'Use the new store'))
    expect(next.revision).toBeGreaterThan(1)
    const { fix, instruction } = await sendFix(world.executionId, world.ui.taskId)
    expect(fix.manifest.plan).toMatchObject({ revision: 1 })
    expect(instruction).toContain('(revision 1)')
    expect(instruction).not.toContain(`(revision ${next.revision})`)
    expect(wired.executions.execution(world.executionId)!.revision).toBe(1)
  })

  // @covers: plan-revision-apply › The execution keeps its revision history › Manifests keep their revision
  test('after an Apply choosing continue: the running attempt\'s manifest still names revision 1 and the failed review\'s fix attempt names the applied revision', async () => {
    const world = await failedRound()
    const next = await wired.approveNext(world.planId, reword('ui', 'Use the new store'))
    const applied = await wired.applyAs({ executionId: world.executionId, choices: { ui: 'continue' } })
    expect(applied.ok).toBe(true)
    const { fix, instruction } = await sendFix(world.executionId, world.ui.taskId)
    expect(wired.executions.attempts(world.executionId, 'ui').find(row => row.id === world.running.id)).toEqual(world.running)
    expect(fix.manifest.plan).toEqual({ id: world.planId, revision: next.revision, contentHash: next.hash })
    expect(instruction).toContain(`(revision ${next.revision})`)
  })
})
