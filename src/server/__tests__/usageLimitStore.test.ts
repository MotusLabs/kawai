import { describe, expect, test } from 'bun:test'
import type { ChatUsageReport } from '../../shared/chat'
import { UsageLimitStore } from '../chat/usageLimits'

const AT = '2026-10-07T13:00:00.000Z'
const FIVE_HOUR_RESET = '2026-10-07T18:11:04.000Z'

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
