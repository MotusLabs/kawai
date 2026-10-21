// Codex limit signals (codex-chat-sessions D9, PR E 7.2): tables pin the
// final kinds and scopes, the latest-exhausted-reset rule, the retry rule,
// and the provider a recorded event names — with the openrouter-provider
// 3.1 carve-out that a Codex 402 records no credit event.
import { describe, expect, test } from 'bun:test'
import { codexLimitProviderId, codexLimitScope, codexRetryLimitSignal, codexTurnLimitSignal, latestExhaustedReset } from '../chat/codex/codexLimits'
import type { RateLimitSnapshot } from '../chat/codex/protocol/v2/RateLimitSnapshot'

const HOUR = 3_600
const DAY = 86_400

const snapshot = (primary: Record<string, unknown>, secondary: Record<string, unknown> = { usedPercent: 40, windowDurationMins: 10080, resetsAt: null }): RateLimitSnapshot =>
  ({
    limitId: 'codex', limitName: null, normalModelSlug: null, primary, secondary,
    credits: null, individualLimit: null, spendControlReached: null, planType: 'plus', rateLimitReachedType: null,
  }) as RateLimitSnapshot

const failedTurn = (codexErrorInfo: unknown, message = 'limit reached') =>
  ({ status: 'failed', error: { codexErrorInfo, message, additionalDetails: null, misalignment: null } })

describe('codexTurnLimitSignal', () => {
  test('usage limit ends the turn: a final signal with the latest exhausted reset', () => {
    // Both windows exhausted (spec: multiple exhausted windows) — the weekly
    // 2-day reset wins over the five-hour 1-hour one.
    const snap = snapshot({ usedPercent: 100, windowDurationMins: 300, resetsAt: 1000 + HOUR }, { usedPercent: 100, windowDurationMins: 10080, resetsAt: 1000 + 2 * DAY })
    const signal = codexTurnLimitSignal(failedTurn('usageLimitExceeded'), snap)
    expect(signal).toEqual({
      kind: 'usageLimitExceeded', final: true, status: null, message: 'limit reached',
      resetsAt: new Date((1000 + 2 * DAY) * 1000).toISOString(), window: null,
    })
    // The rate and overload kinds are login-scoped finals too.
    expect(codexTurnLimitSignal(failedTurn('rateLimitExceeded'), snap)?.kind).toBe('rateLimitExceeded')
    expect(codexTurnLimitSignal(failedTurn('serverOverloaded'), snap)?.final).toBe(true)
  })

  test('only one exhausted window: a non-exhausted weekly never extends the reset', () => {
    // The spec's one-exhausted-window case: the weekly window sits below its
    // limit and resets later, so the five-hour reset decides.
    const snap = snapshot({ usedPercent: 100, windowDurationMins: 300, resetsAt: 1000 + HOUR }, { usedPercent: 40, windowDurationMins: 10080, resetsAt: 1000 + 2 * DAY })
    expect(codexTurnLimitSignal(failedTurn('usageLimitExceeded'), snap)?.resetsAt).toBe(new Date((1000 + HOUR) * 1000).toISOString())
    // No exhausted window, or no snapshot at all: the 1 h default applies.
    expect(codexTurnLimitSignal(failedTurn('usageLimitExceeded'), snapshot({ usedPercent: 99, windowDurationMins: 300, resetsAt: 1000 }))?.
      resetsAt).toBeNull()
    expect(codexTurnLimitSignal(failedTurn('usageLimitExceeded'), null)?.resetsAt).toBeNull()
    expect(latestExhaustedReset(snapshot({ usedPercent: 100, windowDurationMins: 300, resetsAt: null }))).toBeNull()
  })

  test('an unrelated failure records nothing', () => {
    expect(codexTurnLimitSignal(failedTurn('contextWindowExceeded'), null)).toBeNull()
    expect(codexTurnLimitSignal(failedTurn('other'), null)).toBeNull()
    // An object variant (an HTTP failure) and a non-failed turn too.
    expect(codexTurnLimitSignal(failedTurn({ httpConnectionFailed: { httpStatusCode: 500 } }), null)).toBeNull()
    expect(codexTurnLimitSignal({ status: 'completed', error: null }, null)).toBeNull()
    expect(codexTurnLimitSignal({ status: 'failed', error: null }, null)).toBeNull()
  })

  test("a Codex session's 402 is not a credit limit here (openrouter-provider 3.1)", () => {
    // The Claude paths force window 'credit' on a 402 (limitSignals.ts); the
    // Codex kinds are a closed table, so an HTTP 402-shaped failure and a
    // 402 in the message record nothing through this path.
    expect(codexTurnLimitSignal(failedTurn({ responseStreamConnectionFailed: { httpStatusCode: 402 } }), null)).toBeNull()
    expect(codexTurnLimitSignal(failedTurn('other', 'API Error: 402 This request requires more credits'), null)).toBeNull()
    expect(codexTurnLimitSignal(failedTurn({ responseTooManyFailedAttempts: { httpStatusCode: 402 } }), null)).toBeNull()
  })
})

describe('codexRetryLimitSignal', () => {
  test('a retrying error notification is a non-final signal', () => {
    // The notification's error is the TurnError itself, not a turn.
    const error = { codexErrorInfo: 'rateLimitExceeded', message: 'rate limit', additionalDetails: null, misalignment: null }
    const notification = { willRetry: true, error, threadId: 't', turnId: 'ct-1' }
    expect(codexRetryLimitSignal(notification, null)).toMatchObject({ kind: 'rateLimitExceeded', final: false })
  })

  test('a not-retrying or non-limit error records nothing', () => {
    const error = (codexErrorInfo: unknown) => ({ codexErrorInfo, message: 'x', additionalDetails: null, misalignment: null })
    expect(codexRetryLimitSignal({ willRetry: false, error: error('rateLimitExceeded') }, null)).toBeNull()
    expect(codexRetryLimitSignal({ willRetry: true, error: error('contextWindowExceeded') }, null)).toBeNull()
    expect(codexRetryLimitSignal({ willRetry: true }, null)).toBeNull()
    expect(codexRetryLimitSignal(null, null)).toBeNull()
  })
})

describe('scopes', () => {
  test('the login kinds share the home; the session budget is its own profile alone', () => {
    expect(codexLimitScope('usageLimitExceeded')).toBe('login')
    expect(codexLimitScope('rateLimitExceeded')).toBe('login')
    expect(codexLimitScope('serverOverloaded')).toBe('login')
    expect(codexLimitScope('sessionBudgetExceeded')).toBe('session')
    expect(codexLimitScope('contextWindowExceeded')).toBeNull()
    expect(codexLimitScope(undefined)).toBeNull()
  })

  test('a recorded event names the home for login kinds and no provider for the budget', () => {
    expect(codexLimitProviderId('usageLimitExceeded', 'codex-home-1a2b3c4d5e6f')).toBe('codex-home-1a2b3c4d5e6f')
    expect(codexLimitProviderId('sessionBudgetExceeded', 'codex-home-1a2b3c4d5e6f')).toBeNull()
    // Claude kinds pass their provider through unchanged.
    expect(codexLimitProviderId('rate_limit', 'zai')).toBe('zai')
    expect(codexLimitProviderId('billing_error', 'claude')).toBe('claude')
  })
})
