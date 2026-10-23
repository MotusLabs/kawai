// The resolve's releaseHold overlay (revision-control 4.4, design "Under a
// standing hold", H1r-H4r; Q-A4): the pause's own hold (`pause.holdId`)
// releases with the resolution under `<commandId>:release-hold`, written in
// the resolve's own transaction — so a refusing resolution (Q-A4) or a
// failing choice after the release rolls the release back; a whole-plan hold
// refuses with the narrowing guidance (H2r), an already-released one refuses
// (H3r), and other covering holds stay and are named (H4r).
import { expect, test } from 'bun:test'
import { pauseResolveBench, targetOf } from './pauseResolveBench'

const wired = await pauseResolveBench('pause-resolve-release')

let sequence = 0

function ok<T>(outcome: { ok: boolean; result?: T; message?: string }): T {
  if (!outcome.ok || outcome.result === undefined) throw new Error(outcome.ok ? 'the command wrote nothing' : (outcome.message ?? 'refused'))
  return outcome.result
}

function refusal(outcome: { ok: boolean; reason?: string; message?: string }, code: string, fragment?: string): void {
  expect(outcome.ok).toBe(false)
  expect(outcome.reason).toBe(code)
  if (fragment !== undefined) expect(outcome.message).toContain(fragment)
}

/** The plan's `hold-released` events, oldest first. */
const holdReleasedEvents = (planId: string): Array<Record<string, unknown>> =>
  wired.bench.db.db.prepare("SELECT payload_json FROM plan_events WHERE plan_id = ? AND kind = 'hold-released' ORDER BY rowid").all(planId) as Array<Record<string, unknown>>

/** The pause's own still-active hold id. */
const pauseHold = (planId: string): string => {
  const hold = wired.holds.forPlan(wired.teamId, planId).find(candidate => candidate.releasedAt === null)
  if (hold === undefined) throw new Error('the pause hold is gone')
  return hold.id
}

// H1r: an accepted resolution with releaseHold writes the `hold-released`
// event under `<commandId>:release-hold` in the resolve's own transaction and
// the result names the released hold; a replayed resolve writes nothing more.
test('H1r: the resolution releases the pause hold under its own command id; a replay writes nothing', async () => {
  const world = await wired.pausedAttempt()
  const holdId = pauseHold(world.planId)
  const outcome = await wired.resolve({ planId: world.planId, pauseId: world.pauseId, change: 'api', choice: 'continue', releaseHold: true, commandId: 'resolve-rel-1' })
  const result = ok(outcome)
  expect(result.releaseHold).toMatchObject({ holdId, stillCovering: [] })
  const event = wired.bench.plans.eventByCommand(world.planId, 'resolve-rel-1:release-hold')
  expect(event?.event.kind).toBe('hold-released')
  expect(event?.payload).toMatchObject({ holdId, changes: ['api'], retain: [] })
  expect(wired.holds.get(wired.teamId, holdId)?.releasedAt).not.toBeNull()
  // The choice ran too: one resume mail on the holder's task.
  expect(wired.resumeMails(world.taskId)).toHaveLength(1)
  // The replay short-circuits before `within`: no second event, the hold stays released.
  const replay = await wired.resolve({ planId: world.planId, pauseId: world.pauseId, change: 'api', choice: 'continue', releaseHold: true, commandId: 'resolve-rel-1' })
  expect(replay.ok).toBe(true)
  if (replay.ok) expect(replay.replayed).toBe(true)
  expect(holdReleasedEvents(world.planId)).toHaveLength(1)
})

// Q-A4: a refusing resolution releases nothing — C10 fires before the
// overlay and the whole command writes nothing.
test('Q-A4: C10 with releaseHold refuses as C10; the hold stays and nothing is written', async () => {
  const world = await wired.pausing()
  const holdId = pauseHold(world.planId)
  const outcome = await wired.resolve({ planId: world.planId, pauseId: world.pauseId, change: 'api', choice: 'continue', releaseHold: true })
  refusal(outcome, 'not-paused')
  expect(wired.holds.get(wired.teamId, holdId)?.releasedAt).toBeNull()
  expect(holdReleasedEvents(world.planId)).toHaveLength(0)
  expect(targetOf(wired, world.pauseId, 'api').decision).toBeNull()
})

// One transaction: the release lands before the choice dispatch, so a
// choice-side refusal after it — here the adapt head read (K7) — rolls the
// release back with the rest.
test('a failing choice after the release rolls the release back (nothing written)', async () => {
  const world = await wired.pausedAttempt()
  const holdId = pauseHold(world.planId)
  wired.useAdaptHead(() => Promise.resolve({ ok: false as const }))
  try {
    const outcome = await wired.resolve({ planId: world.planId, pauseId: world.pauseId, change: 'api', choice: 'adapt', adapt: 'Rework it', releaseHold: true })
    refusal(outcome, 'head-unreadable')
    expect(wired.holds.get(wired.teamId, holdId)?.releasedAt).toBeNull()
    expect(holdReleasedEvents(world.planId)).toHaveLength(0)
    expect(targetOf(wired, world.pauseId, 'api').decision).toBeNull()
  } finally {
    wired.useAdaptHead(() => Promise.resolve({ ok: true as const, startCommit: 'adapt-head-sha', artifacts: {} }))
  }
})

// H2r: a whole-plan hold cannot release with a resolution — the refusal
// names the narrowing guidance; the same resolution without the flag is
// accepted, so H2r refuses only the release.
test('H2r: a whole-plan hold refuses the release with the narrowing guidance; the plain resolve succeeds', async () => {
  const { planId, executionId } = await wired.executionWith(['api'])
  await wired.inFlight(executionId, 'api')
  const hold = wired.holds.insert({ teamId: wired.teamId, planId, scope: 'plan', rationale: 'rethink the direction', deadline: wired.inDays(10), cites: null, commandId: `hold-plan-${++sequence}`, changes: [] })
  const pause = ok(wired.pause({ planId, holdId: hold.id, commandId: `pause-${++sequence}` })).pause
  wired.toPaused(pause.id, 'api')
  const outcome = await wired.resolve({ planId, pauseId: pause.id, change: 'api', choice: 'continue', releaseHold: true })
  refusal(outcome, 'whole-plan-hold', 'narrow the hold to its changes first')
  expect(wired.holds.get(wired.teamId, hold.id)?.releasedAt).toBeNull()
  expect(holdReleasedEvents(planId)).toHaveLength(0)
  ok(await wired.resolve({ planId, pauseId: pause.id, change: 'api', choice: 'continue' }))
})

// H3r: the hold released standalone before the resolve — releasing a hold
// never resolves a pause, so the resolution has nothing left to release and
// refuses; the plain resolution still succeeds.
test('H3r: an already-released hold refuses the release; the plain resolution still succeeds', async () => {
  const world = await wired.pausedAttempt()
  const holdId = pauseHold(world.planId)
  const released = wired.holds.release({ teamId: wired.teamId, holdId, changes: ['api'], reason: 'released by hand', commandId: `release-${++sequence}` })
  expect(released.written).toBe(true)
  // The store-level release writes no plan event (the event is the service
  // layer's); the refusal must leave the count where the release left it.
  const before = holdReleasedEvents(world.planId).length
  const outcome = await wired.resolve({ planId: world.planId, pauseId: world.pauseId, change: 'api', choice: 'continue', releaseHold: true })
  refusal(outcome, 'hold-already-released')
  expect(holdReleasedEvents(world.planId)).toHaveLength(before)
  ok(await wired.resolve({ planId: world.planId, pauseId: world.pauseId, change: 'api', choice: 'continue' }))
})

// H4r: other active holds covering the change stay — the result names them
// (a changes-scoped one and a plan-scoped one alike) and they keep gating
// the change.
test('H4r: other covering holds stay and are named in the result', async () => {
  const world = await wired.pausedAttempt()
  const second = wired.placeHold(world.planId, ['api'], `hold-second-${++sequence}`)
  const third = wired.holds.insert({ teamId: wired.teamId, planId: world.planId, scope: 'plan', rationale: 'wider rethink', deadline: wired.inDays(5), cites: null, commandId: `hold-third-${++sequence}`, changes: [] })
  const outcome = await wired.resolve({ planId: world.planId, pauseId: world.pauseId, change: 'api', choice: 'continue', releaseHold: true })
  const result = ok(outcome)
  expect(result.releaseHold?.stillCovering).toEqual([second.id, third.id].sort())
  expect(wired.holds.get(wired.teamId, second.id)?.releasedAt).toBeNull()
  expect(wired.holds.get(wired.teamId, third.id)?.releasedAt).toBeNull()
  expect(holdReleasedEvents(world.planId)).toHaveLength(1)
})

// H1r's dispatch ordering: the release lands BEFORE the choice's gate read,
// so the choice dispatches inline through the opened gate — the same state
// B4 kept owed now dispatches inside the resolve's own transaction.
test('H1r: with the release in the resolve the new fix row dispatches inline through the opened gate', async () => {
  const world = await wired.pausedAttempt()
  const row = wired.executions.change(world.executionId, 'api')!
  expect(wired.executions.transition(world.executionId, 'api', row, { baselineCommit: 'base' })).not.toBeNull()
  const outcome = await wired.resolve({ planId: world.planId, pauseId: world.pauseId, change: 'api', choice: 'adapt', adapt: 'Build it wider', releaseHold: true })
  const result = ok(outcome)
  expect(result.releaseHold?.stillCovering).toEqual([])
  const attempts = wired.executions.attempts(world.executionId, 'api')
  expect(attempts).toHaveLength(2)
  expect(attempts[1].kind).toBe('fix')
  expect(attempts[1].assignmentId).not.toBeNull()
  expect(holdReleasedEvents(world.planId)).toHaveLength(1)
})
