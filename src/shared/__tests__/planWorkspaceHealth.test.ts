// D5's health derivation as the CP1 decision table (plan-workspace 3.3):
// every boundary row asserts each reading's level AND the combined dot,
// under a controlled clock. Strictness (CP1 rev 3, N6/N7): fresh while age
// ≤ 15 min, stale when older; a reset has passed when resetsAt ≤ now; an
// excluded reading (a host account's allowance behind a gateway provider,
// or unconfirmed routing) is kept whole and contributes unknown to the dot.
import { describe, expect, test } from 'bun:test'
import {
  combinedLevelOf, contextLevelOf, quotaLevelOf, workspaceHealthOf,
  type ReadingLevel,
} from '../planWorkspaceHealth'
import type { WorkspaceContextReading, WorkspaceQuotaReading } from '../planWorkspace'

const BASE = new Date('2026-10-23T00:00:00.000Z')
const MINUTE = 60_000

const ctx = (percent: number | null, ageMs = MINUTE): WorkspaceContextReading | null =>
  percent === null ? null : { used: percent / 100, measuredAt: new Date(BASE.getTime() - ageMs).toISOString() }

const quota = (over: Partial<WorkspaceQuotaReading> = {}): WorkspaceQuotaReading => ({
  status: 'ok', used: 0.5, resetsAt: null, measuredAt: new Date(BASE.getTime() - MINUTE).toISOString(), source: 'profile', ...over,
})

describe('the D5 boundary table', () => {
  test.each<[number, WorkspaceContextReading | null, WorkspaceQuotaReading | null, boolean, boolean, ReadingLevel, ReadingLevel, ReadingLevel]>([
    [1, ctx(69), quota(), true, true, 'green', 'green', 'green'],
    [2, ctx(70), quota(), true, true, 'yellow', 'green', 'yellow'],
    [3, ctx(89), quota(), true, true, 'yellow', 'green', 'yellow'],
    [4, ctx(90), quota(), true, true, 'red', 'green', 'red'],
    [5, ctx(99), quota(), true, true, 'red', 'green', 'red'],
    [6, ctx(100), quota(), true, true, 'red', 'green', 'red'],
    [7, ctx(50), quota({ used: 0.79 }), true, true, 'green', 'green', 'green'],
    [8, ctx(50), quota({ used: 0.8 }), true, true, 'green', 'yellow', 'yellow'],
    [9, ctx(50), quota({ used: 0.99 }), true, true, 'green', 'yellow', 'yellow'],
    [10, ctx(50), quota({ used: 1 }), true, true, 'green', 'red', 'red'],
    [11, ctx(50), quota({ status: 'warning', used: 0.5 }), true, true, 'green', 'yellow', 'yellow'],
    [12, ctx(50), quota({ status: 'limited', used: 0.5 }), true, true, 'green', 'red', 'red'],
    [13, ctx(null), quota({ status: 'limited' }), true, true, 'unknown', 'red', 'red'],
    [14, ctx(null), quota(), true, true, 'unknown', 'green', 'unknown'],
    [15, ctx(50), null, true, true, 'green', 'unknown', 'unknown'],
    [16, ctx(69, 15 * MINUTE), quota(), true, true, 'green', 'green', 'green'],
    [17, ctx(69, 15 * MINUTE + 1), quota(), true, true, 'unknown', 'green', 'unknown'],
    [18, ctx(69), quota({ resetsAt: BASE.toISOString() }), true, true, 'green', 'unknown', 'unknown'],
    [19, ctx(50), quota({ used: 0.8, source: 'account' }), false, true, 'green', 'yellow', 'unknown'],
    [20, ctx(90), quota({ source: 'account' }), false, true, 'red', 'green', 'red'],
    [21, ctx(69), quota(), true, false, 'unknown', 'unknown', 'unknown'],
    [22, ctx(50), quota({ used: 0.8, source: 'provider' }), true, true, 'green', 'yellow', 'yellow'],
    [23, ctx(50), quota({ used: 0.8, source: 'profile' }), true, true, 'green', 'yellow', 'yellow'],
    [24, ctx(50), quota({ status: 'warning', used: null }), true, true, 'green', 'yellow', 'yellow'],
    [25, ctx(50), quota({ status: 'limited', used: null }), true, true, 'green', 'red', 'red'],
    [26, ctx(50), quota({ used: null }), true, true, 'green', 'unknown', 'unknown'],
  ])('boundary %i: ctx %s / quota %s → ctx %s, quota %s, combined %s', (
    _n, context, quotaReading, applicable, connected, contextExpected, quotaExpected, combinedExpected,
  ) => {
    // Disconnected, both displayed reading states read unknown (row 21):
    // the levels §5 shows are the derivation's, masked by the disconnect.
    const ctxShown = connected ? contextLevelOf(context, BASE) : 'unknown'
    const quotaShown = connected ? quotaLevelOf(quotaReading, BASE) : 'unknown'
    expect(ctxShown).toBe(contextExpected)
    expect(quotaShown).toBe(quotaExpected)
    expect(combinedLevelOf(contextExpected, quotaExpected, applicable)).toBe(combinedExpected)
    expect(workspaceHealthOf({ context, quota: quotaReading, quotaApplicable: applicable, connected }, BASE).level)
      .toBe(combinedExpected)
  })

  test('details keep an approximate threshold approximate: a 0.699 share reads green and keeps its raw value', () => {
    const context: WorkspaceContextReading = { used: 0.699, measuredAt: new Date(BASE.getTime() - MINUTE).toISOString() }
    const health = workspaceHealthOf({ context, quota: quota(), quotaApplicable: true, connected: true }, BASE)
    // The band is green, but the derivation never quantizes the value §5's
    // popover and accessible label render — the threshold stays approximate.
    expect(health.level).toBe('green')
    expect(health.context).toEqual(context)
  })

  test('a disconnected workspace keeps both readings inspectable at unknown', () => {
    const health = workspaceHealthOf({ context: ctx(10), quota: quota({ status: 'limited' }), quotaApplicable: true, connected: false }, BASE)
    expect(health.level).toBe('unknown')
    expect(health.context).toEqual(ctx(10))
    expect(health.quota).toEqual(quota({ status: 'limited' }))
  })

  test('a missing measurement time is unknown, never fresh', () => {
    expect(contextLevelOf({ used: 0.1, measuredAt: null }, BASE)).toBe('unknown')
    expect(quotaLevelOf(quota({ measuredAt: null }), BASE)).toBe('unknown')
  })
})
