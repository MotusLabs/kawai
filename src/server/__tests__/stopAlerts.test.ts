// Stop alerts through the production monitor composition over the real
// stores: a stopped change of a running execution sends the Lead role one
// message with its row, across a restart; a Retry then a second stop sends
// another; a finished execution's stop raises nothing; a plan without a Lead
// role gets a row with a null message and no mail; and the summary's stall
// window leaves stop rows out.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import type { StopDetail } from '../../shared/planExecution'
import { StallAlertStore } from '../plans/supervision/stallAlertStore'
import { createPlanWorld, type PlanWorld } from './planHarness'
import { createSupervisionBench, MIN, T0, type SupervisionBench } from './supervisionHarness'

let world: PlanWorld
let bench: SupervisionBench
beforeAll(async () => { world = await createPlanWorld('kawai-stop-alerts-') })
afterAll(() => fs.rmSync(world.root, { recursive: true, force: true }))
beforeEach(() => {
  bench?.db.close()
  bench = createSupervisionBench(world)
})

const alertRows = () => bench.db.db.prepare('SELECT * FROM plan_stall_alerts ORDER BY raised_at, rowid').all() as Array<{ kind: string; change: string; episode_key: string; message_id: string | null; detail_json: string }>

const PUSH_FAILED: StopDetail = { effect: 'push', message: ' ! [remote rejected] aaa -> api (protected branch hook declined)' }

function stop(executionId: string, change = 'api', reason = 'effect-failed', detail: StopDetail | null = PUSH_FAILED) {
  const row = bench.executions.change(executionId, change)!
  expect(bench.executions.transition(executionId, change, row, { state: 'stopped', step: null, stopReason: reason as never, stopDetail: detail })).not.toBeNull()
}

function retry(executionId: string, change = 'api') {
  const row = bench.executions.change(executionId, change)!
  expect(bench.executions.transition(executionId, change, row, { state: 'gating', step: null, stopReason: null, stopDetail: null })).not.toBeNull()
}

async function sweepAt(monitor: ReturnType<SupervisionBench['compose']>['monitor'], at: number) {
  bench.clock.at = at
  monitor.notify(world.team.teamId)
  await monitor.idle()
}

async function stoppedPlan(lead = true) {
  const planId = await bench.approvedPlan(lead)
  const executionId = bench.start(planId)
  bench.clock.at = T0
  stop(executionId)
  return { planId, executionId }
}

describe('stop alerts', () => {
  test("a stop sends the Lead role one message with its row, tagged plan-stop and stop:<reason>, naming the reason, detail, and blocked changes", async () => {
    const { planId } = await stoppedPlan()
    const { monitor } = bench.compose()
    monitor.start()
    await monitor.idle()
    const [row] = alertRows()
    expect(alertRows()).toHaveLength(1)
    expect(row).toMatchObject({ kind: 'stopped', change: 'api' })
    const [mail] = bench.messagesTagged('plan-stop')
    expect(mail!.id).toBe(row!.message_id!)
    expect(mail).toMatchObject({ to_id: 'leads', from_kind: 'system', task_id: null, allowed_profiles: '["opus"]' })
    expect(JSON.parse(mail!.tags)).toEqual(['plan-stop', 'stop:effect-failed'])
    expect(mail!.body).toContain(`change api of plan "Wave C" (${planId}) stopped: An external step failed (effect-failed).`)
    expect(mail!.body).toContain('Step: push.')
    expect(mail!.body).toContain('protected branch hook declined')
    expect(mail!.body).toContain('Blocked until it lands: ui.')
    expect(mail!.body).toContain('until the owner presses Retry')
    expect(bench.messagesTagged('plan-stall')).toHaveLength(0)
    monitor.stop()
  })

  test('a long command error is cut in the mail and kept whole in the record', async () => {
    const planId = await bench.approvedPlan(true)
    const executionId = bench.start(planId)
    bench.clock.at = T0
    const message = 'x'.repeat(5000)
    stop(executionId, 'api', 'effect-failed', { effect: 'push', message })
    const { monitor } = bench.compose()
    monitor.start()
    await monitor.idle()
    const [mail] = bench.messagesTagged('plan-stop')
    expect(mail!.body.includes(message)).toBe(false)
    expect(mail!.body.includes('x'.repeat(2000))).toBe(true)
    expect(JSON.parse(alertRows()[0]!.detail_json).detail.message).toBe(message)
    monitor.stop()
  })

  // @covers: plan-supervision › A stopped change alerts the Lead role once per stop › One alert across a restart
  test('sweeps and a restart while it stays stopped send nothing new', async () => {
    await stoppedPlan()
    const { monitor } = bench.compose()
    monitor.start()
    await monitor.idle()
    await sweepAt(monitor, T0 + 5 * MIN)
    expect(bench.messagesTagged('plan-stop')).toHaveLength(1)
    monitor.stop()
    const restarted = bench.compose().monitor
    bench.clock.at = T0 + 30 * MIN
    restarted.start()
    await restarted.idle()
    expect(bench.messagesTagged('plan-stop')).toHaveLength(1)
    expect(alertRows()).toHaveLength(1)
    restarted.stop()
  })

  // @covers: plan-supervision › A stopped change alerts the Lead role once per stop › A new stop after Retry
  test('a Retry then a second stop sends a second alert', async () => {
    const { executionId } = await stoppedPlan()
    const { monitor } = bench.compose()
    monitor.start()
    await monitor.idle()
    retry(executionId)
    await sweepAt(monitor, T0 + MIN)
    expect(bench.messagesTagged('plan-stop')).toHaveLength(1)
    stop(executionId)
    await sweepAt(monitor, T0 + 2 * MIN)
    expect(bench.messagesTagged('plan-stop')).toHaveLength(2)
    expect(new Set(alertRows().map(row => row.episode_key)).size).toBe(2)
    monitor.stop()
  })

  // @covers: plan-supervision › A stopped change alerts the Lead role once per stop › The owner stops the execution
  test("a finished execution's stop raises nothing", async () => {
    const { planId, executionId } = await stoppedPlan()
    expect(bench.executions.finishExecution(executionId, 'stopped', 'superseded')).toBe(true)
    // An open fix task keeps the team swept after the execution finished.
    bench.fixTask(planId)
    const { monitor } = bench.compose()
    monitor.start()
    await monitor.idle()
    expect(monitor.timerArmed(world.team.teamId)).toBe(true)
    expect(alertRows()).toHaveLength(0)
    expect(bench.messagesTagged('plan-stop')).toHaveLength(0)
    monitor.stop()
  })

  // @covers: plan-supervision › A stopped change alerts the Lead role once per stop › No Lead role
  test('with no Lead role a row with a null message is written and no mail is sent', async () => {
    await stoppedPlan(false)
    const { monitor } = bench.compose()
    monitor.start()
    await monitor.idle()
    expect(alertRows()).toHaveLength(1)
    expect(alertRows()[0]!.message_id).toBeNull()
    expect(bench.messagesTagged('plan-stop')).toHaveLength(0)
    monitor.stop()
  })

  test("the summary's stall window leaves stop rows out", async () => {
    await stoppedPlan()
    const { monitor } = bench.compose()
    monitor.start()
    await monitor.idle()
    expect(alertRows()).toHaveLength(1)
    expect(new StallAlertStore(bench.db.db).raisedSince(world.team.teamId, new Date(0).toISOString())).toHaveLength(0)
    monitor.stop()
  })
})
