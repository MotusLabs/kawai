// plan-supervision 2.3 (D2): a `fixes` entry naming no fix or correction task
// of the plan is a read-time warning on the plan detail, never a refusal —
// approval of the revision carrying it still succeeds.
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import { createPlanBench, createPlanWorld, type PlanBench, type PlanWorld } from './planHarness'
import { fixesReferenceWarnings } from '../../shared/planDecisions'

const KNOWN = 'task-11111111-1111-4111-8111-111111111111'
const UNKNOWN = 'task-22222222-2222-4222-8222-222222222222'
const OTHER_PLAN = 'task-33333333-3333-4333-8333-333333333333'

let world: PlanWorld
let bench: PlanBench
beforeAll(async () => { world = await createPlanWorld('kawai-plan-fixes-warning-') })
afterAll(() => fs.rmSync(world.root, { recursive: true, force: true }))
beforeEach(() => {
  bench?.db.close()
  bench = createPlanBench(world)
})

const changes = (fixes: string[]) => [
  { change: 'api', dependsOn: [], group: 'middle-devs', fixes },
  { change: 'ui', dependsOn: ['api'], group: 'middle-devs', fixes: [fixes[0]!] },
]

function fixTask(taskId: string, planId: string): void {
  bench.db.db.prepare(`INSERT INTO plan_fix_tasks (task_id, team_id, plan_id, source_kind, source_id, created_at) VALUES (?, ?, ?, 'override', ?, 'now')`)
    .run(taskId, world.team.teamId, planId, `decision-${taskId}`)
}

test('the plan detail warns once per unknown id, including a fix task of another plan', async () => {
  const { planId } = await bench.draftInReview({ changes: changes([KNOWN, UNKNOWN, OTHER_PLAN]) })
  fixTask(KNOWN, planId)
  fixTask(OTHER_PLAN, 'plan-elsewhere')
  expect(bench.plans.detail(planId)!.warnings).toEqual([
    `fixes names no fix or correction task of this plan: ${UNKNOWN}`,
    `fixes names no fix or correction task of this plan: ${OTHER_PLAN}`,
  ])
})

test('a plan whose fixes all resolve, or with none, has no warnings', async () => {
  const { planId } = await bench.draftInReview({ changes: changes([KNOWN]) })
  fixTask(KNOWN, planId)
  expect(bench.plans.detail(planId)!.warnings).toEqual([])
  const plain = await bench.draftInReview()
  expect(bench.plans.detail(plain.planId)!.warnings).toEqual([])
})

test('the warning does not refuse approval, and stays on the approved revision', async () => {
  const { planId, revision } = await bench.draftInReview({ changes: changes([UNKNOWN]) })
  expect(bench.plans.detail(planId)!.warnings).toHaveLength(1)
  const outcome = await bench.approve(planId, revision)
  expect(outcome).toMatchObject({ ok: true })
  expect(bench.plans.detail(planId)!.warnings).toEqual([`fixes names no fix or correction task of this plan: ${UNKNOWN}`])
})

test('only standing revisions are read: a withdrawn revision warns nothing', async () => {
  const { planId, revision } = await bench.draftInReview({ changes: changes([UNKNOWN]) })
  expect((await bench.service.withdraw(bench.human, { planId, revision, commandId: 'w' })).ok).toBe(true)
  expect(bench.plans.detail(planId)!.warnings).toEqual([])
})

test('blank entries are left to the structure check', () => {
  expect(fixesReferenceWarnings([], new Set())).toEqual([])
  expect(fixesReferenceWarnings([{ changes: [{ change: 'a', dependsOn: [], group: 'g', acceptance: [], extraChecks: [], guidance: '', fixes: [' '] }] as never }], new Set()))
    .toEqual([])
})
