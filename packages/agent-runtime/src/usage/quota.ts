// Quota reports (design §6, tasks 5.2/5.3; from Kawai's committed
// usageLimits.ts parsers, usageWindowPeriods.ts and codex/codexUsage.ts).
// Pure and SDK-free; sources are matched structurally.
// - Claude: a pushed rate_limit_event (source `push`), the /usage report
//   carried on an assistant frame (`report`), and the SDK's experimental usage
//   pull (`host-login-pull`: the supplied home's login, which can be another
//   account than a proxy session's).
// - Codex: the app-server's RateLimitSnapshot, pushed (`push`) or read once
//   (`report`), both the session's own login.
// - A host's own quota read can be labelled with `hostQuotaReport`
//   (`host-supplied`).
// Every report is independent of turn state. A value outside its documented
// range drops its window instead of rendering wrong; a window length is
// reported only when known (null, never guessed).
import type { QuotaReport, QuotaSource, QuotaStatus, QuotaWindow } from './types.js'

const HOUR_MS = 60 * 60 * 1000
const FIVE_HOURS_MS = 5 * HOUR_MS
const SEVEN_DAYS_MS = 7 * 24 * HOUR_MS

/** Claude meter kind -> period: push/pull name five_hour/seven_day*, /usage session/weekly_*. */
const KIND_PERIODS_MS = new Map<string, number>([
  ['five_hour', FIVE_HOURS_MS], ['session', FIVE_HOURS_MS], ['seven_day', SEVEN_DAYS_MS], ['seven_day_opus', SEVEN_DAYS_MS],
  ['seven_day_sonnet', SEVEN_DAYS_MS], ['seven_day_oauth_apps', SEVEN_DAYS_MS], ['seven_day_overage_included', SEVEN_DAYS_MS],
  ['weekly_all', SEVEN_DAYS_MS], ['weekly_scoped', SEVEN_DAYS_MS], ['model_scoped', SEVEN_DAYS_MS],
])
/** A /usage row group -> period, for kinds the table lacks. */
const GROUP_PERIODS_MS = new Map<string, number>([['session', FIVE_HOURS_MS], ['weekly', SEVEN_DAYS_MS]])

/** Period of a Claude plan window keyed `kind`, `kind:<scope>` or `kind#n`, else its row group's; null when neither is known. */
export function windowPeriodMs(key: string, group?: string): number | null {
  const base = key.split(/[:#]/, 1)[0] ?? key
  return KIND_PERIODS_MS.get(base) ?? (group === undefined ? undefined : GROUP_PERIODS_MS.get(group)) ?? null
}

const WINDOW_LABELS = new Map<string, string>([
  ['five_hour', '5-hour window'], ['seven_day', '7-day window'], ['seven_day_opus', '7-day Opus window'],
  ['seven_day_sonnet', '7-day Sonnet window'], ['seven_day_oauth_apps', '7-day OAuth apps window'],
  ['seven_day_overage_included', '7-day overage-included window'], ['overage', 'Overage'], ['session', '5-hour window'], ['weekly_all', '7-day window'],
])
const windowLabel = (key: string): string => WINDOW_LABELS.get(key) ?? key

/** Percent 0-100 from a 0-1 fraction; null when unusable. */
function fractionToPercent(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) return null
  return Math.round(value * 100 * 100) / 100
}

/** Percent 0-100 from a source already in percent; null when unusable. */
export function percentValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null
}

/** ISO time of epoch seconds; null when not a number or outside the representable date range (total: never throws). */
export function epochSecondsIso(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  const date = new Date(value * 1000)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

/** ISO reset time from epoch seconds or an ISO string; null when unusable. */
export function toIsoResetsAt(value: unknown): string | null {
  if (typeof value === 'number') return epochSecondsIso(value)
  if (typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Date.parse(value))) return value
  return null
}

const STATUS_RANK: Record<QuotaStatus, number> = { allowed: 0, warning: 1, limited: 2 }
const worst = (a: QuotaStatus, b: QuotaStatus): QuotaStatus => (STATUS_RANK[b] > STATUS_RANK[a] ? b : a)

function planWindow(key: string, label: string, percentUsed: number, resetsAt: unknown, group?: string): QuotaWindow {
  return { key, label, percentUsed, resetsAt: toIsoResetsAt(resetsAt), periodMs: windowPeriodMs(key, group) }
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** A Claude-scoped report: the session's own login. */
function report(status: QuotaStatus, windows: QuotaWindow[], receivedAt: string, source: QuotaSource): QuotaReport {
  return { status, windows, receivedAt, source, accountScope: source === 'host-login-pull' ? 'host-login' : 'session' }
}

/**
 * A pushed rate_limit_event's info. `unifiedWindows` (both windows, 0-1
 * fractions) is preferred; the event's own `rateLimitType` window is added
 * when not already covered. A status-only event yields no windows.
 */
export function parseRateLimitEvent(info: unknown, receivedAt = new Date().toISOString()): QuotaReport {
  const slice = isObject(info) ? info : {}
  const windows: QuotaWindow[] = []
  const fraction = (key: unknown, value: unknown) => {
    if (typeof key !== 'string' || key === '' || !isObject(value)) return
    const percent = fractionToPercent(value.utilization)
    if (percent !== null && !windows.some((window) => window.key === key)) windows.push(planWindow(key, windowLabel(key), percent, value.resetsAt))
  }
  if (isObject(slice.unifiedWindows)) for (const [key, value] of Object.entries(slice.unifiedWindows)) fraction(key, value)
  fraction(slice.rateLimitType, slice)
  const status: QuotaStatus = slice.status === 'allowed_warning' ? 'warning' : slice.status === 'rejected' ? 'limited' : 'allowed'
  return report(status, windows, receivedAt, 'push')
}

/**
 * A /usage report's structured twin (an assistant frame's `usage_report`).
 * Rows key by meter kind (a scoped row appends its scope label); the status is
 * the worst row severity. Null when the report carries no limits at all.
 */
export function parseUsageReport(usageReport: unknown, receivedAt = new Date().toISOString()): QuotaReport | null {
  const limits = isObject(usageReport) && isObject(usageReport.rate_limits) ? usageReport.rate_limits.limits : undefined
  if (!Array.isArray(limits)) return null
  const windows: QuotaWindow[] = []
  let status: QuotaStatus = 'allowed'
  for (const row of limits) {
    if (!isObject(row)) continue
    const percent = percentValue(row.percent)
    if (percent === null || typeof row.kind !== 'string' || row.kind === '') continue
    const scope = isObject(row.scope) ? row.scope : {}
    const named = (part: unknown) => (isObject(part) && typeof part.display_name === 'string' && part.display_name ? part.display_name : undefined)
    const scopeLabel = named(scope.model) ?? named(scope.surface)
    const key = scopeLabel ? `${row.kind}:${scopeLabel}` : row.kind
    const label = scopeLabel ?? (typeof row.label === 'string' && row.label ? row.label : windowLabel(key))
    windows.push(planWindow(key, label, percent, row.resets_at, typeof row.group === 'string' ? row.group : undefined))
    status = worst(status, row.severity === 'warning' ? 'warning' : row.severity === 'critical' ? 'limited' : 'allowed')
  }
  return report(status, windows, receivedAt, 'report')
}

const PULL_WINDOW_KINDS = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet', 'seven_day_oauth_apps'] as const

/**
 * The SDK usage pull's reply (the supplied home's login). Null when plan
 * limits do not apply or none came back; the pull carries no severity.
 */
export function parseUsagePull(response: unknown, receivedAt = new Date().toISOString()): QuotaReport | null {
  if (!isObject(response) || response.rate_limits_available === false || !isObject(response.rate_limits)) return null
  const limits = response.rate_limits
  const windows: QuotaWindow[] = []
  const percentWindow = (key: string, slice: unknown, label: string) => {
    const percent = isObject(slice) ? percentValue(slice.utilization) : null
    if (percent !== null && isObject(slice)) windows.push(planWindow(key, label, percent, slice.resets_at))
  }
  for (const key of PULL_WINDOW_KINDS) percentWindow(key, limits[key], windowLabel(key))
  if (Array.isArray(limits.model_scoped)) {
    for (const row of limits.model_scoped) {
      if (isObject(row) && typeof row.display_name === 'string' && row.display_name) percentWindow(`model_scoped:${row.display_name}`, row, row.display_name)
    }
  }
  return report('allowed', windows, receivedAt, 'host-login-pull')
}

/** A Codex window length label (300 -> 5-hour, 10080 -> weekly). */
export function codexWindowLabel(mins: number | null): string {
  if (mins === null || !Number.isFinite(mins) || mins <= 0) return 'Window'
  if (mins === 300) return '5-hour'
  if (mins === 10080) return 'weekly'
  if (mins % 1440 === 0) return `${mins / 1440}-day`
  if (mins % 60 === 0) return `${mins / 60}-hour`
  return `${mins} min`
}

function codexWindow(key: string, raw: unknown, limitName: unknown): QuotaWindow | null {
  if (!isObject(raw)) return null
  const percent = percentValue(raw.usedPercent)
  if (percent === null) return null
  const mins = typeof raw.windowDurationMins === 'number' && Number.isFinite(raw.windowDurationMins) && raw.windowDurationMins > 0 ? raw.windowDurationMins : null
  const name = typeof limitName === 'string' && limitName.trim() ? limitName.trim() : null
  const label = codexWindowLabel(mins)
  return { key, label: name ? `${label} · ${name}` : label, percentUsed: percent, resetsAt: toIsoResetsAt(raw.resetsAt), periodMs: mins === null ? null : mins * 60_000 }
}

/**
 * A Codex RateLimitSnapshot: `codex:primary`/`codex:secondary`, limited while
 * rateLimitReachedType is set. `source` is `push` for account/rateLimits/updated
 * and `report` for the read reply; both describe the session's own login.
 */
export function codexQuotaReport(snapshot: unknown, source: 'push' | 'report', receivedAt = new Date().toISOString()): QuotaReport {
  const slice = isObject(snapshot) ? snapshot : {}
  const windows = [codexWindow('codex:primary', slice.primary, slice.limitName), codexWindow('codex:secondary', slice.secondary, slice.limitName)].filter((w): w is QuotaWindow => w !== null)
  return { status: slice.rateLimitReachedType != null ? 'limited' : 'allowed', windows, receivedAt, source, accountScope: 'session' }
}

/** The snapshot of an account/rateLimits/read reply, or null. */
export function codexReadSnapshot(result: unknown): Record<string, unknown> | null {
  return isObject(result) && isObject(result.rateLimits) ? result.rateLimits : null
}

/** The latest reset among a Codex snapshot's exhausted windows (a valid used percent of 100), as ISO; null when none. */
export function codexExhaustedReset(snapshot: unknown): string | null {
  let latest: string | null = null
  const slice = isObject(snapshot) ? snapshot : {}
  for (const raw of [slice.primary, slice.secondary]) {
    if (!isObject(raw) || percentValue(raw.usedPercent) !== 100) continue
    const reset = toIsoResetsAt(raw.resetsAt)
    if (reset && (latest === null || Date.parse(reset) > Date.parse(latest))) latest = reset
  }
  return latest
}

/**
 * Label a host's own quota read (design §6: e.g. a proxy account's windows
 * read with the host's credentials) as `host-supplied`. `accountScope`
 * states which account the host knows the windows describe.
 */
export function hostQuotaReport(input: { status: QuotaStatus; windows: readonly QuotaWindow[]; accountScope: QuotaReport['accountScope']; receivedAt?: string }): QuotaReport {
  return { status: input.status, windows: input.windows.map((window) => ({ ...window })), receivedAt: input.receivedAt ?? new Date().toISOString(), source: 'host-supplied', accountScope: input.accountScope }
}
