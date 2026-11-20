// codex-capacity-retry tables O (option) and C (classification), committed
// verbatim (design "Acceptance oracles", task 1.1), over the real package
// session and a scripted app-server with onLimitEvent and onActivity
// subscribed. Named mutants: unconditional suppression and recovery when
// omitted fail O1-O4/O8; suppression leaking into quota kinds fails O7;
// overload limit events under 'bounded' fail C1-C2/O5-O6; disabled real quota
// signals or a changed scope/reset fail C3-C4; text-based matching fails C5;
// 'bounded' suppression without recovery fails O6.
import { afterEach, describe, expect, test } from 'bun:test'
import { codexLimitScope } from '../src/usage/limits.js'
import { frames, type Scripted } from './helpers/scriptedCodex.js'
import { EXHAUSTED_SNAPSHOT, OPEN_SNAPSHOT, failAttempt, limitFailures, opened, recovery, scripted, snapshot, stopScripted } from './helpers/capacitySteps.js'

afterEach(stopScripted)

export const OPTION_TABLE = [
  ['O1', 'omitted', '`serverOverloaded` upstream retry (`willRetry`)', "Today's non-final login-scoped limit event and provider retry activity; no capacity state"],
  ['O2', 'omitted', '`serverOverloaded` terminal failed attempt', "Today's final login-scoped limit event; the turn ends with its error; no continuation, no `capacity_retry` event, no new activity fields"],
  ['O3', "`'off'`", 'upstream retry', 'As O1'],
  ['O4', "`'off'`", 'terminal failed attempt', 'As O2'],
  ['O5', "`'bounded'`", 'upstream retry', 'No limit event; provider-owned retry activity only if `willRetry` (L7); no capacity attempt (C1)'],
  ['O6', "`'bounded'`", 'terminal failed attempt', 'No limit event; capacity recovery per L2–L4 (C2)'],
  ['O7', 'any', 'usage, rate, or session-budget kind', 'Identical events, scopes, and resets in all modes (C3–C4)'],
  ['O8', 'an unrecognized string', 'either source', 'As O3–O4'],
] as const

export const CLASSIFICATION_TABLE = [
  ['C1', 'serverOverloaded', 'upstream retry', '*', 'No Kawai attempt dispatched; no quota event or cooldown'],
  ['C2', 'serverOverloaded', 'terminal failed attempt', '*', 'Capacity recovery considered; no quota event or cooldown'],
  ['C3', 'usageLimitExceeded or rateLimitExceeded', '*', '*', 'Existing final/non-final and exhausted-reset rules apply with shared-home scope'],
  ['C4', 'sessionBudgetExceeded', '*', '*', 'Existing final/non-final rules apply with profile-only scope'],
  ['C5', 'any other kind, missing, or object variant', '*', '*', 'No capacity recovery; existing unrelated-error behavior'],
] as const

/** An upstream retry notification of `info` on the open attempt. */
async function upstream(s: Scripted, info: unknown, willRetry = true): Promise<void> {
  s.notify(...frames.retryError('a1', info, willRetry))
  await s.flush()
}

/** Today's upstream overload observables (O1). */
async function expectTodayUpstream(option: unknown): Promise<void> {
  const s = scripted(option)
  await opened(s)
  await upstream(s, 'serverOverloaded')
  expect(limitFailures(s).map(({ kind, final }) => ({ kind, final }))).toEqual([{ kind: 'serverOverloaded', final: false }])
  expect(s.limits.some((e) => e.type === 'wait-start')).toBe(true)
  expect(s.activities.at(-1)).toEqual({ phase: 'retrying', attempt: 1, maxRetries: 1, elapsedMs: 0 })
  expect(codexLimitScope('serverOverloaded')).toBe('login')
  expect(recovery(s)).toMatchObject({ timers: 0, retries: 0, continuations: 0 })
}

/** Today's terminal overload observables (O2). */
async function expectTodayTerminal(option: unknown): Promise<void> {
  const s = scripted(option)
  const handle = await opened(s)
  await failAttempt(s, 'a1')
  expect(limitFailures(s).map(({ kind, final }) => ({ kind, final }))).toEqual([{ kind: 'serverOverloaded', final: true }])
  expect((await handle.result).outcome).toBe('failed')
  expect(s.types().slice(-2)).toEqual(['turn_completed', 'error'])
  expect(recovery(s)).toEqual({ timers: 0, retries: 0, continuations: 0, terminals: 1, state: 'idle' })
  expect(s.activities.filter((a) => a && ('owner' in a || 'ordinal' in a || 'deadline' in a || 'nextRetryAt' in a))).toEqual([])
}

describe('codex-capacity-retry option table O', () => {
  test('the option table is committed verbatim', () => {
    expect(OPTION_TABLE.map((row) => row[0])).toEqual(['O1', 'O2', 'O3', 'O4', 'O5', 'O6', 'O7', 'O8'])
  })

  test('O1: capacityRecovery omitted, upstream serverOverloaded retry keeps the non-final login-scoped limit event and provider retry activity', async () => {
    await expectTodayUpstream(undefined)
  })

  test('O2: capacityRecovery omitted, terminal serverOverloaded keeps the final limit event and ends the turn with its error', async () => {
    await expectTodayTerminal(undefined)
  })

  test("O3: capacityRecovery 'off', upstream retry behaves as O1", async () => {
    await expectTodayUpstream('off')
  })

  test("O4: capacityRecovery 'off', terminal failed attempt behaves as O2", async () => {
    await expectTodayTerminal('off')
  })

  test("O5: capacityRecovery 'bounded', upstream retry records no limit event and dispatches no capacity attempt", async () => {
    for (const willRetry of [true, false]) {
      const s = scripted('bounded')
      await opened(s)
      const before = s.activities.length
      await upstream(s, 'serverOverloaded', willRetry)
      expect(s.limits).toEqual([])
      expect(s.activities.slice(before)).toEqual(willRetry ? [{ phase: 'retrying', attempt: 1, maxRetries: 1, elapsedMs: 0 }] : [])
      expect(recovery(s)).toMatchObject({ timers: 0, retries: 0, continuations: 0, terminals: 0, state: 'active' })
    }
  })

  test("O6: capacityRecovery 'bounded', terminal failed attempt records no limit event and starts capacity recovery", async () => {
    const s = scripted('bounded')
    await opened(s)
    await failAttempt(s, 'a1')
    expect(s.limits).toEqual([])
    expect(recovery(s)).toEqual({ timers: 1, retries: 1, continuations: 0, terminals: 0, state: 'active' })
  })

  test('O7: usage, rate and session-budget kinds give identical limit events and scopes in every mode', async () => {
    const observed: Record<string, unknown> = {}
    for (const option of [undefined, 'off', 'bounded', 'BOUNDED']) {
      for (const kind of ['usageLimitExceeded', 'rateLimitExceeded', 'sessionBudgetExceeded']) {
        const s = scripted(option)
        await opened(s)
        await snapshot(s, EXHAUSTED_SNAPSHOT)
        await upstream(s, kind)
        await failAttempt(s, 'a1', kind)
        const events = limitFailures(s).map(({ kind: k, final, resetsAt }) => ({ k, final, resetsAt }))
        expect(recovery(s)).toMatchObject({ timers: 0, continuations: 0, terminals: 1 })
        observed[`${String(option)}:${kind}`] = events
        const resetsAt = new Date(1_795_600_000_000).toISOString()
        expect(events).toEqual([{ k: kind, final: false, resetsAt }, { k: kind, final: true, resetsAt }])
      }
    }
    expect(codexLimitScope('usageLimitExceeded')).toBe('login')
    expect(codexLimitScope('rateLimitExceeded')).toBe('login')
    expect(codexLimitScope('sessionBudgetExceeded')).toBe('session')
    expect(Object.keys(observed)).toHaveLength(12)
  })

  test('O8: an unrecognized capacityRecovery string behaves as O3 and O4', async () => {
    for (const option of ['BOUNDED', 'on', 'bounded ', '']) {
      await expectTodayUpstream(option)
      await expectTodayTerminal(option)
    }
  })
})

describe("codex-capacity-retry classification table C ('bounded')", () => {
  test('the classification table is committed verbatim', () => {
    expect(CLASSIFICATION_TABLE.map((row) => row[0])).toEqual(['C1', 'C2', 'C3', 'C4', 'C5'])
  })

  // @covers: profile-limit-handling › Limit events are recorded per profile › Codex model capacity
  // @covers: profile-limit-handling › Codex model capacity does not cool a shared login › Exhausted quota snapshot alongside capacity
  test('C1: serverOverloaded upstream retry dispatches no attempt and records no quota event, with or without an exhausted snapshot', async () => {
    for (const rateLimits of [EXHAUSTED_SNAPSHOT, OPEN_SNAPSHOT, null]) {
      const s = scripted('bounded')
      await opened(s)
      if (rateLimits) await snapshot(s, rateLimits)
      await upstream(s, 'serverOverloaded')
      expect(limitFailures(s)).toEqual([])
      expect(recovery(s)).toMatchObject({ timers: 0, continuations: 0, terminals: 0 })
      expect(s.turnStarts()).toHaveLength(1)
    }
  })

  // @covers: profile-limit-handling › Limit events are recorded per profile › Codex model capacity
  // @covers: profile-limit-handling › Codex model capacity does not cool a shared login › Exhausted quota snapshot alongside capacity
  test('C2: terminal serverOverloaded considers capacity recovery and records no quota event, with or without an exhausted snapshot', async () => {
    for (const rateLimits of [EXHAUSTED_SNAPSHOT, OPEN_SNAPSHOT, null]) {
      const s = scripted('bounded')
      await opened(s)
      if (rateLimits) await snapshot(s, rateLimits)
      await failAttempt(s, 'a1')
      expect(limitFailures(s)).toEqual([])
      expect(recovery(s)).toEqual({ timers: 1, retries: 1, continuations: 0, terminals: 0, state: 'active' })
      // The ten-minute window, not the cached weekly reset, bounds recovery.
      const retry = s.events.find((e) => e.type === 'capacity_retry') as { deadline: string } | undefined
      expect(retry?.deadline).toBe(new Date(s.clock.epoch() + 600_000).toISOString())
    }
  })

  test('C3: usage and rate limits keep their final and non-final events and exhausted reset (shared-home scope)', async () => {
    for (const kind of ['usageLimitExceeded', 'rateLimitExceeded']) {
      for (const [rateLimits, resetsAt] of [[EXHAUSTED_SNAPSHOT, new Date(1_795_600_000_000).toISOString()], [OPEN_SNAPSHOT, null]] as const) {
        const s = scripted('bounded')
        await opened(s)
        await snapshot(s, rateLimits)
        await upstream(s, kind)
        await failAttempt(s, 'a1', kind)
        expect(limitFailures(s).map(({ kind: k, final, resetsAt: r }) => ({ k, final, r }))).toEqual([{ k: kind, final: false, r: resetsAt }, { k: kind, final: true, r: resetsAt }])
        expect(codexLimitScope(kind)).toBe('login')
        expect(recovery(s)).toMatchObject({ timers: 0, continuations: 0, terminals: 1, state: 'idle' })
      }
    }
  })

  test('C4: sessionBudgetExceeded keeps its final and non-final events with profile-only scope', async () => {
    const s = scripted('bounded')
    await opened(s)
    await upstream(s, 'sessionBudgetExceeded')
    await failAttempt(s, 'a1', 'sessionBudgetExceeded')
    expect(limitFailures(s).map(({ kind, final }) => ({ kind, final }))).toEqual([{ kind: 'sessionBudgetExceeded', final: false }, { kind: 'sessionBudgetExceeded', final: true }])
    expect(codexLimitScope('sessionBudgetExceeded')).toBe('session')
    expect(recovery(s)).toMatchObject({ timers: 0, continuations: 0, terminals: 1, state: 'idle' })
  })

  test('C5: another kind, a missing kind or an object variant gets no capacity recovery, even when its text mentions capacity', async () => {
    for (const info of ['contextWindowExceeded', null, { serverOverloaded: {} }, { responseStreamDisconnected: { httpStatusCode: 503 } }, 'ServerOverloaded']) {
      const s = scripted('bounded')
      const handle = await opened(s)
      s.notify(...frames.failed('a1', info, 'the server is overloaded: model capacity exceeded (serverOverloaded)'))
      await s.flush()
      expect((await handle.result).outcome).toBe('failed')
      expect(limitFailures(s)).toEqual([])
      expect(recovery(s)).toEqual({ timers: 0, retries: 0, continuations: 0, terminals: 1, state: 'idle' })
    }
  })
})
