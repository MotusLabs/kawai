import { describe, expect, spyOn, test } from 'bun:test'
import { chatDayKey, chatDayLabel, chatTimeLabels } from '../utils/chatTimeFormat'

describe('chat time labels (chat-transcript-layout D2)', () => {
  test('a fixed zone shows the local clock and a full date, time, and zone', () => {
    const labels = chatTimeLabels('2026-10-15T23:30:00.000Z', 'Asia/Shanghai')!
    expect(labels.iso).toBe('2026-10-15T23:30:00.000Z')
    expect(labels.clock).toMatch(/07:30/)
    expect(labels.full).toMatch(/October 16, 2026/)
    expect(labels.full).toMatch(/GMT\+8|CST/)
  })

  test('the same instant sits on different local days across midnight', () => {
    expect(chatDayKey('2026-10-15T23:30:00.000Z', 'UTC')).toBe('2026-10-15')
    expect(chatDayKey('2026-10-15T23:30:00.000Z', 'Asia/Shanghai')).toBe('2026-10-16')
    expect(chatDayLabel('2026-10-16T00:10:00.000Z', 'UTC')).toMatch(/Friday, October 16, 2026/)
  })

  test('unknown and malformed times format to nothing, never Invalid Date', () => {
    for (const at of ['', 'garbage']) {
      expect(chatTimeLabels(at)).toBeNull()
      expect(chatDayKey(at)).toBeNull()
      expect(chatDayLabel(at)).toBeNull()
    }
  })
})

test('formatter construction stays bounded by contexts, not history length', () => {
  const Original = Intl.DateTimeFormat
  const construct = spyOn(Intl, 'DateTimeFormat').mockImplementation(new Proxy(Original, { construct: (target, args) => Reflect.construct(target, args) }))
  try {
    // Two passes also settle partially cached contexts at FIFO capacity.
    const warmAt = '2026-10-15T23:30:00Z'
    for (let pass = 0; pass < 2; pass++) {
      chatTimeLabels(warmAt, 'Pacific/Auckland')
      chatDayKey(warmAt, 'Pacific/Auckland')
      chatDayLabel(warmAt, 'Pacific/Auckland')
    }
    construct.mockClear()
    for (let i = 0; i < 500; i++) {
      const at = new Date(Date.UTC(2026, 9, 15, 10, i)).toISOString()
      chatTimeLabels(at, 'Pacific/Auckland')
      chatDayKey(at, 'Pacific/Auckland')
      chatDayLabel(at, 'Pacific/Auckland')
    }
    expect(construct.mock.calls.length).toBe(0)
    const defaultLabels = chatTimeLabels('2026-10-15T23:30:00Z')
    chatTimeLabels('2026-10-15T23:30:00Z', 'America/New_York')
    expect(chatTimeLabels('2026-10-15T23:30:00Z')).toEqual(defaultLabels)
    // Arbitrary explicit zones cannot grow the cache indefinitely.
    for (const zone of Intl.supportedValuesOf('timeZone').slice(0, 40)) chatDayKey('2026-10-15T23:30:00Z', zone)
    const before = construct.mock.calls.length
    chatDayKey('2026-10-15T23:30:00Z', 'Pacific/Auckland')
    expect(construct.mock.calls.length).toBe(before + 1)
    expect(chatDayKey('2026-10-15T23:30:00Z', 'Pacific/Auckland')).toBe('2026-10-16')
  } finally { construct.mockRestore() }
})
