import { describe, expect, test } from 'bun:test'
import { providerRowPeriodMs } from '../chat/usageWindowPeriods'

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

describe('providerRowPeriodMs', () => {
  // The live TIME_LIMIT reset (2026-10-18 capture): 3 Nov, 10:23 UTC.
  const NOV_3 = Date.parse('2026-11-03T10:23:19.997Z')

  test('unit 3 counts hours', () => {
    expect(providerRowPeriodMs(3, 5, NOV_3)).toBe(5 * HOUR_MS)
    expect(providerRowPeriodMs(3, 1, NOV_3)).toBe(HOUR_MS)
  })

  test('unit 5 counts one calendar month back from the reset (Nov 3 → Oct 3)', () => {
    const period = providerRowPeriodMs(5, 1, NOV_3)
    expect(period).toBe(31 * DAY_MS) // Oct 3 → Nov 3
    expect(NOV_3 - period!).toBe(Date.parse('2026-10-03T10:23:19.997Z'))
  })

  test('unit 5 counts two calendar months (Nov 3 → Sep 3)', () => {
    const period = providerRowPeriodMs(5, 2, NOV_3)
    expect(period).toBe(61 * DAY_MS) // Sep 3 → Nov 3 (30 + 31 days)
    expect(NOV_3 - period!).toBe(Date.parse('2026-09-03T10:23:19.997Z'))
  })

  test('a reset on the 31st clamps to the day the previous month ends on, same time of day', () => {
    // 2027 is a common year: 31 Mar starts 28 Feb.
    const mar31 = Date.parse('2027-03-31T09:00:00.000Z')
    const commonPeriod = providerRowPeriodMs(5, 1, mar31)
    expect(mar31 - commonPeriod!).toBe(Date.parse('2027-02-28T09:00:00.000Z'))
    expect(commonPeriod).toBe(31 * DAY_MS) // Feb 28 → Mar 31
    // 2028 is a leap year: 31 Mar starts 29 Feb.
    const mar31Leap = Date.parse('2028-03-31T09:00:00.000Z')
    const leapPeriod = providerRowPeriodMs(5, 1, mar31Leap)
    expect(mar31Leap - leapPeriod!).toBe(Date.parse('2028-02-29T09:00:00.000Z'))
    expect(leapPeriod).toBe(31 * DAY_MS) // Feb 29 → Mar 31
  })

  test('an unknown unit gives no period, even with a known count and reset', () => {
    expect(providerRowPeriodMs(7, 2, NOV_3)).toBeUndefined()
    expect(providerRowPeriodMs(1, 30, NOV_3)).toBeUndefined()
    expect(providerRowPeriodMs(4, 7, NOV_3)).toBeUndefined()
  })

  test('unit and count are used only as numbers — no string coercion', () => {
    expect(providerRowPeriodMs('3', 5, NOV_3)).toBeUndefined()
    expect(providerRowPeriodMs(3, '5' as unknown as number, NOV_3)).toBeUndefined()
    expect(providerRowPeriodMs(undefined, 5, NOV_3)).toBeUndefined()
    expect(providerRowPeriodMs(3, undefined, NOV_3)).toBeUndefined()
    expect(providerRowPeriodMs(null, 5, NOV_3)).toBeUndefined()
  })

  test('a non-positive or fractional count gives no period', () => {
    expect(providerRowPeriodMs(3, 0, NOV_3)).toBeUndefined()
    expect(providerRowPeriodMs(5, -1, NOV_3)).toBeUndefined()
    expect(providerRowPeriodMs(3, 1.5, NOV_3)).toBeUndefined()
  })

  test('a missing or unusable reset gives no period', () => {
    expect(providerRowPeriodMs(3, 5, undefined)).toBeUndefined()
    expect(providerRowPeriodMs(3, 5, null)).toBeUndefined()
    expect(providerRowPeriodMs(3, 5, Number.NaN)).toBeUndefined()
    expect(providerRowPeriodMs(3, 5, '2026-11-03T10:23:19.997Z')).toBeUndefined()
  })
})
