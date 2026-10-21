// Codex usage normalization (codex-chat-sessions D9, PR E 7.1): tables pin
// the recorded wire shapes — the snapshot's primary/secondary windows, the
// read reply's extraction, the drop rule, the limited state, and the labels
// the usage bar renders.
import { describe, expect, test } from 'bun:test'
import type { RateLimitSnapshot } from '../chat/codex/protocol/v2/RateLimitSnapshot'
import { codexWindowLabel, normalizeRateLimitSnapshot, snapshotOfRateLimitsRead } from '../chat/codex/codexUsage'

const RECEIVED = '2026-10-21T12:00:00.000Z'

const snapshot = (over: Record<string, unknown> = {}): RateLimitSnapshot =>
  ({
    limitId: 'codex',
    limitName: null,
    normalModelSlug: null,
    primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: 1792337450 },
    secondary: { usedPercent: 12, windowDurationMins: 10080, resetsAt: 1792879251 },
    credits: null,
    individualLimit: null,
    spendControlReached: null,
    planType: 'plus',
    rateLimitReachedType: null,
    ...over,
  }) as RateLimitSnapshot

describe('normalizeRateLimitSnapshot', () => {
  test('primary and secondary windows render with their own identity', () => {
    const report = normalizeRateLimitSnapshot(snapshot(), RECEIVED)
    expect(report.status).toBe('allowed')
    expect(report.source).toBe('push')
    expect(report.receivedAt).toBe(RECEIVED)
    expect(report.windows).toEqual([
      { key: 'codex:primary', label: '5-hour', percentUsed: 40, resetsAt: new Date(1792337450 * 1000).toISOString(), periodMs: 300 * 60_000 },
      { key: 'codex:secondary', label: 'weekly', percentUsed: 12, resetsAt: new Date(1792879251 * 1000).toISOString(), periodMs: 10080 * 60_000 },
    ])
  })

  test('limit reached', () => {
    expect(normalizeRateLimitSnapshot(snapshot({ rateLimitReachedType: 'rate_limit_reached' })).status).toBe('limited')
    expect(normalizeRateLimitSnapshot(snapshot({ rateLimitReachedType: 'workspace_member_usage_limit_reached' })).status).toBe('limited')
  })

  test('a window without a usable percentage is dropped while the others render', () => {
    const dropped = normalizeRateLimitSnapshot(snapshot({ primary: { usedPercent: Number.NaN, windowDurationMins: 300, resetsAt: null } }))
    expect(dropped.windows.map(window => window.key)).toEqual(['codex:secondary'])
    expect(normalizeRateLimitSnapshot(snapshot({ primary: null, secondary: null })).windows).toEqual([])
    // An unknown window length renders without a period; a non-numeric one too.
    expect(normalizeRateLimitSnapshot(snapshot({ secondary: { usedPercent: 5, windowDurationMins: null, resetsAt: null } })).windows[1]).toEqual({
      key: 'codex:secondary', label: 'Window', percentUsed: 5, resetsAt: null,
    })
  })

  test('the label names the length, with Codex’s limit name when it gives one', () => {
    const named = normalizeRateLimitSnapshot(snapshot({ limitName: 'Codex Pro' }))
    expect(named.windows.map(window => window.label)).toEqual(['5-hour · Codex Pro', 'weekly · Codex Pro'])
    expect(codexWindowLabel(300)).toBe('5-hour')
    expect(codexWindowLabel(10080)).toBe('weekly')
    expect(codexWindowLabel(1440)).toBe('1-day')
    expect(codexWindowLabel(2880)).toBe('2-day')
    expect(codexWindowLabel(60)).toBe('1-hour')
    expect(codexWindowLabel(90)).toBe('90 min')
    expect(codexWindowLabel(45)).toBe('45 min')
    expect(codexWindowLabel(null)).toBe('Window')
    expect(codexWindowLabel(0)).toBe('Window')
  })

  test('the read reply supplies the snapshot; a reply without one does not', () => {
    const read = { ordinaryUsageAllowed: true, rateLimits: snapshot(), rateLimitsByLimitId: null, rateLimitResetCredits: null, accountId: null, rateLimitUpsell: null }
    expect(snapshotOfRateLimitsRead(read)).toEqual(snapshot())
    expect(snapshotOfRateLimitsRead({})).toBeNull()
    expect(snapshotOfRateLimitsRead({ rateLimits: null })).toBeNull()
    expect(snapshotOfRateLimitsRead(null)).toBeNull()
    // The fill read reports itself as a provider pull, not a push.
    expect(normalizeRateLimitSnapshot(snapshotOfRateLimitsRead(read), RECEIVED, 'provider').source).toBe('provider')
  })
})
