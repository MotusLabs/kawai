// Supervision's revision-control causes (revision-control 9.3, design D13;
// oracles CA1–CA6 of the design's "Remainder"): `paused`, `pausing`, and
// `hold` join the running-stage named waits right after `effect`, in that
// order and before `uncertain-delivery`; `repeating-failure` keeps its place
// ahead of every named wait; none raises a `no-progress` stall. The rows run
// over the pure `changeSupervision`, and CA3 also through the real
// SupervisionMonitor the composition builds (no stall alert for a held
// change whose instruction was delivered long ago).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import type { CiCheck } from '../../shared/planExecution'
import { causeLabel, changeSupervision, type SupervisionInput, type SupervisionRound, type SupervisionWait } from '../../shared/planSupervision'
import { createPlanBench, createPlanWorld, writeGroup, type PlanBench, type PlanWorld } from './planHarness'
import { composeStack, inDays, inFlightTarget, type ComposedStack } from './revisionControlStack'

const NOW = new Date('2026-11-18T12:00:00.000Z')
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString()
const DEADLINE = '2026-11-20T12:00:00.000Z'

const round = (number: number, extra: Partial<SupervisionRound> = {}): SupervisionRound => ({
  id: `round-${number}`, number, outcome: null, decidedAt: null, carriedFrom: null, ci: null,
  ciPassedAt: null, verdict: null, verdictAt: null, findingsSummary: null, structuredReview: false, ...extra,
})
const check = (name: string, conclusion: string): CiCheck =>
  ({ name, source: 'actions', conclusion, link: `https://ci.example/${name}`, runId: 1, startedAt: ago(300), completedAt: ago(300) })

/** An implementing change whose instruction was delivered five hours ago: with no named wait it would stall `no-progress`. */
function input(extra: Partial<SupervisionInput> = {}): SupervisionInput {
  return {
    change: 'api', dependsOn: [], state: 'implementing', step: null, stopReason: null, stopDetail: null,
    landing: null, dependencies: [], parallelLimit: 3, attempt: { kind: 'implement', status: 'out' }, rounds: [], effects: [],
    instruction: { messageId: 'msg-1', state: 'delivered', deliveredAt: ago(300), blocker: null, holder: null },
    openCards: [], conditions: [], memberRelease: null, slotHolder: null, candidates: [], results: [], waitEndedAt: null, diagnosis: null,
    ...extra,
  }
}

const HOLD: SupervisionWait = { kind: 'hold', holds: [{ id: 'hold-1', scope: 'changes', deadline: DEADLINE }] }
const PAUSED: SupervisionWait = { kind: 'paused', pauseId: 'pause-1', awaiting: 'decision' }
const PAUSING: SupervisionWait = { kind: 'pausing', pauseId: 'pause-1', causes: [{ kind: 'no-checkpoint' }] }
const EFFECT: SupervisionWait = { kind: 'effect', effect: 'push-checkpoint', state: 'running', tries: 1, nextAt: null }
const UNCERTAIN: SupervisionWait = { kind: 'uncertain-delivery', messageId: 'msg-1' }
const holds = [{ id: 'hold-1', scope: 'changes' as const, deadline: DEADLINE }]
const failedRound = (number: number) => round(number, { outcome: 'fail', decidedAt: ago(400 - number), ci: [check('unit', 'failure')] })

// CA1–CA6, verbatim: the waits present, then the cause and the also-applying list.
const ROWS: Array<{ id: string; waits: string; extra: Partial<SupervisionInput>; cause: SupervisionWait | { kind: 'stall'; stall: string }; also: SupervisionWait[] }> = [
  { id: 'CA1', waits: 'paused', extra: { pause: { pauseId: 'pause-1', state: 'paused' } }, cause: PAUSED, also: [] },
  { id: 'CA2', waits: 'pausing', extra: { pause: { pauseId: 'pause-1', state: 'pausing', causes: [{ kind: 'no-checkpoint' }] } }, cause: PAUSING, also: [] },
  {
    id: 'CA3', waits: 'hold (CI passed, review waiting for the release)',
    extra: { state: 'gating', step: null, rounds: [round(1, { ci: [check('unit', 'success')], ciPassedAt: ago(200) })], holds },
    cause: HOLD, also: [],
  },
  { id: 'CA4', waits: 'effect, hold', extra: { effects: [{ kind: 'push-checkpoint', state: 'running', tries: 1, nextAt: null }], holds }, cause: EFFECT, also: [HOLD] },
  { id: 'CA5', waits: 'hold, uncertain-delivery', extra: { holds, instruction: { messageId: 'msg-1', state: 'uncertain', deliveredAt: ago(300), blocker: null, holder: null } }, cause: HOLD, also: [UNCERTAIN] },
  { id: 'CA6', waits: 'repeating-failure outcome, hold', extra: { holds, rounds: [failedRound(1), failedRound(2)] }, cause: { kind: 'stall', stall: 'repeating-failure' }, also: [HOLD] },
]

describe('supervision causes paused, pausing, and hold (CA)', () => {
  const caRow = (id: string) => {
    const { extra, cause, also } = ROWS.find(row => row.id === id)!
    const view = changeSupervision(input(extra), NOW)
    expect(view.cause).toEqual(cause as never)
    expect(view.alsoApplying).toEqual(also)
    // None of the three raises a `no-progress` stall.
    expect(view.stall?.kind).not.toBe('no-progress')
  }
  // @covers: plan-pause › Pauses are visible to the owner and agents › A paused change's cause
  test('CA1: waits paused read the cause and the also-applying list', () => caRow('CA1'))
  test('CA2: waits pausing read the cause and the also-applying list', () => caRow('CA2'))
  // @covers: plan-holds › Holds are visible to the owner and agents › A held change's cause
  test('CA3: waits hold (CI passed, review waiting for the release) read the cause and the also-applying list', () => caRow('CA3'))
  test('CA4: waits effect, hold read the cause and the also-applying list', () => caRow('CA4'))
  test('CA5: waits hold, uncertain-delivery read the cause and the also-applying list', () => caRow('CA5'))
  test('CA6: waits repeating-failure outcome, hold read the cause and the also-applying list', () => caRow('CA6'))

  test('the order rule: effect, paused, pausing, hold, uncertain-delivery, then the shipped waits', () => {
    const view = changeSupervision(input({
      effects: [{ kind: 'push-checkpoint', state: 'running', tries: 1, nextAt: null }],
      pause: { pauseId: 'pause-1', state: 'pausing', causes: [{ kind: 'no-checkpoint' }] }, holds,
      instruction: { messageId: 'msg-1', state: 'uncertain', deliveredAt: ago(300), blocker: null, holder: null },
      openCards: [{ cardId: 'card-1', addressedTo: 'owner', addressedGroup: null }],
    }), NOW)
    expect([view.cause, ...view.alsoApplying].map(wait => wait.kind)).toEqual(['effect', 'pausing', 'hold', 'uncertain-delivery', 'decision-card'])
  })

  test('without a revision-control wait the same change stalls no-progress (the rows above are not vacuous)', () => {
    expect(changeSupervision(input(), NOW).stall?.kind).toBe('no-progress')
  })

  test('a waiting change before provisioning keeps its shipped cause beside a hold', () => {
    const view = changeSupervision(input({ state: 'waiting', instruction: null, holds }), NOW)
    expect(view.cause).toEqual({ kind: 'parallel-limit', limit: 3 })
  })

  test('each cause has a label naming its pause, causes, or holds', () => {
    expect(causeLabel(PAUSED)).toBe("Paused (pause-1): waiting for the owner's decision")
    expect(causeLabel(PAUSING)).toBe('Pausing (pause-1): no-checkpoint')
    expect(causeLabel(HOLD)).toBe(`Held by hold-1 (changes, review by ${DEADLINE})`)
  })
})

describe('CA3 through the real SupervisionMonitor', () => {
  let world: PlanWorld
  let bench: PlanBench
  let stack: ComposedStack
  // The monitor's clock: real time at start (its startup seeds every running
  // change's wait time), then three hours on before each sweep — past the
  // attempt's two-hour no-progress bound for an instruction delivered now.
  let clock = Date.now()

  beforeAll(async () => {
    world = await createPlanWorld('kawai-rc-supervision-')
    writeGroup(world, 'leads', '---\ncanCreatePlans: true\nmax: 1\n---\nLead.')
    writeGroup(world, 'reviewers', 'Review work.')
    bench = createPlanBench(world)
    stack = await composeStack(world, bench, { monitor: { now: () => new Date(clock), debounceMs: 0, log: () => {} } })
    stack.monitor!.start()
  })

  afterAll(() => {
    stack.monitor?.stop()
    stack.runtime!.stop()
    bench.db.close()
    fs.rmSync(world.root, { recursive: true, force: true })
  })

  const stallAlerts = (planId: string) =>
    (bench.db.db.prepare("SELECT kind FROM plan_stall_alerts WHERE plan_id = ?").all(planId) as Array<{ kind: string }>).map(row => row.kind)

  async function sweep(): Promise<void> {
    const monitor = stack.monitor!
    clock = Date.now() + 3 * 60 * 60 * 1000
    monitor.notify(world.team.teamId)
    await new Promise(resolve => setTimeout(resolve, 20))
    await monitor.idle()
  }

  test('without a hold the same long-delivered change raises a no-progress stall alert through the monitor (the control)', async () => {
    const { planId } = await inFlightTarget(world, bench, stack, 'ca3-control', 'attempt')
    await sweep()
    expect(stallAlerts(planId)).toEqual(['no-progress'])
  })

  // @covers: plan-holds › Holds are visible to the owner and agents › A held change's cause
  test('CA3: a held change with a long-delivered instruction reads hold through the monitor and raises no no-progress stall alert', async () => {
    const { planId } = await inFlightTarget(world, bench, stack, 'ca3-dev', 'attempt')
    const placed = stack.holds.place(bench.human, { planId, scope: 'changes', changes: ['api'], rationale: 'look again', deadline: inDays(2), commandId: 'ca3-hold' })
    if (!placed.ok) throw new Error(placed.message)
    await sweep()
    expect(stallAlerts(planId)).toEqual([])
    const detail = stack.plans.detailWithExecutions(planId)
    const api = detail.supervision!.changes.find(change => change.change === 'api')!
    expect(api.cause).toEqual({ kind: 'hold', holds: [{ id: placed.result!.hold.id, scope: 'changes', deadline: placed.result!.hold.deadline }] })
    expect(api.stall).toBeNull()
  })
})
