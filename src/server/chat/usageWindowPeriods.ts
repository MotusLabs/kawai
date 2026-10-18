// Usage-window period lengths (usage-bar-time-pace D1; provider rows
// zai-usage-window-periods D1–D3): which windows have a known length, so the
// usage bar can mark how much of a window has elapsed. Server vocabulary like
// the window keys themselves — the client never maps kinds. Claude plan kinds
// use a fixed table; provider quota rows use the unit code the row itself
// states, observed codes only. A window whose length is not known (overage,
// an unknown provider unit, a kind the server has not seen) gets none rather
// than a guess; no marker beats a wrong one.

const HOUR_MS = 60 * 60 * 1000
const FIVE_HOURS_MS = 5 * HOUR_MS
const SEVEN_DAYS_MS = 7 * 24 * HOUR_MS

/**
 * Base meter kind → period. Push and pull name the windows five_hour /
 * seven_day*; the /usage endpoint names the same windows session /
 * weekly_all / weekly_scoped; pull's per-model rows key as model_scoped.
 */
const KIND_PERIODS_MS: Record<string, number> = {
  five_hour: FIVE_HOURS_MS,
  session: FIVE_HOURS_MS,
  seven_day: SEVEN_DAYS_MS,
  seven_day_opus: SEVEN_DAYS_MS,
  seven_day_sonnet: SEVEN_DAYS_MS,
  seven_day_oauth_apps: SEVEN_DAYS_MS,
  seven_day_overage_included: SEVEN_DAYS_MS,
  weekly_all: SEVEN_DAYS_MS,
  weekly_scoped: SEVEN_DAYS_MS,
  model_scoped: SEVEN_DAYS_MS,
}

/** A /usage row group → period, consulted only for kinds the table lacks. */
const GROUP_PERIODS_MS: Record<string, number> = {
  session: FIVE_HOURS_MS,
  weekly: SEVEN_DAYS_MS,
}

/**
 * Period length of a Claude plan window keyed `kind`, `kind:<scope>`, or
 * `kind#n`, falling back to a /usage row's group when the kind is unknown;
 * undefined when neither is known.
 */
export function windowPeriodMs(key: string, group?: string): number | undefined {
  const base = key.split(/[:#]/, 1)[0] ?? key
  return KIND_PERIODS_MS[base] ?? (group ? GROUP_PERIODS_MS[group] : undefined)
}

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
