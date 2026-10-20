// Stall alerts (plan-supervision 8.3, design D11) through the production
// monitor composition over the real stores: the alert row and Kawai's mail
// commit in one transaction with D11's tags, profiles, and body; a restart
// during a stall sends nothing new (the durable episode key); new progress
// then a new stall sends a second alert; a repeating failure alerts once
// across a restart; a plan without a Lead role gets a row with a null
// message and no mail; and a reply to the alert meets Kawai's reply guard.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import { KAWAI_REPLY_GUIDANCE } from '../../shared/team'
import { raiseStallAlerts } from '../plans/supervision/stallAlerts'
import { StallAlertStore } from '../plans/supervision/stallAlertStore'
import { derivePlanSupervision } from '../plans/supervision/supervisionRead'
import { TaskResultStore } from '../team/taskResultStore'
import { createPlanWorld, type PlanWorld } from './planHarness'
import { createSupervisionBench, MIN, T0, type SupervisionBench } from './supervisionHarness'

let world: PlanWorld
let bench: SupervisionBench
beforeAll(async () => { world = await createPlanWorld('kawai-stall-alerts-') })
afterAll(() => fs.rmSync(world.root, { recursive: true, force: true }))
beforeEach(() => {
  bench?.db.close()
  bench = createSupervisionBench(world)
})

const iso = (at: number) => new Date(at).toISOString()
const alertRows = () => bench.db.db.prepare('SELECT * FROM plan_stall_alerts ORDER BY raised_at, rowid').all() as Array<{ kind: string; episode_key: string; message_id: string | null; change: string }>

/** api implementing, its instruction delivered at T0, the holder idle: stalled from T0 + 15 min. */
async function idleStall(lead = true) {
  const planId = await bench.approvedPlan(lead)
  const executionId = bench.start(planId)
  const { taskId } = await bench.implementing(executionId, planId, iso(T0))
  bench.clock.at = T0
  return { planId, executionId, taskId }
}

async function sweepAt(monitor: ReturnType<SupervisionBench['compose']>['monitor'], at: number) {
  bench.clock.at = at
  monitor.notify(world.team.teamId)
  await monitor.idle()
}

describe('raising an alert', () => {
  test("the alert row and Kawai's mail commit together, tagged plan-stall and stall:<kind>, under the Lead role's profiles with D11's body", async () => {
    const { planId, executionId } = await idleStall()
    const { monitor } = bench.compose()
    monitor.start()
    await monitor.idle()
    expect(alertRows()).toHaveLength(0)
    await sweepAt(monitor, T0 + 20 * MIN)
    const [row] = alertRows()
    expect(row).toMatchObject({ kind: 'no-progress', change: 'api', episode_key: iso(T0) })
    const [mail] = bench.messagesTagged('plan-stall')
    expect(mail!.id).toBe(row!.message_id!)
    expect(mail).toMatchObject({ to_id: 'leads', from_kind: 'system', task_id: null, allowed_profiles: '["opus"]' })
    expect(JSON.parse(mail!.tags)).toEqual(['plan-stall', 'stall:no-progress'])
    expect(mail!.body).toContain(`change api of plan "Wave C" (${planId}) is stalled: no-progress`)
    expect(mail!.body).toContain('Stage: implement attempt.')
    expect(mail!.body).toContain('Holder: dev (group middle-devs, profile default).')
    expect(mail!.body).toContain('Last progress: none.')
    expect(mail!.body).toContain('Rounds:\n- none yet')
    expect(mail!.body).toContain('Open cards: none.')
    expect(mail!.body).toContain('while the holder sat idle')
    expect(mail!.body).toContain('decision_ask')
    expect(mail!.body).toContain("Retry and Stop are the owner's")
    expect(bench.announced.filter(id => id === planId).length).toBeGreaterThan(0)
    expect(executionId).toBeTruthy()
    monitor.stop()
  })

  test('a failing row insert rolls the mail back: nothing is sent without its record', async () => {
    const { planId } = await idleStall()
    const { reads } = bench.compose()
    const derived = derivePlanSupervision(reads, world.team.teamId, planId, new Date(T0 + 20 * MIN))!
    expect(derived.changes[0]!.outcome).toBe('stalled')
    const alerts = new StallAlertStore(bench.db.db)
    const failing = { episode: alerts.episode.bind(alerts), insert: () => { throw new Error('insert failed') } }
    expect(() => raiseStallAlerts({ db: bench.db.db, mail: bench.mail, alerts: failing, plans: bench.plans }, world.team, planId, derived)).toThrow('insert failed')
    expect(bench.messagesTagged('plan-stall')).toHaveLength(0)
    // A lost episode race (the row already written) rolls back too.
    const raced = { episode: () => null, insert: (input: Parameters<StallAlertStore['insert']>[0]) => ({ ...alerts.insert({ ...input, messageId: null }), inserted: false }) }
    expect(() => raiseStallAlerts({ db: bench.db.db, mail: bench.mail, alerts: raced, plans: bench.plans }, world.team, planId, derived)).toThrow('recorded meanwhile')
    expect(bench.messagesTagged('plan-stall')).toHaveLength(0)
  })

  test('with no Lead role a row with a null message is written and no mail is sent', async () => {
    await idleStall(false)
    const { monitor } = bench.compose()
    monitor.start()
    await sweepAt(monitor, T0 + 20 * MIN)
    expect(alertRows()).toEqual([expect.objectContaining({ kind: 'no-progress', message_id: null })])
    expect(bench.messagesTagged('plan-stall')).toHaveLength(0)
    monitor.stop()
  })

  test("a reply to the alert hits Kawai's reply guard and queues nothing", async () => {
    await idleStall()
    const { monitor } = bench.compose()
    monitor.start()
    await sweepAt(monitor, T0 + 20 * MIN)
    const [mail] = bench.messagesTagged('plan-stall')
    // The Lead received it.
    bench.db.db.prepare("UPDATE team_messages SET state = 'delivered', claimed_by = 'lead', delivered_at = ? WHERE id = ?").run(iso(T0 + 21 * MIN), mail!.id)
    const count = () => (bench.db.db.prepare('SELECT COUNT(*) AS n FROM team_messages').get() as { n: number }).n
    const before = count()
    await expect(bench.mailbox.reply(bench.agent('lead'), { message_id: mail!.id, body: 'on it' })).rejects.toThrow(KAWAI_REPLY_GUIDANCE)
    await expect(bench.mailbox.reply(bench.human, { message_id: mail!.id, body: 'status?' })).rejects.toThrow(KAWAI_REPLY_GUIDANCE)
    expect(count()).toBe(before)
    monitor.stop()
  })
})

describe('episodes', () => {
  test('a restart during a stall sends nothing new', async () => {
    await idleStall()
    const first = bench.compose().monitor
    first.start()
    await sweepAt(first, T0 + 20 * MIN)
    expect(bench.messagesTagged('plan-stall')).toHaveLength(1)
    first.stop()
    // The restarted monitor seeds waitEndedAt at its start, so it derives the
    // stall again only after another idle deadline: the same episode key.
    const restarted = bench.compose().monitor
    bench.clock.at = T0 + 30 * MIN
    restarted.start()
    await restarted.idle()
    await sweepAt(restarted, T0 + 50 * MIN)
    expect(alertRows()).toHaveLength(1)
    expect(bench.messagesTagged('plan-stall')).toHaveLength(1)
    expect(bench.logged).toEqual([])
    restarted.stop()
  })

  test('a restart never raises a stall early: the startup sweep seeds the wait time and alerts only one deadline later', async () => {
    await idleStall()
    // The server starts three hours after the delivery, long past every deadline.
    bench.clock.at = T0 + 3 * 60 * MIN
    const { monitor } = bench.compose()
    monitor.start()
    await monitor.idle()
    expect(alertRows()).toHaveLength(0)
    await sweepAt(monitor, T0 + 3 * 60 * MIN + 14 * MIN)
    expect(alertRows()).toHaveLength(0)
    await sweepAt(monitor, T0 + 3 * 60 * MIN + 16 * MIN)
    expect(alertRows()).toEqual([expect.objectContaining({ kind: 'no-progress', episode_key: iso(T0) })])
    monitor.stop()
  })

  test('new progress then a new stall sends a second alert', async () => {
    const { taskId } = await idleStall()
    const { monitor } = bench.compose()
    monitor.start()
    await sweepAt(monitor, T0 + 20 * MIN)
    expect(bench.messagesTagged('plan-stall')).toHaveLength(1)
    // A result at T0 + 25 min is progress: the episode ends and the deadline restarts.
    bench.clock.at = T0 + 25 * MIN
    new TaskResultStore(bench.db.db).insert({
      teamId: world.team.teamId, taskId, summary: 'first cut', commit: 'abc', diff: null, worktree: null, tests: [], limitations: null, taskRevision: 1,
      submittedBy: { kind: 'agent', sessionId: 'dev' },
    }, iso(T0 + 25 * MIN))
    await sweepAt(monitor, T0 + 30 * MIN)
    expect(bench.messagesTagged('plan-stall')).toHaveLength(1)
    await sweepAt(monitor, T0 + 45 * MIN)
    const rows = alertRows()
    expect(rows.map(row => row.episode_key)).toEqual([iso(T0), iso(T0 + 25 * MIN)])
    expect(bench.messagesTagged('plan-stall')).toHaveLength(2)
    monitor.stop()
  })

  test('a repeating failure alerts once, and a restart sends nothing new', async () => {
    const { planId, executionId, taskId } = await idleStall()
    bench.setChange(executionId, 'api', { state: 'implementing', step: null, taskId })
    const results = new TaskResultStore(bench.db.db)
    const failing = [{ name: 'ci / unit-tests', source: 'actions' as const, conclusion: 'failure', link: 'https://ci.example.internal/1', startedAt: null, completedAt: null }]
    const attempt = bench.executions.insertAttempt({ executionId, change: 'api', kind: 'fix', assignmentId: null, manifest: {} as never, manifestHash: 'm' } as never)
    for (const round of [1, 2]) {
      const result = results.insert({ teamId: world.team.teamId, taskId, summary: `r${round}`, commit: `c${round}`, diff: null, worktree: null, tests: [], limitations: null, taskRevision: 1, submittedBy: { kind: 'agent', sessionId: 'dev' } })
      const { round: row } = bench.executions.insertRound({ executionId, change: 'api', attemptId: attempt.id, resultId: result.id, commitSha: `c${round}`, fixRound: round > 1 })
      bench.executions.setRoundCi(row.id, failing, null)
      bench.executions.decideRound(row.id, 'fail')
    }
    // Fresh activity, so only the repeating failure can stall it.
    bench.holder.turnRunning = true
    const first = bench.compose().monitor
    first.start()
    await first.idle()
    const rows = alertRows()
    expect(rows).toEqual([expect.objectContaining({ kind: 'repeating-failure' })])
    const [mail] = bench.messagesTagged('stall:repeating-failure')
    expect(mail!.body).toContain('Two consecutive rounds failed with the same signature: ci / unit-tests.')
    expect(mail!.body).toContain('- round 1: fail; failing ci / unit-tests (https://ci.example.internal/1)')
    expect(mail!.body).toContain('- round 2: fail; failing ci / unit-tests')
    first.stop()
    const restarted = bench.compose().monitor
    restarted.start()
    await restarted.idle()
    expect(alertRows()).toHaveLength(1)
    expect(bench.messagesTagged('plan-stall')).toHaveLength(1)
    restarted.stop()
    expect(planId).toBeTruthy()
  })
})
