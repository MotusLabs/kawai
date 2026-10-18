import { describe, expect, test } from 'bun:test'
import { parseZaiQuotaLimit, type ZaiQuotaLimitSlice } from '../chat/zaiQuotaLimit'

const AT = '2026-10-07T13:00:00.000Z'
const SEVEN_DAY_RESET = '2026-10-12T09:00:00.000Z'

describe('parseZaiQuotaLimit', () => {
  // The 2026-10-12 capture from the operator's own gateway (live, pro plan):
  // two rows, epoch-millisecond resets, per-tool usageDetails the parser must
  // ignore, and unit/number fields whose semantics stay unknown.
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
          nextResetTime: 1793701399997,
          usageDetails: [{ modelCode: 'search-prime', usage: 25 }],
        },
        { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 30, nextResetTime: 1791845403778 },
      ],
      level: 'pro',
    },
    success: true,
  } as unknown as ZaiQuotaLimitSlice

  test('the capture yields one meter per row, labeled by kind, resets from epoch-ms', () => {
    expect(parseZaiQuotaLimit(CAPTURE, AT)).toEqual({
      status: 'allowed',
      windows: [
        {
          key: 'zai:time_limit',
          label: 'Prompts',
          percentUsed: 2,
          resetsAt: new Date(1793701399997).toISOString(),
        },
        {
          key: 'zai:tokens_limit',
          label: 'Weekly tokens',
          percentUsed: 30,
          resetsAt: new Date(1791845403778).toISOString(),
        },
      ],
      receivedAt: AT,
      source: 'provider',
    })
  })

  test('unknown row kinds label as their raw type', () => {
    const payload: ZaiQuotaLimitSlice = {
      success: true,
      data: { limits: [{ type: 'CREDITS_LIMIT', percentage: 12, nextResetTime: 1791845403778 }] },
    }
    expect(parseZaiQuotaLimit(payload, AT)?.windows).toEqual([
      {
        key: 'zai:credits_limit',
        label: 'CREDITS_LIMIT',
        percentUsed: 12,
        resetsAt: new Date(1791845403778).toISOString(),
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

  test('provider quota rows never carry a period', () => {
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
})
