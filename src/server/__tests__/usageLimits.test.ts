import { describe, expect, test } from 'bun:test'
import type { ChatUsageReport } from '../../shared/chat'
import {
  UsageLimitStore,
  parseRateLimitEvent,
  parseUsagePull,
  parseUsageReport,
  parseZaiQuotaLimit,
  type RateLimitInfoSlice,
  type UsagePullSlice,
  type UsageReportSlice,
  type ZaiQuotaLimitSlice,
} from '../chat/usageLimits'
import { windowPeriodMs } from '../chat/usageWindowPeriods'

const AT = '2026-10-07T13:00:00.000Z'
const FIVE_HOUR_RESET = '2026-10-07T18:11:04.000Z'
const SEVEN_DAY_RESET = '2026-10-12T09:00:00.000Z'
const FIVE_HOURS_MS = 5 * 60 * 60 * 1000
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000

/**
 * The 2026-10-07 probe payload: one event carrying both plan windows through
 * the undocumented unifiedWindows sibling (fractions, epoch-seconds resets), plus
 * the legacy single-window fields naming one of them.
 */
const PROBE_EVENT: RateLimitInfoSlice = {
  status: 'allowed',
  rateLimitType: 'seven_day',
  utilization: 0.1712,
  resetsAt: Date.parse(SEVEN_DAY_RESET) / 1000,
  unifiedWindows: {
    five_hour: {
      utilization: 0.2237,
      resetsAt: Date.parse(FIVE_HOUR_RESET) / 1000,
    },
    seven_day: {
      utilization: 0.1712,
      resetsAt: Date.parse(SEVEN_DAY_RESET) / 1000,
    },
  },
  isUsingOverage: false,
}

describe('parseRateLimitEvent', () => {
  test('the probe payload yields both windows from unifiedWindows, deduped', () => {
    expect(parseRateLimitEvent(PROBE_EVENT, AT)).toEqual({
      status: 'allowed',
      windows: [
        {
          key: 'five_hour',
          label: '5-hour window',
          percentUsed: 22.37,
          resetsAt: FIVE_HOUR_RESET,
          periodMs: FIVE_HOURS_MS,
        },
        {
          key: 'seven_day',
          label: '7-day window',
          percentUsed: 17.12,
          resetsAt: SEVEN_DAY_RESET,
          periodMs: SEVEN_DAYS_MS,
        },
      ],
      receivedAt: AT,
      source: 'push',
    })
  })

  test('resetsAt is epoch seconds, as captured on the wire (2026-10-11)', () => {
    const report = parseRateLimitEvent(
      {
        status: 'allowed',
        unifiedWindows: {
          five_hour: { utilization: 0.03, resetsAt: 1791723600 },
          seven_day: { utilization: 0.32, resetsAt: 1791817200 },
        },
      },
      AT
    )
    expect(report.windows.map((window) => window.resetsAt)).toEqual([
      '2026-10-11T13:00:00.000Z',
      '2026-10-12T15:00:00.000Z',
    ])
  })

  test('a single-window payload falls back to rateLimitType', () => {
    expect(
      parseRateLimitEvent(
        {
          status: 'allowed_warning',
          rateLimitType: 'five_hour',
          utilization: 0.87,
          resetsAt: Date.parse(FIVE_HOUR_RESET) / 1000,
        },
        AT
      )
    ).toEqual({
      status: 'warning',
      windows: [
        {
          key: 'five_hour',
          label: '5-hour window',
          percentUsed: 87,
          resetsAt: FIVE_HOUR_RESET,
          periodMs: FIVE_HOURS_MS,
        },
      ],
      receivedAt: AT,
      source: 'push',
    })
  })

  test('a rejected event maps to limited', () => {
    const report = parseRateLimitEvent(
      { status: 'rejected', rateLimitType: 'seven_day', utilization: 1 },
      AT
    )
    expect(report.status).toBe('limited')
    expect(report.windows[0]).toMatchObject({ key: 'seven_day', percentUsed: 100 })
  })

  test('the GLM status-only payload yields a windowless allowed report', () => {
    expect(
      parseRateLimitEvent({ status: 'allowed', isUsingOverage: false }, AT)
    ).toEqual({ status: 'allowed', windows: [], receivedAt: AT, source: 'push' })
  })

  test('malformed values are rejected, not rendered wrong', () => {
    const report = parseRateLimitEvent(
      {
        status: 'allowed',
        rateLimitType: 'seven_day',
        utilization: Number.NaN,
        unifiedWindows: {
          five_hour: { utilization: 1.4, resetsAt: Date.parse(FIVE_HOUR_RESET) / 1000 }, // fraction > 1
          seven_day: { utilization: -0.1, resetsAt: Date.parse(SEVEN_DAY_RESET) / 1000 }, // negative
          seven_day_opus: { utilization: '0.2' as unknown as number, resetsAt: Date.parse(SEVEN_DAY_RESET) / 1000 }, // string
          seven_day_sonnet: { utilization: 0.31, resetsAt: Number.NaN }, // valid %, unusable reset
          seven_day_oauth_apps: { utilization: 0.42, resetsAt: Date.parse(SEVEN_DAY_RESET) / 1000 },
        },
      },
      AT
    )
    expect(report.windows).toEqual([
      {
        // Unknown kinds label as themselves (a new meter needs no release).
        key: 'seven_day_sonnet',
        label: '7-day Sonnet window',
        percentUsed: 31,
        resetsAt: null,
        periodMs: SEVEN_DAYS_MS,
      },
      {
        key: 'seven_day_oauth_apps',
        label: '7-day OAuth apps window',
        percentUsed: 42,
        resetsAt: SEVEN_DAY_RESET,
        periodMs: SEVEN_DAYS_MS,
      },
    ])
  })

  test('an unknown status maps to allowed', () => {
    expect(
      parseRateLimitEvent({ status: 'something_new' }, AT).status
    ).toBe('allowed')
  })

  test('a missing or null event still yields a windowless report', () => {
    expect(parseRateLimitEvent(null, AT)).toEqual({
      status: 'allowed',
      windows: [],
      receivedAt: AT,
      source: 'push',
    })
  })
})

/** The structured /usage twin an assistant message carries. */
const FULL_USAGE_REPORT: UsageReportSlice = {
  rate_limits: {
    limits: [
      {
        kind: 'session',
        group: 'session',
        percent: 22.4,
        resets_at: FIVE_HOUR_RESET,
        severity: 'normal',
        is_active: false,
      },
      {
        kind: 'weekly_all',
        group: 'weekly',
        percent: 17,
        resets_at: null,
        severity: 'normal',
        is_active: true,
      },
      {
        kind: 'weekly_scoped',
        group: 'weekly',
        percent: 42.5,
        resets_at: SEVEN_DAY_RESET,
        scope: { model: { display_name: 'Opus' } },
        severity: 'warning',
      },
    ],
  },
}

describe('parseUsageReport', () => {
  test('a full limits array maps to windows keyed by kind, scoped by model', () => {
    expect(parseUsageReport(FULL_USAGE_REPORT, AT)).toEqual({
      status: 'warning', // the worst row severity
      windows: [
        {
          key: 'session',
          label: '5-hour window',
          percentUsed: 22.4,
          resetsAt: FIVE_HOUR_RESET,
          periodMs: FIVE_HOURS_MS,
        },
        {
          key: 'weekly_all',
          label: '7-day window',
          percentUsed: 17,
          resetsAt: null,
          periodMs: SEVEN_DAYS_MS,
        },
        {
          key: 'weekly_scoped:Opus',
          label: 'Opus',
          percentUsed: 42.5,
          resetsAt: SEVEN_DAY_RESET,
          periodMs: SEVEN_DAYS_MS,
        },
      ],
      receivedAt: AT,
      source: 'report',
    })
  })

  test('two scoped weekly rows never collide and may grade the status', () => {
    const report = parseUsageReport(
      {
        rate_limits: {
          limits: [
            {
              kind: 'weekly_scoped',
              percent: 3.2,
              scope: { model: { display_name: 'Fable' } },
              severity: 'normal',
            },
            {
              kind: 'weekly_scoped',
              percent: 100,
              scope: { model: { display_name: 'Opus' } },
              severity: 'critical',
            },
          ],
        },
      },
      AT
    )
    expect(report?.windows.map((window) => window.key)).toEqual([
      'weekly_scoped:Fable',
      'weekly_scoped:Opus',
    ])
    expect(report?.windows.map((window) => window.label)).toEqual(['Fable', 'Opus'])
    expect(report?.status).toBe('limited')
  })

  test('an empty limits array yields a windowless report; absent limits yield null', () => {
    expect(parseUsageReport({ rate_limits: { limits: [] } }, AT)).toEqual({
      status: 'allowed',
      windows: [],
      receivedAt: AT,
      source: 'report',
    })
    expect(parseUsageReport({ rate_limits: { limits: null } }, AT)).toBeNull()
    expect(parseUsageReport({ rate_limits: null }, AT)).toBeNull()
    expect(parseUsageReport(null, AT)).toBeNull()
  })

  test('rows with unusable percent or kind are dropped', () => {
    const report = parseUsageReport(
      {
        rate_limits: {
          limits: [
            { kind: 'session', percent: 101, severity: 'critical' }, // out of range
            { kind: 'session', percent: Number.POSITIVE_INFINITY }, // not finite
            { kind: '', percent: 10 }, // no meter kind
            { percent: 20 }, // no meter kind
            { kind: 'weekly_all', percent: 17, severity: 'mysterious' }, // unknown severity → allowed
          ],
        },
      },
      AT
    )
    expect(report?.windows).toEqual([
      {
        key: 'weekly_all',
        label: '7-day window',
        percentUsed: 17,
        resetsAt: null,
        periodMs: SEVEN_DAYS_MS,
      },
    ])
    expect(report?.status).toBe('allowed')
  })
})

/** A full usage control reply (the SDK pull response shape). */
const FULL_PULL: UsagePullSlice = {
  subscription_type: 'max',
  rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: 22.37, resets_at: FIVE_HOUR_RESET },
    seven_day: { utilization: 17.12, resets_at: SEVEN_DAY_RESET },
    seven_day_opus: { utilization: 42.5, resets_at: SEVEN_DAY_RESET },
    seven_day_sonnet: { utilization: null, resets_at: SEVEN_DAY_RESET },
    seven_day_oauth_apps: null,
    model_scoped: [
      { display_name: 'Fable', utilization: 3.2, resets_at: SEVEN_DAY_RESET },
      { display_name: '', utilization: 50, resets_at: SEVEN_DAY_RESET }, // unlabeled
      { display_name: 'Haiku', utilization: -1, resets_at: SEVEN_DAY_RESET }, // out of range
    ],
  },
}

describe('parseUsagePull', () => {
  test('a full pull maps every known window and the scoped weekly rows', () => {
    expect(parseUsagePull(FULL_PULL, AT)).toEqual({
      status: 'allowed', // the pull carries no severity
      windows: [
        {
          key: 'five_hour',
          label: '5-hour window',
          percentUsed: 22.37,
          resetsAt: FIVE_HOUR_RESET,
          periodMs: FIVE_HOURS_MS,
        },
        {
          key: 'seven_day',
          label: '7-day window',
          percentUsed: 17.12,
          resetsAt: SEVEN_DAY_RESET,
          periodMs: SEVEN_DAYS_MS,
        },
        {
          key: 'seven_day_opus',
          label: '7-day Opus window',
          percentUsed: 42.5,
          resetsAt: SEVEN_DAY_RESET,
          periodMs: SEVEN_DAYS_MS,
        },
        {
          key: 'model_scoped:Fable',
          label: 'Fable',
          percentUsed: 3.2,
          resetsAt: SEVEN_DAY_RESET,
          periodMs: SEVEN_DAYS_MS,
        },
      ],
      receivedAt: AT,
      source: 'pull',
    })
  })

  test('rate_limits_available: false yields null (plan limits do not apply)', () => {
    expect(
      parseUsagePull({ rate_limits_available: false, rate_limits: null }, AT)
    ).toBeNull()
  })

  test('missing rate limits or an empty object yields null or no windows', () => {
    expect(parseUsagePull({}, AT)).toBeNull()
    expect(parseUsagePull({ rate_limits_available: true, rate_limits: {} }, AT)).toEqual({
      status: 'allowed',
      windows: [],
      receivedAt: AT,
      source: 'pull',
    })
  })
})

function report(overrides: Partial<ChatUsageReport> = {}): ChatUsageReport {
  return {
    status: 'allowed',
    windows: [
      { key: 'five_hour', label: '5-hour window', percentUsed: 22, resetsAt: FIVE_HOUR_RESET },
    ],
    receivedAt: AT,
    ...overrides,
  }
}

describe('UsageLimitStore', () => {
  test('a windowless report keeps the windows already held', () => {
    const store = new UsageLimitStore()
    store.record('default', report())
    store.record('default', report({ status: 'warning', windows: [], receivedAt: '2026-10-07T14:00:00.000Z' }))
    expect(store.get('default')).toEqual({
      status: 'warning',
      windows: [
        { key: 'five_hour', label: '5-hour window', percentUsed: 22, resetsAt: FIVE_HOUR_RESET },
      ],
      receivedAt: '2026-10-07T14:00:00.000Z',
    })
  })

  test('older data never overwrites newer', () => {
    const store = new UsageLimitStore()
    store.record('default', report({ receivedAt: '2026-10-07T14:00:00.000Z', status: 'warning' }))
    store.record('default', report({ receivedAt: '2026-10-07T13:00:00.000Z' }))
    expect(store.get('default')?.status).toBe('warning')
    expect(store.get('default')?.receivedAt).toBe('2026-10-07T14:00:00.000Z')
  })

  test('a no-data verdict hides data but a push replaces it', () => {
    const store = new UsageLimitStore()
    store.recordNoData('glm', AT)
    expect(store.get('glm')).toBeNull()
    expect(store.claimPull('glm')).toBe(false) // the verdict suppresses pulls

    store.record('glm', report({ windows: [], receivedAt: '2026-10-07T15:00:00.000Z' }))
    expect(store.get('glm')).toEqual({
      status: 'allowed',
      windows: [],
      receivedAt: '2026-10-07T15:00:00.000Z',
    })
  })

  test('a no-data verdict never displaces a report that already landed', () => {
    const store = new UsageLimitStore()
    store.record('default', report())
    store.recordNoData('default', '2026-10-07T16:00:00.000Z')
    expect(store.get('default')?.receivedAt).toBe(AT)
  })

  test('claimPull is granted once and only with neither report nor verdict', () => {
    const store = new UsageLimitStore()
    expect(store.claimPull('default')).toBe(true)
    expect(store.claimPull('default')).toBe(false) // once per store lifetime

    expect(store.claimPull('glm')).toBe(true)
    store.record('glm', report())
    expect(store.claimPull('minimax')).toBe(true)
    store.recordNoData('minimax')
    expect(store.claimPull('kimi')).toBe(true)
    // A fresh profile that was never claimed still grants.
    expect(store.claimPull('lan')).toBe(true)
  })

  test('listeners hear changes per profile and stop on unsubscribe', () => {
    const store = new UsageLimitStore()
    const seen: Array<{ profileId: string; report: ChatUsageReport | null }> = []
    store.subscribe((profileId, rep) => seen.push({ profileId, report: rep }))
    const noisy: string[] = []
    const unsubscribe = store.subscribe((profileId) => noisy.push(profileId))
    unsubscribe()

    store.record('default', report())
    store.recordNoData('glm')
    // An ignored older report notifies nobody.
    store.record('default', report({ receivedAt: '2026-10-06T00:00:00.000Z' }))
    expect(seen).toEqual([
      { profileId: 'default', report: store.get('default') },
      { profileId: 'glm', report: null },
    ])
    expect(noisy).toEqual([])
  })
})

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
})

describe('window period lengths', () => {
  test('known kinds carry 5-hour and 7-day periods, scope and #n suffixes ignored', () => {
    expect(windowPeriodMs('five_hour')).toBe(FIVE_HOURS_MS)
    expect(windowPeriodMs('session')).toBe(FIVE_HOURS_MS)
    expect(windowPeriodMs('seven_day_overage_included')).toBe(SEVEN_DAYS_MS)
    expect(windowPeriodMs('weekly_scoped:Opus')).toBe(SEVEN_DAYS_MS)
    expect(windowPeriodMs('model_scoped:Fable')).toBe(SEVEN_DAYS_MS)
    expect(windowPeriodMs('weekly_all#2')).toBe(SEVEN_DAYS_MS)
  })

  test('overage and unknown kinds carry none unless a /usage group names it', () => {
    expect(windowPeriodMs('overage')).toBeUndefined()
    expect(windowPeriodMs('brand_new_meter')).toBeUndefined()
    expect(windowPeriodMs('brand_new_meter', 'weekly')).toBe(SEVEN_DAYS_MS)
    expect(windowPeriodMs('brand_new_meter', 'session')).toBe(FIVE_HOURS_MS)
    expect(windowPeriodMs('brand_new_meter', 'monthly')).toBeUndefined()
  })

  test('push and report overage or unknown windows render without a period', () => {
    const push = parseRateLimitEvent(
      { status: 'allowed', rateLimitType: 'overage', utilization: 0.5 },
      AT
    )
    expect(push.windows[0]?.periodMs).toBeUndefined()
    const report = parseUsageReport(
      {
        rate_limits: {
          limits: [
            { kind: 'mystery', percent: 5 },
            { kind: 'mystery_weekly', group: 'weekly', percent: 6 },
          ],
        },
      },
      AT
    )
    expect(report?.windows.map((window) => window.periodMs)).toEqual([
      undefined,
      SEVEN_DAYS_MS,
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
