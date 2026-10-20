// Fix and correction task completion (plan-supervision 8.4, design D8): a
// change counts as landed when it has a landing fact and its definition in
// the landing execution's revision names the task; it counts as outstanding
// when the current approved revision names the task and it has no landing
// fact. Kawai closes the task, as its creator through its own origin, once
// one has landed and none is outstanding — through the monitor's sweep over
// the real stores, journaled with the merge commits.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import { fixStatus } from '../../shared/planDecisions'
import { planInput } from '../../shared/__tests__/planFixtures'
import { fixPlanFacts } from '../plans/decisions/fixFacts'
import { completeFixTasks } from '../plans/decisions/fixTasks'
import { TaskResultStore } from '../team/taskResultStore'
import { createPlanWorld, type PlanWorld } from './planHarness'
import { createSupervisionBench, type SupervisionBench } from './supervisionHarness'

let world: PlanWorld
let bench: SupervisionBench
beforeAll(async () => { world = await createPlanWorld('kawai-fix-completion-') })
afterAll(() => fs.rmSync(world.root, { recursive: true, force: true }))
beforeEach(() => {
  bench?.db.close()
  bench = createSupervisionBench(world)
})

/** The fixture changes with `fixes` set on the named ones. */
const naming = (taskId: string, ...changes: string[]) => ({
  changes: (planInput().changes as Array<Record<string, unknown>>).map(entry => (changes.includes(String(entry.change)) ? { ...entry, fixes: [taskId] } : entry)),
})

/** One sweep of the production monitor. */
async function sweep() {
  const { monitor } = bench.compose()
  monitor.start()
  await monitor.idle()
  monitor.stop()
}

const status = (taskId: string) => bench.tasks.get(taskId)!.status
const journal = (taskId: string) => bench.tasks.journal(taskId).map(entry => entry.text)

async function planWithFix() {
  const planId = await bench.approvedPlan()
  const fixId = bench.fixTask(planId)
  return { planId, fixId }
}

describe('completion', () => {
  test('the task closes once a naming change has landed and none is outstanding, with a note naming the merge commits', async () => {
    const { planId, fixId } = await planWithFix()
    await bench.revise(planId, naming(fixId, 'api'))
    const executionId = bench.start(planId)
    bench.land(executionId, planId, 'api', 'merge-api-1')
    await sweep()
    expect(status(fixId)).toBe('done')
    const entry = bench.tasks.journal(fixId).at(-1)!
    expect(entry.author).toEqual({ kind: 'system', sessionId: null })
    expect(entry.text).toContain('api (merge merge-api-1)')
    // A repeat sweep writes nothing more.
    const count = bench.tasks.journal(fixId).length
    await sweep()
    expect(bench.tasks.journal(fixId).length).toBe(count)
  })

  test('one change landed of two keeps it open', async () => {
    const { planId, fixId } = await planWithFix()
    await bench.revise(planId, naming(fixId, 'api', 'ui'))
    const executionId = bench.start(planId)
    bench.land(executionId, planId, 'api', 'merge-api-1')
    await sweep()
    expect(status(fixId)).toBe('open')
    bench.land(executionId, planId, 'ui', 'merge-ui-1')
    await sweep()
    expect(status(fixId)).toBe('done')
    expect(journal(fixId).at(-1)).toContain('api (merge merge-api-1), ui (merge merge-ui-1)')
  })

  test('a revision naming the task with nothing landed keeps it open', async () => {
    const { planId, fixId } = await planWithFix()
    await bench.revise(planId, naming(fixId, 'api'))
    bench.start(planId)
    await sweep()
    expect(status(fixId)).toBe('open')
  })

  test('a change that landed from one revision still closes the task after a later revision, which no longer names it, is approved', async () => {
    const { planId, fixId } = await planWithFix()
    const landedFrom = await bench.revise(planId, naming(fixId, 'api'))
    const executionId = bench.start(planId)
    expect(bench.executions.execution(executionId)!.revision).toBe(landedFrom)
    bench.land(executionId, planId, 'api', 'merge-api-5')
    const later = await bench.revise(planId, {})
    expect(later).toBe(landedFrom + 1)
    expect(bench.plans.approvedRevision(planId)!.content.changes.some(change => change.fixes?.includes(fixId))).toBe(false)
    await sweep()
    expect(status(fixId)).toBe('done')
    expect(journal(fixId).at(-1)).toContain('api (merge merge-api-5)')
  })

  test('a later revision that adds another naming change keeps the task open until that change lands', async () => {
    const { planId, fixId } = await planWithFix()
    await bench.revise(planId, naming(fixId, 'api'))
    const first = bench.start(planId)
    bench.land(first, planId, 'api', 'merge-api-1')
    await bench.revise(planId, naming(fixId, 'api', 'ui'))
    await sweep()
    expect(status(fixId)).toBe('open')
    bench.executions.finishExecution(first, 'completed')
    const second = bench.start(planId)
    bench.land(second, planId, 'ui', 'merge-ui-2')
    await sweep()
    expect(status(fixId)).toBe('done')
  })

  test('a superseded fix stays cancelled', async () => {
    const { planId, fixId } = await planWithFix()
    await bench.taskService.setStatus(bench.human, fixId, 'cancelled', 'Superseded by a later override.')
    await bench.revise(planId, naming(fixId, 'api'))
    const executionId = bench.start(planId)
    bench.land(executionId, planId, 'api', 'merge-api-1')
    await sweep()
    expect(status(fixId)).toBe('cancelled')
  })

  test('an owner-accepted no-change result leaves the task done, Kawai writes nothing for it, and fixStatus reads no change', async () => {
    const { planId, fixId } = await planWithFix()
    new TaskResultStore(bench.db.db).insert({
      teamId: world.team.teamId, taskId: fixId, summary: 'The code already matches the override.', commit: null, diff: 'none', worktree: null, tests: [], limitations: null,
      taskRevision: 1, submittedBy: { kind: 'agent', sessionId: 'lead' },
    })
    await bench.taskService.setStatus(bench.human, fixId, 'done', 'Accepted: no change needed.')
    const count = bench.tasks.journal(fixId).length
    const closed = await completeFixTasks({ decisions: bench.decisions, tasks: bench.taskService, taskStore: bench.tasks, plans: bench.plans, executions: bench.executions }, world.team)
    expect(closed).toEqual([])
    await sweep()
    expect(bench.tasks.journal(fixId).length).toBe(count)
    expect(status(fixId)).toBe('done')
    const plan = bench.plans.get(planId)!
    expect(fixStatus({ taskId: fixId, status: 'done', superseded: false }, fixPlanFacts({ plans: bench.plans, executions: bench.executions }, world.team.teamId, plan)).phase).toBe('no-change')
  })

  test("another team's fix rows are never read", async () => {
    const { planId, fixId } = await planWithFix()
    await bench.revise(planId, naming(fixId, 'api'))
    const executionId = bench.start(planId)
    bench.land(executionId, planId, 'api', 'merge-api-1')
    const closed = await completeFixTasks({ decisions: bench.decisions, tasks: bench.taskService, taskStore: bench.tasks, plans: bench.plans, executions: bench.executions },
      { teamId: '/elsewhere/.git', groupsRoot: '/elsewhere' })
    expect(closed).toEqual([])
    expect(status(fixId)).toBe('open')
  })
})
