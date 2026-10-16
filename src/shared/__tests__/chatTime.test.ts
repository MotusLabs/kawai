import { describe, expect, test } from 'bun:test'
import { earliestTime, validTime } from '../chatTime'

describe('validTime', () => {
  test('parses ISO times and rejects empty, missing, and malformed values', () => {
    expect(validTime('2026-10-16T10:00:00.000Z')?.toISOString()).toBe('2026-10-16T10:00:00.000Z')
    expect(validTime('')).toBeNull()
    expect(validTime(undefined)).toBeNull()
    expect(validTime(null)).toBeNull()
    expect(validTime('not a date')).toBeNull()
  })
})

describe('earliestTime', () => {
  test('keeps the earlier valid time and prefers valid over unknown', () => {
    expect(earliestTime('2026-10-16T10:00:05Z', '2026-10-16T10:00:01Z')).toBe('2026-10-16T10:00:01Z')
    expect(earliestTime('2026-10-16T10:00:01Z', '2026-10-16T10:00:05Z')).toBe('2026-10-16T10:00:01Z')
    expect(earliestTime('', '2026-10-16T10:00:05Z')).toBe('2026-10-16T10:00:05Z')
    expect(earliestTime('2026-10-16T10:00:05Z', 'bad')).toBe('2026-10-16T10:00:05Z')
    expect(earliestTime('', '')).toBe('')
  })
})
