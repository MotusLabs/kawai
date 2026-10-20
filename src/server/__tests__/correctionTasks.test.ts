// Correction tasks for failed promotions (plan-supervision 8.5, design D8)
// through the production monitor composition over the real stores: a
// promotion stored as `failed:promotion-conflict` or `failed:ci-failed` gets
// one correction task, created by Kawai with the D8 title and evidence,
// its `plan_fix_tasks` row, and its dispatch to the Lead role — once, across
// a restart; every other failure and a cancellation get none; it closes by
// the 8.4 landing rule, or once a later promotion of the plan merged.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import { PROMOTION_FAILURES, type PromotionOutcome } from '../../shared/planIntegration'
import { planInput } from '../../shared/__tests__/planFixtures'
import { CORRECTION_ACCEPTANCE } from '../plans/decisions/correctionText'
import { DecisionConflict } from '../plans/decisions/decisionStore'
import { createCorrectionTasks } from '../plans/decisions/fixTasks'
import { createPlanWorld, type PlanWorld } from './planHarness'
import { createSupervisionBench, type SupervisionBench } from './supervisionHarness'

let world: PlanWorld
let bench: SupervisionBench
beforeAll(async () => { world = await createPlanWorld('kawai-correction-tasks-') })
afterAll(() => fs.rmSync(world.root, { recursive: true, force: true }))
beforeEach(() => {
  bench?.db.close()
  bench = createSupervisionBench(world)
})

const LINK = 'https://ci.example.internal/run/7'

/** A finished promotion of the plan with this outcome and detail. */
function promotion(planId: string, outcome: PromotionOutcome, detail: Record<string, unknown> | null = null, patch: { ci?: unknown; prNumber?: number; prUrl?: string } = {}) {
  const row = bench.integration.insertPromotion({
    teamId: world.team.teamId, planId, branch: 'wave/int', commandId: `cmd-${crypto.randomUUID()}`, fromSha: 'from', throughSeq: 1, targetBranch: 'master', floor: {},
  })
  if (Object.keys(patch).length) bench.integration.patchPromotion(row.id, patch)
  if (outcome === 'merged') bench.integration.patchPromotion(row.id, { mergeSha: 'merge-promo' })
  bench.integration.finishPromotion(row.id, outcome, detail)
  return bench.integration.promotion(row.id)!
}

const conflict = (planId: string) => promotion(planId, 'failed:promotion-conflict',
  { message: 'wave/int conflicts with master in src/a.ts, src/b.ts.', files: ['src/a.ts', 'src/b.ts'] }, { prNumber: 41, prUrl: 'https://github.example.internal/o/r/pull/41' })

async function sweep() {
  const { monitor } = bench.compose()
  monitor.start()
  await monitor.idle()
  monitor.stop()
}

const corrections = () => bench.db.db.prepare("SELECT task_id, source_id, plan_id FROM plan_fix_tasks WHERE source_kind = 'promotion' ORDER BY created_at, rowid").all() as Array<{ task_id: string; source_id: string; plan_id: string }>
const status = (taskId: string) => bench.tasks.get(taskId)!.status

describe('creation', () => {
  test('a promotion stored as failed:promotion-conflict gets one correction task with the D8 title and evidence, and its instruction names fixes, also across a restart', async () => {
    const planId = await bench.approvedPlan()
    const failed = conflict(planId)
    await sweep()
    await sweep()
    const rows = corrections()
    expect(rows).toEqual([{ task_id: rows[0]!.task_id, source_id: failed.id, plan_id: planId }])
    const task = bench.tasks.get(rows[0]!.task_id)!
    expect(task).toMatchObject({ title: 'Correct failed promotion: promotion-conflict — Wave C', planId: null, worktree: null, openspecChange: null, creator: { kind: 'system', sessionId: null } })
    const revision = bench.tasks.revisions(task.id)[0]!
    expect(revision.acceptance).toBe(CORRECTION_ACCEPTANCE)
    for (const part of [failed.id, `Promotion ${failed.number}`, 'https://github.example.internal/o/r/pull/41', 'closed by Kawai', '- src/a.ts', '- src/b.ts', `fixes: ["${task.id}"]`, 'plan_submit_for_review']) {
      expect(revision.direction).toContain(part)
    }
    const [instruction] = bench.mail.forTask(task.id)
    expect(instruction).toMatchObject({ fromKind: 'system', toKind: 'group', toId: 'leads', tags: ['plan-fix'], allowedProfiles: ['opus'] })
    expect(instruction!.body).toContain(`fixes: ["${task.id}"]`)
    const assignment = bench.db.db.prepare('SELECT request_key FROM team_task_assignments WHERE task_id = ?').get(task.id) as { request_key: string }
    expect(assignment.request_key).toBe(`correct:${failed.id}`)
    expect(bench.logged).toEqual([])
  })

  test('a failed:ci-failed promotion names its failing checks with their links', async () => {
    const planId = await bench.approvedPlan()
    const ci = [{ name: 'ci / unit-tests', source: 'actions', conclusion: 'failure', link: LINK, startedAt: null, completedAt: null }]
    promotion(planId, 'failed:ci-failed', { message: 'CI failed on head-9: ci / unit-tests.', checks: ['ci / unit-tests'], head: 'head-9' }, { ci })
    await sweep()
    const direction = bench.tasks.revisions(corrections()[0]!.task_id)[0]!.direction
    expect(direction).toContain('Failing checks on head-9:')
    expect(direction).toContain(`- ci / unit-tests (${LINK})`)
    expect(bench.tasks.get(corrections()[0]!.task_id)!.title).toBe('Correct failed promotion: ci-failed — Wave C')
  })

  test('the other failures and a cancellation create none', async () => {
    const planId = await bench.approvedPlan()
    const others = PROMOTION_FAILURES.filter(reason => reason !== 'promotion-conflict' && reason !== 'ci-failed').map(reason => `failed:${reason}` as PromotionOutcome)
    expect(others).toContain('failed:target-moved')
    for (const outcome of [...others, 'cancelled', 'merged'] as PromotionOutcome[]) promotion(planId, outcome, { message: outcome })
    await sweep()
    expect(corrections()).toEqual([])
    expect(bench.db.db.prepare("SELECT COUNT(*) AS n FROM team_tasks WHERE title LIKE 'Correct failed promotion%'").get()).toEqual({ n: 0 })
  })

  test('without a Lead role the correction is created unassigned for the owner', async () => {
    const planId = await bench.approvedPlan(false)
    conflict(planId)
    await sweep()
    const taskId = corrections()[0]!.task_id
    expect(bench.mail.forTask(taskId)).toEqual([])
    expect(bench.db.db.prepare('SELECT COUNT(*) AS n FROM team_task_assignments WHERE task_id = ?').get(taskId)).toEqual({ n: 0 })
  })

  test('a source another writer took first rolls the whole creation back and is skipped', async () => {
    const planId = await bench.approvedPlan()
    conflict(planId)
    const taken = { insertFixTask: () => { throw new DecisionConflict('fix-source-taken', 'taken') } }
    const created = createCorrectionTasks({ db: bench.db.db, decisions: taken, tasks: bench.taskService, assignments: bench.assignments, plans: bench.plans, promotions: bench.integration }, world.team)
    expect(created).toEqual([])
    expect(bench.db.db.prepare("SELECT COUNT(*) AS n FROM team_tasks WHERE title LIKE 'Correct failed promotion%'").get()).toEqual({ n: 0 })
    expect(bench.db.db.prepare("SELECT COUNT(*) AS n FROM team_messages WHERE tags LIKE '%plan-fix%'").get()).toEqual({ n: 0 })
  })

  test('a promotion finishing while the monitor runs wakes it, and the correction is created without a restart', async () => {
    const planId = await bench.approvedPlan()
    const { monitor } = bench.compose()
    monitor.start()
    await monitor.idle()
    conflict(planId)
    // The store's notice is delivered in a microtask after the write.
    await Promise.resolve()
    await monitor.idle()
    expect(corrections()).toHaveLength(1)
    monitor.stop()
  })
})

describe('completion', () => {
  test('a landed change naming the correction closes it by the 8.4 rule', async () => {
    const planId = await bench.approvedPlan()
    conflict(planId)
    await sweep()
    const taskId = corrections()[0]!.task_id
    const changes = (planInput().changes as Array<Record<string, unknown>>).map(entry => (entry.change === 'api' ? { ...entry, fixes: [taskId] } : entry))
    await bench.revise(planId, { changes })
    const executionId = bench.start(planId)
    await sweep()
    expect(status(taskId)).toBe('open')
    bench.land(executionId, planId, 'api', 'merge-fix-1')
    await sweep()
    expect(status(taskId)).toBe('done')
    expect(bench.tasks.journal(taskId).at(-1)!.text).toContain('Kawai closes this correction task: api (merge merge-fix-1)')
  })

  test('a later merged promotion closes it with a note naming that promotion', async () => {
    const planId = await bench.approvedPlan()
    // A merge before the failure is not later: it closes nothing.
    promotion(planId, 'merged')
    conflict(planId)
    const open = bench.compose().monitor
    open.start()
    await open.idle()
    const taskId = corrections()[0]!.task_id
    expect(status(taskId)).toBe('open')
    expect(open.timerArmed(world.team.teamId)).toBe(true)
    open.stop()
    const merged = promotion(planId, 'merged')
    const { monitor } = bench.compose()
    monitor.start()
    await monitor.idle()
    expect(status(taskId)).toBe('done')
    // Nothing is owed any more: no open correction, no uncorrected promotion, so the timer stops.
    expect(monitor.timerArmed(world.team.teamId)).toBe(false)
    monitor.stop()
    const note = bench.tasks.journal(taskId).at(-1)!
    expect(note.author).toEqual({ kind: 'system', sessionId: null })
    expect(note.text).toContain(`promotion ${merged.number} (${merged.id}) of the plan merged`)
  })
})
