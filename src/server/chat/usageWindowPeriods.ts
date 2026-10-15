// Plan-window period lengths (usage-bar-time-pace D1): which Claude meter
// kinds have a known fixed length, so the usage bar can mark how much of a
// window has elapsed. Server vocabulary like the window keys themselves — the
// client never maps kinds. A kind whose length is not known (overage, any
// provider quota row, a kind the server has not seen) gets none rather than a
// guess; no marker beats a wrong one.

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
