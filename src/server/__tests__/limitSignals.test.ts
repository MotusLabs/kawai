import { describe, expect, test } from 'bun:test'
import { assistantLimitSignal, isResetTimeZone, rejectedResetsAt, rejectedWindow, retryLimitSignal, textResetsAt, withTextReset } from '../chat/limitSignals'

describe('the rejected report window', () => {
  test('a rejected report names its window; other statuses and unnamed windows do not', () => {
    expect(rejectedWindow({ status: 'rejected', resetsAt: 5, rateLimitType: 'seven_day_opus' })).toBe('seven_day_opus')
    expect(rejectedWindow({ status: 'rejected', resetsAt: 5 })).toBeNull()
    expect(rejectedWindow({ status: 'allowed', rateLimitType: 'five_hour' })).toBeNull()
    expect(rejectedWindow({ status: 'rejected', rateLimitType: '' })).toBeNull()
    expect(rejectedWindow(null)).toBeNull()
  })

  test('both signals carry the window beside the reset', () => {
    expect(retryLimitSignal({ error: 'rate_limit', error_status: 429 }, 'r', 'five_hour'))
      .toMatchObject({ final: false, resetsAt: 'r', window: 'five_hour' })
    expect(assistantLimitSignal('rate_limit', 'API Error: 429 x', 'r', 'seven_day_sonnet'))
      .toMatchObject({ final: true, resetsAt: 'r', window: 'seven_day_sonnet' })
    // Gateway errors carry none.
    expect(retryLimitSignal({ error: 'rate_limit', error_status: 429 }, null)).toMatchObject({ window: null })
  })
})

describe('limit signals', () => {
  test('retries count for limit classes or status 429', () => {
    expect(retryLimitSignal({ error: 'overloaded', error_status: 529 }, null)).toMatchObject({ kind: 'overloaded', final: false, status: 529 })
    expect(retryLimitSignal({ error: 'unknown', error_status: 429 }, 'r')).toMatchObject({ kind: 'unknown', status: 429, resetsAt: 'r' })
    expect(retryLimitSignal({ error: 'billing_error' }, null)).toMatchObject({ kind: 'billing_error', status: null })
    expect(retryLimitSignal({ error: 'server_error', error_status: 500 }, null)).toBeNull()
    expect(retryLimitSignal({}, null)).toBeNull()
  })

  test('failed assistant messages read the status from the error text', () => {
    expect(assistantLimitSignal('billing_error', 'API Error: 402 pay up', null))
      .toEqual({ kind: 'billing_error', final: true, status: 402, message: 'API Error: 402 pay up', resetsAt: null, window: null })
    expect(assistantLimitSignal('rate_limit', '  ', null)).toMatchObject({ status: null, message: null })
    expect(assistantLimitSignal('invalid_request', 'API Error: 429 x', null)).toMatchObject({ status: 429 })
    expect(assistantLimitSignal('invalid_request', 'API Error: 400 x', null)).toBeNull()
    expect(assistantLimitSignal(undefined, 'API Error: 429', null)).toBeNull()
  })

  test('a zone-less reset in the error text is read in the profile zone', () => {
    const glm = 'API Error: Server is temporarily limiting requests (not your usage limit) · [1308][Usage limit reached for 5 hour. Your limit will reset at 2026-10-13 17:17:00][2026101316]'
    expect(textResetsAt(glm, 'Asia/Shanghai')).toBe('2026-10-13T09:17:00.000Z')
    expect(textResetsAt(glm, '+08:00')).toBe('2026-10-13T09:17:00.000Z')
    expect(textResetsAt(glm, '-03:30')).toBe('2026-10-13T20:47:00.000Z')
    expect(textResetsAt(glm, 'UTC')).toBe('2026-10-13T17:17:00.000Z')
    expect(textResetsAt('resets at 2026-07-01 12:00', 'Europe/Berlin')).toBe('2026-07-01T10:00:00.000Z')
    expect(textResetsAt('resets at 2026-01-01 12:00', 'Europe/Berlin')).toBe('2026-01-01T11:00:00.000Z')
    expect(textResetsAt(glm, 'Mars/Olympus')).toBeNull()
    expect(textResetsAt('API Error: 429 slow down', '+08:00')).toBeNull()
  })

  test('out-of-range date parts never invent a reset', () => {
    for (const bad of ['2026-13-45 10:00:00', '2026-02-30 10:00:00', '2026-10-13 25:00:00', '2026-10-13 10:61:00', '2026-10-13 10:00:61']) {
      expect(textResetsAt(`resets at ${bad}`, '+08:00')).toBeNull()
    }
    expect(textResetsAt('resets at 2028-02-29 10:00:00', '+08:00')).toBe('2028-02-29T02:00:00.000Z')
  })

  test('an announced reset wins; the text is read only with a profile zone', () => {
    const signal = assistantLimitSignal('rate_limit', 'Your limit will reset at 2026-10-13 17:17:00', null)!
    expect(withTextReset(signal, '+08:00').resetsAt).toBe('2026-10-13T09:17:00.000Z')
    expect(withTextReset(signal, undefined)).toBe(signal)
    const announced = { ...signal, resetsAt: '2026-10-13T10:00:00.000Z' }
    expect(withTextReset(announced, '+08:00')).toBe(announced)
    // A non-final retry never reads the text, even when it carries one.
    const retry = { ...retryLimitSignal({ error: 'rate_limit' }, null)!, message: 'Your limit will reset at 2026-10-13 17:17:00' }
    expect(withTextReset(retry, '+08:00')).toBe(retry)
    expect(withTextReset(retry, '+08:00').resetsAt).toBeNull()
    const noTime = assistantLimitSignal('rate_limit', 'API Error: 429', null)!
    expect(withTextReset(noTime, '+08:00')).toBe(noTime)
  })

  test('reset zones are IANA names or ±HH:MM offsets', () => {
    expect(isResetTimeZone('Asia/Shanghai')).toBe(true)
    expect(isResetTimeZone('+08:00')).toBe(true)
    expect(isResetTimeZone('UTC+8')).toBe(false)
    expect(isResetTimeZone('+24:00')).toBe(false)
    expect(isResetTimeZone('')).toBe(false)
  })

  test('only a rejected rate_limit_event with a time announces a reset', () => {
    expect(rejectedResetsAt({ status: 'rejected', resetsAt: 1_800_000_000 })).toBe(new Date(1_800_000_000_000).toISOString())
    expect(rejectedResetsAt({ status: 'allowed', resetsAt: 1_800_000_000 })).toBeNull()
    expect(rejectedResetsAt({ status: 'rejected', resetsAt: null })).toBeNull()
    expect(rejectedResetsAt({ status: 'rejected', resetsAt: Number.NaN })).toBeNull()
    expect(rejectedResetsAt(undefined)).toBeNull()
  })
})
