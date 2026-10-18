import { describe, expect, test } from 'bun:test'
import { parseZaiQuotaLimit, type ZaiQuotaLimitSlice } from '../chat/zaiQuotaLimit'

const AT = '2026-10-07T13:00:00.000Z'
const SEVEN_DAY_RESET = '2026-10-12T09:00:00.000Z'

describe('parseZaiQuotaLimit', () => {
  // The 2026-10-12 capture from the operator's own gateway (live, pro plan):
  // two rows, epoch-millisecond resets, per-tool usageDetails the parser must
  // ignore, and the unit/number pair each row states its window length with
  // (2026-10-18: unit 5 = months, unit 3 = hours).
  const MONTHLY_RESET = 1793701399997 // 2026-11-03T10:23:19.997Z
  const CAPTURE: ZaiQuotaLimitSlice = {
    code: 200,
    msg: 'Operation successful',
    data: {
      limits: [
        {
          type: 'TIME_LIMIT',
          unit: 5,
          number: 1,
          usage: 1000,
          currentValue: 25,
          remaining: 975,
          percentage: 2,
          nextResetTime: MONTHLY_RESET,
          usageDetails: [{ modelCode: 'search-prime', usage: 25 }],
        },
        { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 30, nextResetTime: 1791845403778 },
      ],
      level: 'pro',
    },
    success: true,
  } as unknown as ZaiQuotaLimitSlice

  test('the capture maps each row to a labeled meter with its own period', () => {
    expect(parseZaiQuotaLimit(CAPTURE, AT)).toEqual({
      status: 'allowed',
      windows: [
        {
          key: 'zai:time_limit',
          label: 'Monthly tool calls',
          percentUsed: 2,
          resetsAt: new Date(MONTHLY_RESET).toISOString(),
          // One UTC calendar month back: 3 Oct, same time of day.
          periodMs: MONTHLY_RESET - Date.UTC(2026, 9, 3, 10, 23, 19, 997),
        },
        {
          key: 'zai:tokens_limit',
          label: '5-hour tokens',
          percentUsed: 30,
          resetsAt: new Date(1791845403778).toISOString(),
          periodMs: 5 * 60 * 60 * 1000,
        },
      ],
      receivedAt: AT,
      source: 'provider',
    })
  })

  test('unknown row kinds label as their raw type and carry no period', () => {
    // unit/number/reset a known kind would honor: the unknown kind must not.
    const payload: ZaiQuotaLimitSlice = {
      success: true,
      data: {
        limits: [
          {
            type: 'CREDITS_LIMIT',
            unit: 3,
            number: 5,
            percentage: 12,
            nextResetTime: 1791845403778,
          },
        ],
      },
    }
    const windows = parseZaiQuotaLimit(payload, AT)?.windows ?? []
    expect(windows).toEqual([
      {
        key: 'zai:credits_limit',
        label: 'CREDITS_LIMIT',
        percentUsed: 12,
        resetsAt: new Date(1791845403778).toISOString(),
      },
    ])
    for (const window of windows) {
      expect('periodMs' in window).toBe(false)
    }
  })

  test('every Object.prototype name as a row kind labels raw and carries no period', () => {
    // The kind lower-cases into a table lookup, so inherited names must not
    // resolve: a 'CONSTRUCTOR' or '__PROTO__' row is as unknown as any other.
    const names = Object.getOwnPropertyNames(Object.prototype)
    expect(names.length).toBeGreaterThan(0)
    const rows = names.flatMap((name) =>
      [name, name.toUpperCase()].map((type) => ({
        type,
        unit: 3,
        number: 5,
        percentage: 10,
        nextResetTime: 1791845403778,
      }))
    )
    const windows = parseZaiQuotaLimit({ success: true, data: { limits: rows } }, AT)?.windows ?? []
    expect(windows).toHaveLength(rows.length)
    expect(windows.map((window) => window.label)).toEqual(rows.map((row) => row.type))
    for (const window of windows) {
      expect('periodMs' in window).toBe(false)
    }
  })

  test('an Object.prototype name with an ISO reset stays raw and periodless', () => {
    const payload: ZaiQuotaLimitSlice = {
      success: true,
      data: {
        limits: [
          {
            type: 'CONSTRUCTOR',
            unit: 5,
            number: 1,
            percentage: 10,
            nextResetTime: '2026-11-03T10:23:19.997Z',
          },
        ],
      },
    }
    expect(parseZaiQuotaLimit(payload, AT)?.windows).toEqual([
      {
        key: 'zai:constructor',
        label: 'CONSTRUCTOR',
        percentUsed: 10,
        resetsAt: '2026-11-03T10:23:19.997Z',
      },
    ])
  })

  test('an ISO-string reset still yields a period, like the epoch-ms form', () => {
    const payload: ZaiQuotaLimitSlice = {
      success: true,
      data: {
        limits: [
          {
            type: 'TOKENS_LIMIT',
            unit: 3,
            number: 5,
            percentage: 30,
            nextResetTime: '2026-10-12T09:00:00.000Z',
          },
        ],
      },
    }
    expect(parseZaiQuotaLimit(payload, AT)?.windows).toEqual([
      {
        key: 'zai:tokens_limit',
        label: '5-hour tokens',
        percentUsed: 30,
        resetsAt: '2026-10-12T09:00:00.000Z',
        periodMs: 5 * 60 * 60 * 1000,
      },
    ])
  })

  test('a row without a usable percentage drops; the rest render', () => {
    const payload: ZaiQuotaLimitSlice = {
      success: true,
      data: {
        limits: [
          { type: 'TIME_LIMIT', percentage: null },
          { type: 'TOKENS_LIMIT', percentage: 30, nextResetTime: 1791845403778 },
        ],
      },
    }
    expect(parseZaiQuotaLimit(payload, AT)?.windows.map((window) => window.key)).toEqual([
      'zai:tokens_limit',
    ])
  })

  test('success:false, a missing limits array, or a non-object row is not the shape', () => {
    const refused = { success: false, code: 401, msg: 'token expired or incorrect' }
    expect(parseZaiQuotaLimit(refused as unknown as ZaiQuotaLimitSlice)).toBeNull()
    expect(parseZaiQuotaLimit({ success: true, data: {} })).toBeNull()
    const junk = { success: true, data: { limits: [null, 7] } }
    expect(parseZaiQuotaLimit(junk as unknown as ZaiQuotaLimitSlice, AT)?.windows).toEqual([])
    expect(parseZaiQuotaLimit(null)).toBeNull()
  })

  test('repeated row types keep every row as its own meter', () => {
    const payload: ZaiQuotaLimitSlice = {
      success: true,
      data: {
        limits: [
          { type: 'TIME_LIMIT', percentage: 2 },
          { type: 'TIME_LIMIT', percentage: 50 },
        ],
      },
    }
    expect(parseZaiQuotaLimit(payload, AT)?.windows.map((window) => window.key)).toEqual([
      'zai:time_limit',
      'zai:time_limit#2',
    ])
  })

  test('provider rows without a usable length carry no periodMs key', () => {
    const report = parseZaiQuotaLimit(
      {
        success: true,
        data: {
          limits: [
            { type: 'TOKENS_LIMIT', percentage: 30, nextResetTime: Date.parse(SEVEN_DAY_RESET) },
            { type: 'TIME_LIMIT', percentage: 2, nextResetTime: Date.parse(SEVEN_DAY_RESET) },
          ],
        },
      },
      AT
    )
    expect(report?.windows).toHaveLength(2)
    for (const window of report?.windows ?? []) {
      expect('periodMs' in window).toBe(false)
    }
  })

  test('a lengthless row labels the bare word; an unusable count is never coerced', () => {
    const payload: ZaiQuotaLimitSlice = {
      success: true,
      data: {
        limits: [
          // No unit at all, and an unknown unit: bare words, no period.
          { type: 'TOKENS_LIMIT', percentage: 30, nextResetTime: 1791845403778 },
          { type: 'TIME_LIMIT', unit: 7, number: 2, percentage: 5, nextResetTime: 1791845403778 },
          // A string count stays unusable: no length, no period.
          {
            type: 'TOKENS_LIMIT',
            unit: 3,
            number: '5' as unknown as number,
            percentage: 5,
            nextResetTime: 1791845403778,
          },
          // A month count above one spells out; the label needs only
          // unit + number, so it keeps the length even with no reset to
          // measure a period from.
          { type: 'TIME_LIMIT', unit: 5, number: 2, percentage: 5 },
        ],
      },
    }
    const windows = parseZaiQuotaLimit(payload, AT)?.windows ?? []
    expect(windows.map((window) => window.label)).toEqual([
      'Tokens',
      'Tool calls',
      'Tokens',
      '2-month tool calls',
    ])
    for (const window of windows) {
      expect('periodMs' in window).toBe(false)
    }
  })
})
