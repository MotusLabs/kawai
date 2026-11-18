// The holds and pauses a plan's readers list (revision-control 9.2, design
// D14–D15; oracles DV1–DV4 of the design's "Remainder"): `team-plan-detail`
// and `plan_get` carry the holds (DV1) and pauses (DV2) from the one
// revision-control reader, a push follows every hold, pause, and resolve
// write and every Paused recording (DV3), and another team's plan reads as
// not found (DV4). Everything runs through the composed stack — the
// executor's own tick records Paused — over the plan bench.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import type { ClientMessage, ServerMessage } from '../../shared/types'
import { planHandlers } from '../plans/planTools'
import { revisionControlOf } from '../plans/revisionControl/revisionControlServices'
import { PauseStore } from '../plans/revisionControl/pauseStore'
import { createPlanBench, createPlanWorld, writeGroup, type PlanBench, type PlanWorld } from './planHarness'
import { composeStack, inDays, inFlightTarget, settleReceipt, type ComposedStack } from './revisionControlStack'

let world: PlanWorld
let bench: PlanBench
let stack: ComposedStack
let pauseRows: PauseStore

beforeAll(async () => {
  world = await createPlanWorld('kawai-rc-detail-')
  writeGroup(world, 'leads', '---\ncanCreatePlans: true\nmax: 1\n---\nLead.')
  writeGroup(world, 'reviewers', 'Review work.')
  bench = createPlanBench(world)
  stack = await composeStack(world, bench)
  pauseRows = new PauseStore(bench.db.db)
})

afterAll(() => {
  stack.runtime!.stop()
  bench.db.close()
  fs.rmSync(world.root, { recursive: true, force: true })
})

type Detail = Extract<ServerMessage, { type: 'team-plan-detail' }>
type Result = Extract<ServerMessage, { type: 'team-plan-result' }>
const details = () => stack.messages.filter((message): message is Detail => message.type === 'team-plan-detail')
const results = () => stack.messages.filter((message): message is Result => message.type === 'team-plan-result')
const send = (message: ClientMessage) => stack.connections.handle(stack.peer, message)

async function until(probe: () => boolean, tries = 300): Promise<void> {
  for (let attempt = 0; attempt < tries && !probe(); attempt += 1) await new Promise(resolve => setTimeout(resolve, 10))
}

/** Send one command and wait for its result and the detail push that follows it. */
async function pushedAfter(message: ClientMessage & { requestId: string }): Promise<{ result: Result; detail: Detail }> {
  const before = details().length
  await send(message)
  await until(() => results().some(entry => entry.requestId === message.requestId) && details().length > before)
  const result = results().find(entry => entry.requestId === message.requestId)!
  expect(result.error).toBeUndefined()
  expect(details().length).toBeGreaterThan(before)
  return { result, detail: details().at(-1)! }
}

async function open(planId: string): Promise<Detail> {
  stack.messages.length = 0
  await send({ type: 'team-plan-open', teamPath: world.repo, planId })
  await until(() => details().length > 0)
  return details().at(-1)!
}

describe('holds and pauses in team-plan-detail and plan_get (DV)', () => {
  test('DV1 and DV3: holds list scope, changes, rationale, deadline, cite, and release, pushed after each place, release, and extend', async () => {
    const { planId } = await inFlightTarget(world, bench, stack, 'dv1-dev', 'attempt')
    expect((await open(planId)).holds).toEqual([])
    const placed = await pushedAfter({
      type: 'team-plan-hold-place', teamPath: world.repo, requestId: 'dv1-place', planId, scope: 'plan',
      rationale: 'rethink the plan', deadline: inDays(2), commandId: 'dv1-place',
    })
    const holdId = placed.result.hold!.id
    expect(placed.detail.holds).toEqual([placed.result.hold!])
    expect(placed.detail.holds![0]).toMatchObject({ scope: 'plan', rationale: 'rethink the plan', cites: null, releasedAt: null, releaseReason: null, changes: [], releasedChanges: [] })

    const later = inDays(5)
    const extended = await pushedAfter({ type: 'team-plan-hold-extend', teamPath: world.repo, requestId: 'dv1-extend', planId, holdId, deadline: later, commandId: 'dv1-extend' })
    expect(extended.detail.holds!.find(hold => hold.id === holdId)!.deadline).toBe(new Date(later).toISOString())

    // Narrowing: the plan hold releases and a changes hold over `api` takes its place.
    const narrowed = await pushedAfter({ type: 'team-plan-hold-release', teamPath: world.repo, requestId: 'dv1-narrow', planId, holdId, reason: 'only api', retain: ['api'], commandId: 'dv1-narrow' })
    const narrowedId = narrowed.result.narrowed!.id
    expect(narrowed.detail.holds!.find(hold => hold.id === holdId)).toMatchObject({ releaseReason: 'only api', releasedAt: expect.any(String) })
    expect(narrowed.detail.holds!.find(hold => hold.id === narrowedId)).toMatchObject({ scope: 'changes', changes: ['api'], releasedAt: null, rationale: 'rethink the plan' })

    const released = await pushedAfter({ type: 'team-plan-hold-release', teamPath: world.repo, requestId: 'dv1-free', planId, holdId: narrowedId, reason: 'done', changes: ['api'], commandId: 'dv1-free' })
    expect(released.detail.holds!.find(hold => hold.id === narrowedId)).toMatchObject({ changes: [], releasedChanges: ['api'], releaseReason: 'done', releasedAt: expect.any(String) })

    // plan_get lists the same holds the detail pushed (one reader).
    const agent = await planHandlers(stack.plans, 'lead').plan_get({ plan_id: planId }) as { holds: unknown }
    expect(agent.holds).toEqual(released.detail.holds)
  })

  test('DV2 and DV3: pauses list deadline and targets with state, causes, holder, checkpoints, and decision, pushed after the pause, the Paused recording, and the resolve', async () => {
    const holder = 'dv2-dev'
    const { planId } = await inFlightTarget(world, bench, stack, holder, 'review')
    await open(planId)
    const placed = await pushedAfter({ type: 'team-plan-hold-place', teamPath: world.repo, requestId: 'dv2-hold', planId, scope: 'changes', changes: ['api'], rationale: 'look again', deadline: inDays(2), commandId: 'dv2-hold' })
    const deadline = inDays(1)
    const paused = await pushedAfter({ type: 'team-plan-pause', teamPath: world.repo, requestId: 'dv2-pause', planId, holdId: placed.result.hold!.id, deadline, commandId: 'dv2-pause' })
    const pauseId = paused.result.pause!.id
    const pause = paused.detail.pauses!.find(entry => entry.id === pauseId)!
    expect(pause).toMatchObject({ holdId: placed.result.hold!.id, deadline: new Date(deadline).toISOString(), closedAt: null, deadlinePassed: false, noActiveWork: [], landingInProgress: [] })
    expect(pause.targets).toHaveLength(1)
    const pausing = pause.targets[0]!
    expect(pausing).toMatchObject({ change: 'api', stage: 'review', holderSession: holder, withdrawn: false, pausedAt: null, decision: null, checkpoint: null, checkpoints: [] })
    expect(pausing.state).toMatchObject({ state: 'pausing' })
    expect((pausing.state as { causes: Array<{ kind: string }> }).causes.map(cause => cause.kind)).toContain('awaiting-delivery')

    // The holder reads the pause mail; the executor's tick records Paused and pushes (DV3).
    const before = details().length
    settleReceipt(bench, pauseRows.target(pauseId, 'api')!.messageId!, holder)
    stack.runtime!.command(world.team.teamId)
    await stack.runtime!.idle()
    await until(() => details().length > before)
    expect(pauseRows.target(pauseId, 'api')!.pausedAt).not.toBeNull()
    const recorded = details().at(-1)!.pauses!.find(entry => entry.id === pauseId)!.targets[0]!
    expect(recorded).toMatchObject({ state: { state: 'paused' }, pausedAt: pauseRows.target(pauseId, 'api')!.pausedAt })

    const resolved = await pushedAfter({ type: 'team-plan-pause-resolve', teamPath: world.repo, requestId: 'dv2-resolve', planId, pauseId, change: 'api', choice: 'continue', commandId: 'dv2-resolve' })
    expect(resolved.result.resolution).toMatchObject({ change: 'api', decision: 'continue' })
    const decided = resolved.detail.pauses!.find(entry => entry.id === pauseId)!
    expect(decided.targets[0]).toMatchObject({ decision: 'continue', decidedAt: expect.any(String), state: { state: 'decided', decision: 'continue' } })
    expect(decided.closedAt).not.toBeNull()

    const agent = await planHandlers(stack.plans, 'lead').plan_get({ plan_id: planId }) as { pauses: unknown }
    expect(agent.pauses).toEqual(resolved.detail.pauses)
  })

  test('DV3: a tick that records nothing pushes nothing', async () => {
    const holder = 'dv3-dev'
    const { planId } = await inFlightTarget(world, bench, stack, holder, 'review')
    await open(planId)
    const placed = await pushedAfter({ type: 'team-plan-hold-place', teamPath: world.repo, requestId: 'dv3-hold', planId, scope: 'changes', changes: ['api'], rationale: 'look again', deadline: inDays(2), commandId: 'dv3-hold' })
    await pushedAfter({ type: 'team-plan-pause', teamPath: world.repo, requestId: 'dv3-pause', planId, holdId: placed.result.hold!.id, deadline: inDays(1), commandId: 'dv3-pause' })
    await until(() => false, 20)
    const before = details().length
    // The pause mail is undelivered: the target stays Pausing, nothing is recorded.
    stack.runtime!.command(world.team.teamId)
    await stack.runtime!.idle()
    await until(() => false, 20)
    expect(details().length).toBe(before)
  })

  test("DV4: another team's plan reads as not found in plan_get and the detail, and its holds never reach another team's reader", async () => {
    const { planId } = await inFlightTarget(world, bench, stack, 'dv4-dev', 'attempt')
    stack.messages.length = 0
    await send({ type: 'team-plan-hold-place', teamPath: world.repo, requestId: 'dv4-hold', planId, scope: 'plan', rationale: 'mine', deadline: inDays(2), commandId: 'dv4-hold' })
    await until(() => results().some(entry => entry.requestId === 'dv4-hold'))
    expect(results().find(entry => entry.requestId === 'dv4-hold')!.hold).toBeDefined()

    await expect(planHandlers(stack.plans, 'stranger').plan_get({ plan_id: planId })).rejects.toThrow(`Plan not found in this team: ${planId}`)
    stack.messages.length = 0
    await send({ type: 'team-plan-open', teamPath: world.other, planId })
    await until(() => stack.messages.length > 0)
    expect(stack.messages).toEqual([{ type: 'error', message: `Plan not found in this team: ${planId}` }])
    // A command from the other team is refused not found and writes nothing.
    await send({ type: 'team-plan-hold-place', teamPath: world.other, requestId: 'dv4-foreign', planId, scope: 'plan', rationale: 'theirs', deadline: inDays(2), commandId: 'dv4-foreign' })
    await until(() => results().some(entry => entry.requestId === 'dv4-foreign'))
    expect(results().find(entry => entry.requestId === 'dv4-foreign')).toMatchObject({ reason: 'not-found', error: expect.stringContaining('not found in this team') })
    // The reader is team-scoped: another team's id reads no hold of this plan.
    const reader = revisionControlOf(stack.plans)!
    expect(reader.read(world.team.teamId, planId).holds.map(hold => hold.rationale)).toEqual(['mine'])
    expect(reader.read(world.otherTeam.teamId, planId)).toEqual({ holds: [], pauses: [] })
  })
})
