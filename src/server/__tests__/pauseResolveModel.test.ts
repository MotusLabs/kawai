// The resolve command's model-based suite (revision-control 4.4, P-I1):
// seeded random command sequences over fresh paused attempt targets — the
// idempotent replay, the refusals after the decision, and the invariants
// that hold after every command (one event, one decision, one resume or
// notice, the attempt delta, no second publication, the pause closed).
// Seed 20261022 drives the `continue` cases, seed 20261023 the `adapt`
// ones; the follow-up vocabulary grows with each resolve step (restart
// adds its choices here).
import { afterAll, beforeAll, expect, test } from 'bun:test'
import type { PlanRefusalReason } from '../plans/planCommands'
import { REVISION_NOTICE_TAG } from '../team/taskNotices'
import { pauseResolveBench, targetOf, type PauseResolveBench } from './pauseResolveBench'
import type { PauseResolveOutcome, ResolveRefusalCode } from '../plans/revisionControl/pauseResolve'

let wired: PauseResolveBench

beforeAll(async () => {
  wired = await pauseResolveBench('pause-resolve-model')
})

afterAll(() => {
  wired.close()
})

/** mulberry32: a tiny seeded PRNG, called strictly sequentially (never from two threads). */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type Variant = 'plain answered' | 'owed after mint' | 'rev-pending'
const VARIANTS: Variant[] = ['plain answered', 'owed after mint', 'rev-pending']

/** One fresh paused attempt target in a seeded variant; returns the ids every command needs. */
async function pausedTarget(rand: () => number): Promise<{ planId: string; executionId: string; taskId: string; pauseId: string }> {
  const variant = VARIANTS[Math.floor(rand() * VARIANTS.length)]
  const { planId, executionId } = await wired.executionWith(['api'])
  const flight = await wired.inFlight(executionId, 'api')
  const hold = wired.placeHold(planId, ['api'], `hold-${planId}`)
  const pause = wired.expectOk(wired.pause({ planId, holdId: hold.id, commandId: `pause-${planId}` })).pause
  wired.toPaused(pause.id, 'api')
  if (variant === 'plain answered') wired.answerNewestRow(executionId, 'api', 1)
  if (variant === 'rev-pending') {
    wired.answerNewestRow(executionId, 'api', 1)
    wired.republish(flight.taskId)
  }
  if (variant === 'owed after mint') wired.mintOwed(executionId, 'api', 'fix')
  return { planId, executionId, taskId: flight.taskId, pauseId: pause.id }
}

/** The observable state the invariants are read from, after any command. */
function counts(planId: string, executionId: string, taskId: string, pauseId: string): {
  events: number; resumes: number; notices: number; attempts: number
  roundOutcomes: Array<string | null>; decided: string | null; closed: string | null
} {
  return {
    events: wired.resolvedEvents(planId).length,
    resumes: wired.resumeMails(taskId).length,
    notices: wired.bench.mail.forTask(taskId).filter(message => message.tags.includes(REVISION_NOTICE_TAG)).length,
    attempts: wired.executions.attempts(executionId, 'api').length,
    roundOutcomes: wired.executions.rounds(executionId, 'api').map(round => round.outcome),
    decided: targetOf(wired, pauseId, 'api').decision,
    closed: wired.pauses.get(wired.teamId, pauseId)!.closedAt,
  }
}

function expectFreshAccept(outcome: PauseResolveOutcome): void {
  expect(outcome.ok).toBe(true)
  if (outcome.ok) expect(outcome.replayed).toBe(false)
}

function expectReplay(outcome: PauseResolveOutcome): void {
  expect(outcome.ok).toBe(true)
  if (outcome.ok) expect(outcome.replayed).toBe(true)
}

function expectRefusal(outcome: PauseResolveOutcome, reason: PlanRefusalReason | ResolveRefusalCode): void {
  expect(outcome.ok).toBe(false)
  if (!outcome.ok) expect(outcome.reason).toBe(reason)
}

// L2 (lead ruling): every P-I1 test carries an explicit 60 s per-test
// timeout — the runner's default 20 s cut one loaded run at 20.54 s. The
// budget is for parallel-load jitter, not license to grow: a test passing
// 15 s idle must split its cases rather than raise this.
test('P-I1: 40 seeded cases — the replay replays, later commands refuse or replay, one decision and one resume hold', async () => {
  const rand = mulberry32(20261022)
  const FOLLOW_UPS = ['replay', 'fresh id', 'mutated rationale', 'adapt'] as const
  for (let index = 0; index < 40; index += 1) {
    const world = await pausedTarget(rand)
    const commandId = `model-${index}`
    const payload = {
      planId: world.planId, pauseId: world.pauseId, change: 'api' as const, choice: 'continue' as const,
      rationale: 'rethink', releaseHold: false, commandId,
    }
    const baseline = counts(world.planId, world.executionId, world.taskId, world.pauseId)
    expect(baseline.attempts).toBeGreaterThan(0)
    expectFreshAccept(await wired.resolve(payload))
    // The same command and payload replays without running again (K5's surrogate).
    expectReplay(await wired.resolve({ ...payload }))
    expect(counts(world.planId, world.executionId, world.taskId, world.pauseId)).toMatchObject({
      events: 1, resumes: 1, attempts: baseline.attempts, decided: 'continue',
    })
    const followUps = 1 + Math.floor(rand() * 3)
    for (let step = 0; step < followUps; step += 1) {
      const kind = FOLLOW_UPS[Math.floor(rand() * FOLLOW_UPS.length)]
      if (kind === 'replay') expectReplay(await wired.resolve({ ...payload }))
      else if (kind === 'fresh id') expectRefusal(await wired.resolve({ ...payload, commandId: `${commandId}-x${step}` }), 'state')
      else if (kind === 'mutated rationale') expectRefusal(await wired.resolve({ ...payload, rationale: 'changed while replaying' }), 'payload')
      else expectRefusal(await wired.resolve({ ...payload, choice: 'adapt', commandId: `${commandId}-a${step}` }), 'state')
      // The invariants after every command: exactly one event, one resume,
      // no minted attempt row, the one standing decision.
      expect(counts(world.planId, world.executionId, world.taskId, world.pauseId)).toMatchObject({
        events: 1, resumes: 1, attempts: baseline.attempts, decided: 'continue',
      })
    }
    // One target, all decided: the pause closed.
    expect(counts(world.planId, world.executionId, world.taskId, world.pauseId).closed).not.toBeNull()
  }
}, 60000)

// The adapt twin (N3): same shape, choice `adapt`, seed 20261023. The
// invariants after a fresh accept are adapt's own — one new fix attempt,
// no plan-resume, exactly one revision notice, the passable round
// superseded (the ROUND RULE always fires for adapt) — and the replay and
// post-decision refusals hold as for continue.
test('P-I1 adapt: 40 seeded cases — the publication lands once, the round supersedes, the replay replays', async () => {
  const rand = mulberry32(20261023)
  const FOLLOW_UPS = ['replay', 'fresh id', 'mutated rationale', 'adapt'] as const
  for (let index = 0; index < 40; index += 1) {
    const world = await pausedTarget(rand)
    const commandId = `model-adapt-${index}`
    const payload = {
      planId: world.planId, pauseId: world.pauseId, change: 'api' as const, choice: 'adapt' as const,
      adapt: `Rebuilt direction ${index}`, rationale: 'the lead rethought it', releaseHold: false, commandId,
    }
    const baseline = counts(world.planId, world.executionId, world.taskId, world.pauseId)
    expect(baseline.attempts).toBeGreaterThan(0)
    expectFreshAccept(await wired.resolve(payload))
    const after = counts(world.planId, world.executionId, world.taskId, world.pauseId)
    // ONE new fix attempt, no resume, one notice, one event, the decision.
    expect(after).toMatchObject({
      events: 1, resumes: 0, notices: 1, attempts: baseline.attempts + 1, decided: 'adapt',
    })
    // N3: the round outcomes are observed — every passable round superseded
    // (the owed-after-mint variant has no round to supersede).
    if (baseline.roundOutcomes.length > 0) expect(after.roundOutcomes).toEqual(['superseded'])
    // The same command and payload replays without a second publication.
    expectReplay(await wired.resolve({ ...payload }))
    expect(counts(world.planId, world.executionId, world.taskId, world.pauseId)).toMatchObject({
      events: 1, resumes: 0, notices: 1, attempts: baseline.attempts + 1, decided: 'adapt',
    })
    const followUps = 1 + Math.floor(rand() * 3)
    for (let step = 0; step < followUps; step += 1) {
      const kind = FOLLOW_UPS[Math.floor(rand() * FOLLOW_UPS.length)]
      if (kind === 'replay') expectReplay(await wired.resolve({ ...payload }))
      else if (kind === 'fresh id') expectRefusal(await wired.resolve({ ...payload, commandId: `${commandId}-x${step}` }), 'state')
      else if (kind === 'mutated rationale') expectRefusal(await wired.resolve({ ...payload, rationale: 'changed while replaying' }), 'payload')
      else expectRefusal(await wired.resolve({ ...payload, choice: 'continue', commandId: `${commandId}-c${step}` }), 'state')
      expect(counts(world.planId, world.executionId, world.taskId, world.pauseId)).toMatchObject({
        events: 1, resumes: 0, notices: 1, attempts: baseline.attempts + 1, decided: 'adapt',
      })
    }
    expect(counts(world.planId, world.executionId, world.taskId, world.pauseId).closed).not.toBeNull()
  }
}, 60000)
