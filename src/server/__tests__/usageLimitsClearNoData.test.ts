// UsageLimitStore.clearAndRecordNoData (openrouter-provider follow-up N3):
// a successful OpenRouter pull that carried no meters is authoritative — it
// must clear a held report so stale meters do not outlive the key's limit —
// while recordNoData keeps its "only when nothing is held" meaning for every
// other caller, including the SDK gap-fill.
import { describe, expect, test } from 'bun:test'
import type { ChatUsageReport } from '../../shared/chat'
import { UsageLimitStore } from '../chat/usageLimits'

const AT = '2026-10-07T13:00:00.000Z'
const CLEARED_AT = '2026-10-07T16:00:00.000Z'

function report(overrides: Partial<ChatUsageReport> = {}): ChatUsageReport {
  return {
    status: 'allowed',
    windows: [
      { key: 'openrouter:key_limit', label: 'Key cap · $0.04 left', percentUsed: 20, resetsAt: null },
    ],
    receivedAt: AT,
    ...overrides,
  }
}

function recorder(store: UsageLimitStore) {
  const seen: Array<{ providerId: string; report: ChatUsageReport | null }> = []
  store.subscribe((providerId, rep) => seen.push({ providerId, report: rep }))
  return seen
}

describe('UsageLimitStore.clearAndRecordNoData', () => {
  test('a held report is cleared: no windows remain, the no-data verdict stands, listeners hear once', () => {
    const store = new UsageLimitStore()
    const seen = recorder(store)
    store.record('openrouter', report())
    seen.length = 0

    store.clearAndRecordNoData('openrouter', CLEARED_AT)

    expect(store.get('openrouter')).toBeNull()
    // The verdict suppresses the gap-fill pull, like recordNoData's.
    expect(store.claimPull('openrouter')).toBe(false)
    expect(seen).toEqual([{ providerId: 'openrouter', report: null }])
    // Nothing is held any more: a later windowless push keeps no old windows.
    store.record('openrouter', report({ windows: [], receivedAt: '2026-10-07T17:00:00.000Z' }))
    expect(store.get('openrouter')).toEqual({
      status: 'allowed',
      windows: [],
      receivedAt: '2026-10-07T17:00:00.000Z',
    })
  })

  test('a later record with meters replaces the verdict, so the bar returns', () => {
    const store = new UsageLimitStore()
    store.record('openrouter', report())
    store.clearAndRecordNoData('openrouter', CLEARED_AT)
    expect(store.get('openrouter')).toBeNull()

    store.record('openrouter', report({ receivedAt: '2026-10-07T17:00:00.000Z' }))
    expect(store.get('openrouter')?.windows).toEqual(report().windows)
  })

  test('a zero-meter pull older than the held report leaves the report held', () => {
    const store = new UsageLimitStore()
    const seen = recorder(store)
    store.record('openrouter', report({ receivedAt: '2026-10-07T17:00:00.000Z' }))
    seen.length = 0

    // Mirrors record's ordering guard: an older pull never displaces
    // newer held data.
    store.clearAndRecordNoData('openrouter', '2026-10-07T16:00:00.000Z')

    expect(store.get('openrouter')?.receivedAt).toBe('2026-10-07T17:00:00.000Z')
    expect(store.get('openrouter')?.windows).toEqual(report().windows)
    expect(seen).toEqual([])
  })

  test('with nothing held it behaves like recordNoData', () => {
    const cleared = new UsageLimitStore()
    const noop = new UsageLimitStore()
    const seenCleared = recorder(cleared)
    const seenNoop = recorder(noop)

    cleared.clearAndRecordNoData('openrouter', AT)
    noop.recordNoData('openrouter', AT)

    expect(seenCleared).toEqual(seenNoop)
    expect(cleared.get('openrouter')).toEqual(noop.get('openrouter'))
    expect(cleared.claimPull('openrouter')).toBe(noop.claimPull('openrouter'))
    // Both carry a verdict: a windowless push keeps no held windows in either.
    cleared.record('openrouter', report({ windows: [], receivedAt: '2026-10-07T17:00:00.000Z' }))
    noop.record('openrouter', report({ windows: [], receivedAt: '2026-10-07T17:00:00.000Z' }))
    expect(cleared.get('openrouter')).toEqual(noop.get('openrouter'))
  })

  test('with a verdict already standing and nothing held it is a no-op, like recordNoData', () => {
    const store = new UsageLimitStore()
    const seen = recorder(store)
    store.recordNoData('openrouter', AT)
    seen.length = 0

    store.clearAndRecordNoData('openrouter', CLEARED_AT)

    expect(seen).toEqual([])
    expect(store.get('openrouter')).toBeNull()
  })
})
