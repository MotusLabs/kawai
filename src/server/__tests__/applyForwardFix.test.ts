// Apply and forward fixes (plan-revision-apply design D3 "Forward fixes",
// oracle table FX, plan-supervision S4) over the Apply bench with the real
// decision store and fix completion: a revision adding a change that names a
// fix task joins the running execution through Apply, and the fix task
// closes once that change landed and no change of the current approved
// revision naming it is unlanded (FX1); a fix change removed before it lands
// is cancelled and its fix task stays open (FX2); a `fixes`-only difference
// on a landed change applies as metadata with no choice (FX3).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { fixStatus } from '../../shared/planDecisions'
import type { PlanChange, PlanContent } from '../../shared/plans'
import { DecisionStore } from '../plans/decisions/decisionStore'
import { fixPlanFacts } from '../plans/decisions/fixFacts'
import { completeFixTasks } from '../plans/decisions/fixTasks'
import type { SystemCaller } from '../team/systemCaller'
import { applyBench, type ApplyBench } from './applyBench'

let wired: ApplyBench
let decisions: DecisionStore
let serial = 0

beforeAll(async () => {
  wired = await applyBench('apply-fx')
  decisions = new DecisionStore(wired.bench.db.db)
})
afterAll(() => wired.close())

const base = { dependsOn: [] as string[], group: 'middle-devs', acceptance: [] as string[], extraChecks: [], guidance: '', reviewGroup: null }

/** A fix task of the plan, as an override decision creates one. */
function fixTask(planId: string): string {
  const decisionId = `decision-fx-${++serial}`
  const caller: SystemCaller = { kind: 'system', team: wired.world.team, origin: { kind: 'override', decisionId } }
  return wired.tasks.createFixTask(caller, { title: 'Forward fix: api — Wave C', direction: 'Fix it', acceptance: 'Lands' }, created => {
    decisions.insertFixTask({ taskId: created.id, teamId: wired.teamId, planId, sourceKind: 'override', sourceId: decisionId })
  }).id
}

function land(executionId: string, planId: string, change: string): void {
  wired.executions.insertLanding({
    planId, change, executionId, teamId: wired.teamId, mechanism: 'direct', prNumber: null, prUrl: null,
    headSha: 'h', baseSha: 'b', mergeSha: `merge-${change}`, treeVerified: true,
  })
  const row = wired.executions.change(executionId, change)!
  if (wired.executions.transition(executionId, change, row, { state: 'landed', step: null }) === null) throw new Error('land failed')
}

const statusOf = (planId: string, taskId: string) => fixStatus(
  { taskId, status: wired.tasks.store.get(taskId)!.status, superseded: false },
  fixPlanFacts({ plans: wired.bench.plans, executions: wired.executions }, wired.teamId, wired.bench.plans.get(planId)!),
)
const sweep = () => completeFixTasks({ decisions, tasks: wired.tasks, taskStore: wired.tasks.store, plans: wired.bench.plans, executions: wired.executions }, wired.world.team)
const append = (entry: PlanChange) => (content: PlanContent): PlanContent => ({ ...content, changes: [...content.changes, entry] })

function ok<T extends { ok: boolean }>(outcome: T): Extract<T, { ok: true }> {
  if (!outcome.ok) throw new Error(`Apply refused: ${JSON.stringify(outcome)}`)
  return outcome as Extract<T, { ok: true }>
}

describe('Apply and forward fixes (FX)', () => {
  // @covers: plan-revision-apply › Landed work is never redefined › A forward fix is applied
  test('FX1 a change naming a fix task, added by Apply, lands: fixStatus reads running, then the fix task closes once no change of the current approved revision naming it is unlanded', async () => {
    const { planId, executionId } = await wired.running()
    const fix = fixTask(planId)
    await wired.approveNext(planId, append({ ...base, change: 'patch', fixes: [fix] }))
    ok(await wired.applyAs({ executionId }))
    expect(wired.executions.change(executionId, 'patch')).toMatchObject({ state: 'waiting', owns: true })
    expect(statusOf(planId, fix)).toMatchObject({ phase: 'running', executionId, outstanding: ['patch'] })
    expect(await sweep()).toEqual([])
    land(executionId, planId, 'patch')
    expect(statusOf(planId, fix)).toMatchObject({ phase: 'landed', outstanding: [] })
    expect(await sweep()).toEqual([{ taskId: fix, planId }])
    expect(wired.tasks.store.get(fix)!.status).toBe('done')
  })

  test('FX2 a fix change removed before landing is cancelled and its fix task stays open', async () => {
    const { planId, executionId } = await wired.running()
    const fix = fixTask(planId)
    await wired.approveNext(planId, append({ ...base, change: 'patch', fixes: [fix] }))
    ok(await wired.applyAs({ executionId }))
    await wired.approveNext(planId, content => ({ ...content, changes: content.changes.filter(entry => entry.change !== 'patch') }))
    const outcome = ok(await wired.applyAs({ executionId }))
    expect(outcome.applied.changes.find(row => row.change === 'patch')).toMatchObject({ class: 'removed' })
    expect(wired.executions.change(executionId, 'patch')).toMatchObject({ state: 'cancelled', owns: false })
    expect(await sweep()).toEqual([])
    expect(wired.tasks.store.get(fix)!.status).toBe('open')
    expect(statusOf(planId, fix).phase).not.toBe('landed')
  })

  // @covers: plan-revision-apply › Landed work is never redefined › A landed change gains a fix reference
  test('FX3 a fixes-only difference on a landed change applies as metadata with no choice', async () => {
    const { planId, executionId } = await wired.running({ changes: [{ ...base, change: 'api', acceptance: ['API lands'] }, { ...base, change: 'ui', dependsOn: ['api'] }] })
    await wired.inFlight(executionId, 'api', 'dev2')
    land(executionId, planId, 'api')
    const fix = fixTask(planId)
    await wired.approveNext(planId, content => ({ ...content, changes: content.changes.map(entry => (entry.change === 'api' ? { ...entry, fixes: [fix] } : entry)) }))
    const preview = await wired.apply.preview(wired.bench.human, { executionId, revision: wired.bench.plans.get(planId)!.currentApprovedRevision! })
    expect(preview.ok && preview.preview.needed).toEqual([])
    const outcome = ok(await wired.applyAs({ executionId, choices: {} }))
    expect(outcome.applied.changes.find(row => row.change === 'api')).toMatchObject({ class: 'metadata', choice: null, fields: ['fixes'] })
    expect(wired.executions.change(executionId, 'api')).toMatchObject({ state: 'landed' })
  })
})
