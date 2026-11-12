// The one input-boundary change of the usage-helper migration (task-dbc1481b
// R2 A4/A8): Kawai's reset callers use the public package's toIsoResetsAt, so
// a numeric epoch-seconds reset outside Date's representable range reads as
// no reset (null) instead of throwing RangeError. Representable epochs,
// including both ±8.64e12 s boundaries, and valid ISO strings keep their exact
// results, and each affected caller keeps every other report and limit fact.
import { describe, expect, test } from 'bun:test'
import { toIsoResetsAt } from '@motuslabs/agent-runtime/usage'
import { codexRetryLimitSignal, codexTurnLimitSignal, latestExhaustedReset } from '../chat/codex/codexLimits'
import { normalizeRateLimitSnapshot } from '../chat/codex/codexUsage'
import type { RateLimitSnapshot } from '../chat/codex/protocol/v2/RateLimitSnapshot'
import { parseOpenRouterKey } from '../chat/openRouterUsage'

const MAX_EPOCH_S = 8.64e12
const OVERFLOWS = [1e13, -1e13, MAX_EPOCH_S + 1, -(MAX_EPOCH_S + 1)]
const ORDINARY_S = 1_800_000_000
const ORDINARY_ISO = '2027-01-15T08:00:00.000Z'
const AT = '2026-11-12T16:00:00.000Z'

/** A snapshot whose primary and secondary windows reset at the given epochs. */
function snapshot(primaryReset: unknown, secondaryReset: unknown, usedPercent = 100): RateLimitSnapshot {
  return {
    limitId: null,
    limitName: 'GPT',
    primary: { usedPercent, windowDurationMins: 300, resetsAt: primaryReset },
    secondary: { usedPercent, windowDurationMins: 10080, resetsAt: secondaryReset },
    credits: null,
    planType: null,
    rateLimitReachedType: 'rate_limit_reached',
  } as unknown as RateLimitSnapshot
}

describe('reset epochs outside the Date range', () => {
  test('overflowing epochs read as null without throwing; the boundaries and ordinary values stay exact', () => {
    for (const value of OVERFLOWS) expect({ value, iso: toIsoResetsAt(value) }).toEqual({ value, iso: null })
    expect(toIsoResetsAt(MAX_EPOCH_S)).toBe('+275760-09-13T00:00:00.000Z')
    expect(toIsoResetsAt(-MAX_EPOCH_S)).toBe('-271821-04-20T00:00:00.000Z')
    expect(toIsoResetsAt(ORDINARY_S)).toBe(new Date(ORDINARY_S * 1000).toISOString())
    expect(toIsoResetsAt(ORDINARY_ISO)).toBe(ORDINARY_ISO)
  })

  test('a Codex usage report keeps every other window fact when a reset overflows', () => {
    for (const value of OVERFLOWS) {
      const report = normalizeRateLimitSnapshot(snapshot(value, ORDINARY_S, 40), AT, 'provider')
      expect({ value, report }).toEqual({
        value,
        report: {
          status: 'limited',
          windows: [
            { key: 'codex:primary', label: '5-hour · GPT', percentUsed: 40, resetsAt: null, periodMs: 300 * 60_000 },
            { key: 'codex:secondary', label: 'weekly · GPT', percentUsed: 40, resetsAt: new Date(ORDINARY_S * 1000).toISOString(), periodMs: 10080 * 60_000 },
          ],
          receivedAt: AT,
          source: 'provider',
        },
      })
    }
  })

  test('a Codex limit signal skips an overflowing reset and keeps the latest representable one', () => {
    const ordinary = new Date(ORDINARY_S * 1000).toISOString()
    for (const value of OVERFLOWS) {
      expect({ value, reset: latestExhaustedReset(snapshot(value, ORDINARY_S)) }).toEqual({ value, reset: ordinary })
      expect({ value, reset: latestExhaustedReset(snapshot(value, value)) }).toEqual({ value, reset: null })
      const failed = { status: 'failed', error: { codexErrorInfo: 'usageLimitExceeded', message: 'Usage limit reached' } }
      expect(codexTurnLimitSignal(failed, snapshot(value, ORDINARY_S))).toEqual({
        kind: 'usageLimitExceeded', final: true, status: null, message: 'Usage limit reached', resetsAt: ordinary, window: null,
      })
      const retrying = { willRetry: true, error: { codexErrorInfo: 'rateLimitExceeded', message: 'slow down' } }
      expect(codexRetryLimitSignal(retrying, snapshot(value, value))).toEqual({
        kind: 'rateLimitExceeded', final: false, status: null, message: 'slow down', resetsAt: null, window: null,
      })
    }
  })

  test('an OpenRouter budget with an overflowing reset keeps its meter and reads no reset', () => {
    const body = (resetsAt: unknown) => ({
      budgets: [{ scope: 'daily', budget_id: 'b1', limit_usd: 10, spend_usd: 2.5, remaining_usd: 7.5, reset_interval: 'daily', resets_at: resetsAt }],
    })
    const reference = parseOpenRouterKey(body(ORDINARY_ISO), AT)
    expect(reference?.report.windows[0]?.resetsAt).toBe(ORDINARY_ISO)
    for (const value of OVERFLOWS) {
      const parsed = parseOpenRouterKey(body(value), AT)
      expect({ value, parsed }).toEqual({
        value,
        parsed: {
          remainingUsd: reference!.remainingUsd,
          report: { ...reference!.report, windows: [{ ...reference!.report.windows[0]!, resetsAt: null }] },
        },
      })
    }
    expect(parseOpenRouterKey(body(MAX_EPOCH_S), AT)?.report.windows[0]?.resetsAt).toBe('+275760-09-13T00:00:00.000Z')
  })
})
