import { describe, expect, test } from 'bun:test'
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
