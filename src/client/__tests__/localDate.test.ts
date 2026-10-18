// The Audit tab's local-day helpers (execution-safety-recovery findings-
// 0f39baed L3): the date inputs speak the viewer's local zone. The suite
// runs under a non-UTC zone so a UTC-day regression cannot hide; Bun honors
// a runtime `process.env.TZ`, restored in afterEach.
import { afterEach, describe, expect, test } from 'bun:test'
import { localDayOf, localDayStart, toDisplayDay } from '../utils/localDate'

const realZone = process.env.TZ
afterEach(() => { process.env.TZ = realZone })

describe('local day helpers (L3, non-UTC)', () => {
  test('the UTC-prefixed day and the local day differ, and the helpers follow the zone', () => {
    process.env.TZ = 'America/New_York'
    // 03:30Z is the previous evening in New York: the local day is the 14th,
    // while the stamp's UTC prefix reads the 15th.
    expect(localDayOf('2026-01-15T03:30:00.000Z')).toBe('2026-01-14')
    // New York midnight of the 15th is 05:00Z.
    expect(localDayStart('2026-01-15')).toBe('2026-01-15T05:00:00.000Z')
    // The To bound is exclusive, so the input shows the day before it.
    expect(toDisplayDay('2026-01-16T05:00:00.000Z')).toBe('2026-01-15')
    // Parsing the displayed day back reaches the next local midnight.
    expect(localDayStart('2026-01-15', 1)).toBe('2026-01-16T05:00:00.000Z')
  })

  test('a zone ahead of UTC shifts the other way', () => {
    process.env.TZ = 'Asia/Tokyo'
    // 15:00Z is already the 16th in Tokyo (UTC+9, no DST).
    expect(localDayOf('2026-01-15T15:00:00.000Z')).toBe('2026-01-16')
    expect(localDayStart('2026-01-15')).toBe('2026-01-14T15:00:00.000Z')
  })

  test('a month and year boundary: the local day is the last day of the previous year (findings-1db27539 N-a)', () => {
    process.env.TZ = 'America/New_York'
    // 03:30Z on 1 January 2026 is 22:30 on 31 December 2025 in New York:
    // the UTC month, year, and date getters would each read 2026-01-01.
    expect(localDayOf('2026-01-01T03:30:00.000Z')).toBe('2025-12-31')
    // Single-digit months and days are zero-padded.
    expect(localDayOf('2026-03-05T12:00:00.000Z')).toBe('2026-03-05')
    // The To bound across the boundary: local midnight of 1 January shows 31 December.
    expect(toDisplayDay('2026-01-01T05:00:00.000Z')).toBe('2025-12-31')
  })
})
