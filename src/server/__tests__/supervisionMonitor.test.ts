// The supervision monitor's loop (plan-supervision 8.2, 8.6; design D11):
// its scheduling over recording doubles — single-flight sweeps, a logged
// failure retried by the next trigger, the work-bound timer, the startup
// `waitEndedAt` seed, the named-wait observation, and the change-only detail
// push — then the production composition over the real stores: the timer
// follows running executions, promotions, and open fix tasks; a sweep that
// alerts and closes a fix writes no execution row; and a named wait restarts
// a change's no-progress clock.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import type { ChangeSupervision } from '../../shared/planSupervision'
import { SupervisionMonitor, type DerivedPlan, type SupervisionMonitorDeps } from '../plans/supervision/SupervisionMonitor'
import { detailViewKey } from '../plans/supervision/monitorComposition'
import type { PlanSupervisionDetail } from '../../shared/planReport'
import { createPlanWorld, type PlanWorld } from './planHarness'
import { createSupervisionBench, MIN, T0, type SupervisionBench } from './supervisionHarness'

const tick = () => new Promise(resolve => setTimeout(resolve, 5))

function change(name: string, cause: ChangeSupervision['cause'], alsoApplying: ChangeSupervision['alsoApplying'] = []): ChangeSupervision {
  return { change: name, outcome: 'running', cause, alsoApplying, stage: 'implement', holder: null, progress: null, activity: null, stall: null, landing: null, lastRound: null }
}

interface Doubles {
  deps: SupervisionMonitorDeps
  sweeps: string[]
  announced: string[]
  logged: unknown[]
  notify: { fn: ((teamId: string) => void) | null }
  set: { work: boolean; key: string; failNext: boolean; gate: Promise<void> | null; changes: ChangeSupervision[] }
}

function doubles(now = () => new Date(T0)): Doubles {
  const sweeps: string[] = []
  const announced: string[] = []
  const logged: unknown[] = []
  const notify: Doubles['notify'] = { fn: null }
  const set: Doubles['set'] = { work: true, key: 'k1', failNext: false, gate: null, changes: [] }
  const deps: SupervisionMonitorDeps = {
    teamsWithWork: () => (set.work ? ['team-a'] : []),
    hasWork: () => set.work,
    runningChanges: () => [{ executionId: 'exec-1', change: 'api' }],
    plansOf: () => ['plan-1'],
    derive: (teamId): DerivedPlan => {
      sweeps.push(teamId)
      if (set.failNext) {
        set.failNext = false
        throw new Error('derive failed')
      }
      return { executionId: 'exec-1', revision: 1, inputs: [], changes: set.changes }
    },
    raiseStalls: () => 0,
    manageFixes: async () => { if (set.gate) await set.gate },
    viewKey: () => set.key,
    announce: planId => announced.push(planId),
    subscribe: fn => { notify.fn = fn; return () => { notify.fn = null } },
    now, debounceMs: 0, timerMs: 3_600_000, log: (_message, error) => logged.push(error),
  }
  return { deps, sweeps, announced, logged, notify, set }
}

describe('the loop', () => {
  test('startup sweeps each team with work once and seeds every running change with the startup time', async () => {
    const d = doubles()
    const monitor = new SupervisionMonitor(d.deps)
    monitor.start()
    expect(monitor.waitEndedAt('exec-1', 'api')).toBe(new Date(T0).toISOString())
    await monitor.idle()
    expect(d.sweeps).toEqual(['team-a'])
    monitor.stop()
  })

  test('sweeps are single-flight: notifications during a sweep run exactly one more after it', async () => {
    const d = doubles()
    let release!: () => void
    d.set.gate = new Promise(resolve => { release = resolve })
    const monitor = new SupervisionMonitor(d.deps)
    monitor.start()
    await tick()
    expect(d.sweeps).toEqual(['team-a'])
    d.notify.fn!('team-a')
    d.notify.fn!('team-a')
    d.notify.fn!('team-a')
    await tick()
    expect(d.sweeps).toEqual(['team-a'])
    d.set.gate = null
    release()
    await monitor.idle()
    expect(d.sweeps).toEqual(['team-a', 'team-a'])
    monitor.stop()
  })

  test('a sweep error is logged and the next trigger retries', async () => {
    const d = doubles()
    d.set.failNext = true
    const monitor = new SupervisionMonitor(d.deps)
    monitor.start()
    await monitor.idle()
    expect((d.logged[0] as Error).message).toBe('derive failed')
    expect(d.announced).toEqual([])
    d.notify.fn!('team-a')
    await monitor.idle()
    expect(d.sweeps).toEqual(['team-a', 'team-a'])
    expect(d.announced).toEqual(['plan-1'])
    monitor.stop()
  })

  test('the timer is armed while the team has work and stops, unwatching the team, once it has none', async () => {
    const d = doubles()
    const monitor = new SupervisionMonitor(d.deps)
    monitor.start()
    await monitor.idle()
    expect(monitor.timerArmed('team-a')).toBe(true)
    d.set.work = false
    d.notify.fn!('team-a')
    await monitor.idle()
    expect(monitor.timerArmed('team-a')).toBe(false)
    // An unwatched team without work ignores notifications.
    d.notify.fn!('team-a')
    await monitor.idle()
    expect(d.sweeps).toEqual(['team-a', 'team-a'])
    monitor.stop()
  })

  test('the timer runs the next sweep', async () => {
    const d = doubles()
    const monitor = new SupervisionMonitor({ ...d.deps, timerMs: 5 })
    monitor.start()
    await monitor.idle()
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(d.sweeps.length).toBeGreaterThan(1)
    monitor.stop()
    const count = d.sweeps.length
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(d.sweeps.length).toBe(count)
  })

  test('a change seen in a named wait moves its waitEndedAt; a running change does not', async () => {
    let now = T0
    const d = doubles(() => new Date(now))
    d.set.changes = [change('api', { kind: 'ci', pending: ['ci'] }), change('ui', { kind: 'stage', stage: 'implement', step: null })]
    const monitor = new SupervisionMonitor(d.deps)
    monitor.start()
    await monitor.idle()
    now = T0 + 10 * MIN
    d.notify.fn!('team-a')
    await monitor.idle()
    expect(monitor.waitEndedAt('exec-1', 'api')).toBe(new Date(T0 + 10 * MIN).toISOString())
    expect(monitor.waitEndedAt('exec-1', 'ui')).toBeNull()
    // A repeating-failure stall with a wait also applying counts as in a wait.
    d.set.changes = [change('ui', { kind: 'stall', stall: 'repeating-failure' }, [{ kind: 'ci', pending: [] }])]
    now = T0 + 20 * MIN
    d.notify.fn!('team-a')
    await monitor.idle()
    expect(monitor.waitEndedAt('exec-1', 'ui')).toBe(new Date(T0 + 20 * MIN).toISOString())
    monitor.stop()
  })
})

describe('the detail push (8.6)', () => {
  test('two sweeps with no change push once; a changed view pushes again', async () => {
    const d = doubles()
    const monitor = new SupervisionMonitor(d.deps)
    monitor.start()
    await monitor.idle()
    d.notify.fn!('team-a')
    await monitor.idle()
    expect(d.sweeps).toEqual(['team-a', 'team-a'])
    expect(d.announced).toEqual(['plan-1'])
    d.set.key = 'k2'
    d.notify.fn!('team-a')
    await monitor.idle()
    expect(d.announced).toEqual(['plan-1', 'plan-1'])
    monitor.stop()
  })

  test('a raised alert pushes the plan even when its view is unchanged', async () => {
    const d = doubles()
    let raise = 0
    const monitor = new SupervisionMonitor({ ...d.deps, raiseStalls: () => raise })
    monitor.start()
    await monitor.idle()
    raise = 1
    d.notify.fn!('team-a')
    await monitor.idle()
    expect(d.announced).toEqual(['plan-1', 'plan-1'])
    monitor.stop()
  })
})

let world: PlanWorld
let bench: SupervisionBench
beforeAll(async () => { world = await createPlanWorld('kawai-supervision-monitor-') })
afterAll(() => fs.rmSync(world.root, { recursive: true, force: true }))
beforeEach(() => {
  bench?.db.close()
  bench = createSupervisionBench(world)
})

/** Every row of the execution tables, for the no-write check. */
function executionRows(): string {
  const tables = (bench.db.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND (name LIKE 'plan_execution%' OR name LIKE 'plan_change_%' OR name LIKE 'plan_landing%' OR name LIKE 'plan_integration%' OR name LIKE 'plan_promotion%') ORDER BY name").all() as Array<{ name: string }>).map(row => row.name)
  expect(tables.length).toBeGreaterThan(4)
  return JSON.stringify(tables.map(name => [name, bench.db.db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()]))
}

describe('the production composition', () => {
  test('the timer follows a running execution, and stops once it finishes', async () => {
    const planId = await bench.approvedPlan()
    const executionId = bench.start(planId)
    const { monitor } = bench.compose()
    monitor.start()
    await monitor.idle()
    expect(monitor.timerArmed(world.team.teamId)).toBe(true)
    bench.executions.finishExecution(executionId, 'completed')
    await monitor.idle()
    expect(monitor.timerArmed(world.team.teamId)).toBe(false)
    monitor.stop()
  })

  test('an open fix task alone keeps the timer; closing it stops it', async () => {
    const planId = await bench.approvedPlan()
    const fixId = bench.fixTask(planId)
    const { monitor } = bench.compose()
    monitor.start()
    await monitor.idle()
    expect(monitor.timerArmed(world.team.teamId)).toBe(true)
    await bench.taskService.setStatus(bench.human, fixId, 'cancelled', 'not needed')
    await monitor.idle()
    expect(monitor.timerArmed(world.team.teamId)).toBe(false)
    monitor.stop()
  })

  test('a running promotion alone keeps the timer', async () => {
    const planId = await bench.approvedPlan()
    const promotion = bench.integration.insertPromotion({
      teamId: world.team.teamId, planId, branch: 'integration/wave-c', commandId: 'promote-1', fromSha: 'a', throughSeq: 1, targetBranch: 'master', floor: {},
    })
    const { monitor } = bench.compose()
    monitor.start()
    await monitor.idle()
    expect(monitor.timerArmed(world.team.teamId)).toBe(true)
    bench.integration.finishPromotion(promotion.id, 'cancelled')
    monitor.notify(world.team.teamId)
    await monitor.idle()
    expect(monitor.timerArmed(world.team.teamId)).toBe(false)
    monitor.stop()
  })

  test('a sweep that raises an alert and closes a fix writes no execution row', async () => {
    const planId = await bench.approvedPlan()
    const fixId = bench.fixTask(planId)
    await bench.revise(planId, { changes: [...(await import('../../shared/__tests__/planFixtures')).planInput().changes as Array<Record<string, unknown>>].map(entry => (entry.change === 'api' ? { ...entry, fixes: [fixId] } : entry)) })
    const executionId = bench.start(planId)
    await bench.implementing(executionId, planId, new Date(T0).toISOString(), 'ui')
    bench.land(executionId, planId, 'api', 'merge-api')
    bench.clock.at = T0
    const { monitor } = bench.compose()
    monitor.start()
    await monitor.idle()
    bench.clock.at = T0 + 20 * MIN
    const before = executionRows()
    monitor.notify(world.team.teamId)
    await monitor.idle()
    expect(bench.messagesTagged('plan-stall')).toHaveLength(1)
    expect(bench.tasks.get(fixId)!.status).toBe('done')
    expect(executionRows()).toBe(before)
    monitor.stop()
  })

  test('a named wait restarts the no-progress clock: three hours cooling, resumed 30 minutes ago, is not stalled', async () => {
    const planId = await bench.approvedPlan()
    const executionId = bench.start(planId)
    await bench.implementing(executionId, planId, new Date(T0).toISOString())
    bench.holder.turnRunning = true
    bench.holder.coolingUntil = new Date(T0 + 3 * 60 * MIN).toISOString()
    const { monitor, reads } = bench.compose()
    monitor.start()
    await monitor.idle()
    // Seen cooling until the end of the wait.
    bench.clock.at = T0 + 3 * 60 * MIN - MIN
    monitor.notify(world.team.teamId)
    await monitor.idle()
    expect(monitor.waitEndedAt(executionId, 'api')).toBe(new Date(T0 + 3 * 60 * MIN - MIN).toISOString())
    // The holder resumed; 30 minutes later the 2 h deadline counts from the wait's end.
    bench.holder.coolingUntil = null
    bench.clock.at = T0 + 3 * 60 * MIN + 30 * MIN
    monitor.notify(world.team.teamId)
    await monitor.idle()
    const { readPlanSupervision } = await import('../plans/supervision/supervisionRead')
    const api = () => readPlanSupervision(reads, world.team.teamId, planId, new Date(bench.clock.at)).find(entry => entry.change === 'api')!
    expect(api().outcome).toBe('running')
    expect(bench.messagesTagged('plan-stall')).toHaveLength(0)
    // Past the deadline from the wait's end, it stalls.
    bench.clock.at = T0 + 5 * 60 * MIN
    expect(api().outcome).toBe('stalled')
    monitor.stop()
  })
})

describe('detailViewKey', () => {
  const detail = (computedAt: string, liveAt: string, turnAt = '2026-01-01T00:00:00.000Z') => ({
    decisions: [], usage: null,
    supervision: {
      computedAt,
      changes: [
        { ...change('api', { kind: 'not-started' }), activity: { kind: 'live-turn' as const, at: liveAt } },
        { ...change('ui', { kind: 'not-started' }), activity: { kind: 'turn' as const, at: turnAt } },
      ],
    },
  }) as unknown as PlanSupervisionDetail

  test('two derivations differing only in computedAt and a live turn\'s clock give one key; any other change gives another (8.6)', () => {
    const first = detailViewKey(detail('2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'))
    expect(detailViewKey(detail('2026-01-01T00:01:00.000Z', '2026-01-01T00:01:00.000Z'))).toBe(first)
    expect(detailViewKey(detail('2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:05:00.000Z'))).not.toBe(first)
    expect(detailViewKey(null)).toBeNull()
  })
})
