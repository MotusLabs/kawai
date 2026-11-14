// Provider quota-row period lengths (usage-bar-time-pace D1;
// zai-usage-window-periods D1-D3): which provider rows have a known length,
// so the usage bar can mark how much of a window has elapsed. Rows use the
// unit code the row itself states, observed codes only; a row whose length
// is not known gets none rather than a guess. Claude plan-window lengths are
// the public package's (@motuslabs/agent-runtime/usage windowPeriodMs).

const HOUR_MS = 60 * 60 * 1000

// Provider quota rows (Z.AI coding plan): the only unit codes the endpoint
// has been observed to send (2026-10-18), each confirmed by a reset horizon
// that fits; other codes would be guesses and stay unknown.
const PROVIDER_ROW_UNITS: Record<number, 'hour' | 'month'> = {
  3: 'hour',
  5: 'month',
}

/** A UTC timestamp moved by whole calendar months, day clamped to the target month's last. */
function addUtcMonths(ms: number, months: number): number {
  const from = new Date(ms)
  const targetMonth = from.getUTCMonth() + months
  const target = new Date(
    Date.UTC(
      from.getUTCFullYear(),
      targetMonth,
      1,
      from.getUTCHours(),
      from.getUTCMinutes(),
      from.getUTCSeconds(),
      from.getUTCMilliseconds()
    )
  )
  // Day 0 of the month after the target is the target month's last day.
  const lastDay = new Date(Date.UTC(from.getUTCFullYear(), targetMonth + 1, 0))
  target.setUTCDate(Math.min(from.getUTCDate(), lastDay.getUTCDate()))
  return target.getTime()
}

/**
 * Period length of a provider quota row from the unit and count the row
 * itself states: unit 3 counts hours, unit 5 counts calendar months measured
 * back from the reset in UTC with the day clamped to the target month's last
 * day (31 Mar → 28/29 Feb, same time of day). An unknown unit, a non-positive
 * or fractional count, or a missing/unusable reset gives undefined — no
 * period beats a wrong one. Values are used only as numbers: a string unit or
 * count is never coerced.
 */
export function providerRowPeriodMs(
  unit: unknown,
  count: unknown,
  resetsAtMs: unknown
): number | undefined {
  if (typeof resetsAtMs !== 'number' || !Number.isFinite(resetsAtMs)) return undefined
  if (typeof count !== 'number' || !Number.isInteger(count) || count <= 0) return undefined
  const unitName = typeof unit === 'number' ? PROVIDER_ROW_UNITS[unit] : undefined
  if (unitName === 'hour') return count * HOUR_MS
  if (unitName === 'month') return resetsAtMs - addUtcMonths(resetsAtMs, -count)
  return undefined
}

/**
 * Length word of an observed provider-row unit code ('hour' | 'month'), else
 * undefined — the same table providerRowPeriodMs reads, so a row's label and
 * its period can never disagree about what its unit means.
 */
export function providerRowUnitWord(unit: unknown): 'hour' | 'month' | undefined {
  return typeof unit === 'number' ? PROVIDER_ROW_UNITS[unit] : undefined
}
