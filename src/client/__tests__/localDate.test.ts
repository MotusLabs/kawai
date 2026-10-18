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

// The 5-point invariant over every day of 2026 (findings-11730e60; plan in
// note-83926219): S and B are the first instants of D and D+1, the To input
// shows D for B, re-picking it reaches B again, and B − S is the day's real
// length. Santiago's DST shifts fall at midnight, Lord_Howe's by 30 minutes;
// the exact count of non-24 h days proves the sweep met the DST days.
const HOUR = 60 * 60 * 1000
const days2026 = Array.from({ length: 365 }, (_, i) => new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10))
const SHORT_OR_LONG: Record<string, number> = {
  UTC: 0, 'America/New_York': 2, 'America/Santiago': 2, 'Australia/Lord_Howe': 2, 'Asia/Kolkata': 0,
}

describe('every 2026 day in five zones (findings-11730e60)', () => {
  for (const [zone, expectedOdd] of Object.entries(SHORT_OR_LONG)) {
    test(zone, () => {
      process.env.TZ = zone
      const odd: string[] = []
      for (const [index, day] of days2026.entries()) {
        const next = new Date(Date.UTC(2026, 0, 2 + index)).toISOString().slice(0, 10)
        const previous = new Date(Date.UTC(2026, 0, index)).toISOString().slice(0, 10)
        const start = localDayStart(day)
        const bound = localDayStart(day, 1)
        // 1. S and B are the first instants of D and D+1.
        expect([localDayOf(new Date(Date.parse(start) - 1).toISOString()), localDayOf(start)]).toEqual([previous, day])
        expect([localDayOf(new Date(Date.parse(bound) - 1).toISOString()), localDayOf(bound)]).toEqual([day, next])
        // 2–4. S shows D, the To input shows D for B, and re-picking it reaches B.
        expect([localDayOf(start), toDisplayDay(bound), localDayStart(toDisplayDay(bound), 1)]).toEqual([day, day, bound])
        // 5. B − S is the day's real length.
        const hours = (Date.parse(bound) - Date.parse(start)) / HOUR
        expect([23, 23.5, 24, 24.5, 25]).toContain(hours)
        if (hours !== 24) odd.push(`${day}:${hours}`)
      }
      expect(odd).toHaveLength(expectedOdd)
    })
  }

  test('the DST days met are the expected ones', () => {
    process.env.TZ = 'America/New_York'
    expect(toDisplayDay(localDayStart('2026-03-08', 1))).toBe('2026-03-08')
    expect(toDisplayDay('2026-03-09T04:00:00.000Z')).toBe('2026-03-08')
    expect(toDisplayDay('2026-11-02T05:00:00.000Z')).toBe('2026-11-01')
    process.env.TZ = 'America/Santiago'
    expect(toDisplayDay(localDayStart('2026-09-06', 1))).toBe('2026-09-06')
    process.env.TZ = 'Australia/Lord_Howe'
    expect(toDisplayDay(localDayStart('2026-10-04', 1))).toBe('2026-10-04')
  })
})
