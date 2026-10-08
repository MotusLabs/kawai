// Plan-usage capture for chat sessions (usage bar design D2/D3): the three
// shapes Claude Code emits — pushed rate_limit_event frames, /usage reports
// carried on assistant messages, and the SDK usage control reply — are
// normalized into one Kawai-owned ChatUsageReport, and UsageLimitStore keeps
// the latest report (or a "no data" verdict) per Claude profile. Side-effect
// free and SDK-free (sources are matched structurally, like chatActivity.ts),
// so tests pin shapes copied from real wire captures and the direct-CLI
// transport of replace-claude-sdk-with-cli can reuse the parsing.
import type {
  ChatUsageReport,
  ChatUsageStatus,
  ChatUsageWindow,
} from '../../shared/chat'

/**
 * Display label for a meter kind. Unknown kinds label as themselves: the
 * server's vocabulary renders verbatim, so a new meter needs no release.
 * The usage endpoint's 'session'/'weekly_all' meters are the same windows
 * the push events name 'five_hour'/'seven_day'.
 */
const WINDOW_LABELS: Record<string, string> = {
  five_hour: '5-hour window',
  seven_day: '7-day window',
  seven_day_opus: '7-day Opus window',
  seven_day_sonnet: '7-day Sonnet window',
  seven_day_oauth_apps: '7-day OAuth apps window',
  seven_day_overage_included: '7-day overage-included window',
  overage: 'Overage',
  session: '5-hour window',
  weekly_all: '7-day window',
}

function windowLabel(key: string): string {
  return WINDOW_LABELS[key] ?? key
}

/** Percent 0-100 from a source that reports 0-1 fractions; null when unusable. */
function fractionToPercent(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    return null
  }
  // Round to two decimals: 0.1712 as a fraction is 17.12, not 17.119999…
  return Math.round(value * 100 * 100) / 100
}

/** Percent 0-100 from a source that already reports percent; null when unusable. */
function percentValue(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
    return null
  }
  return value
}

/** ISO reset time from an epoch-ms number or ISO string; null when unusable. */
function toIsoResetsAt(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value).toISOString()
  }
  if (typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Date.parse(value))) {
    return value
  }
  return null
}

/** Push status vocabulary → report status; unknown values map to allowed. */
function pushStatus(status: unknown): ChatUsageStatus {
  if (status === 'allowed_warning') return 'warning'
  if (status === 'rejected') return 'limited'
  return 'allowed'
}

/** Usage-endpoint severity vocabulary → report status; unknown → allowed. */
function severityStatus(severity: unknown): ChatUsageStatus {
  if (severity === 'warning') return 'warning'
  if (severity === 'critical') return 'limited'
  return 'allowed'
}

const STATUS_RANK: Record<ChatUsageStatus, number> = {
  allowed: 0,
  warning: 1,
  limited: 2,
}

/** The worse of two statuses: the report shows its most severe row. */
function worstStatus(a: ChatUsageStatus, b: ChatUsageStatus): ChatUsageStatus {
  return STATUS_RANK[b] > STATUS_RANK[a] ? b : a
}

// ----------------------------------------------------------------- push: rate_limit_event

/** Structural slice of a `rate_limit_event`'s rate_limit_info (SDK-free). */
export interface RateLimitInfoSlice {
  status?: string
  /** Epoch-ms reset time of the rateLimitType window. */
  resetsAt?: number | null
  rateLimitType?: string
  utilization?: number
  /** Informational overage flags some providers always send (e.g. GLM). */
  isUsingOverage?: boolean
  /**
   * Undocumented sibling carrying both windows in one event (2026-10-07
   * probe): keyed by meter kind, utilization as a 0-1 fraction.
   */
  unifiedWindows?: Record<string, RateLimitWindowSlice | null> | null
}

export interface RateLimitWindowSlice {
  utilization?: number
  resetsAt?: number | null
}

/**
 * Parse a pushed rate_limit_event. `unifiedWindows` is preferred for both
 * plan windows; otherwise the event's single `rateLimitType` window is used
 * (appended only when unified did not already cover that kind). Values that
 * are not finite 0-1 fractions drop their window rather than render wrong;
 * unknown statuses map to allowed; a status-only event yields no windows.
 */
export function parseRateLimitEvent(
  info: RateLimitInfoSlice | null | undefined,
  receivedAt: string = new Date().toISOString()
): ChatUsageReport {
  const windows: ChatUsageWindow[] = []
  const unified = info?.unifiedWindows
  if (unified && typeof unified === 'object') {
    for (const [key, window] of Object.entries(unified)) {
      const parsed = fractionWindow(key, window)
      if (parsed) windows.push(parsed)
    }
  }
  const single = fractionWindow(info?.rateLimitType, info)
  if (single && !windows.some((window) => window.key === single.key)) {
    windows.push(single)
  }
  return { status: pushStatus(info?.status), windows, receivedAt }
}

/** One fraction-scaled window, or null when its utilization is unusable. */
function fractionWindow(
  key: string | undefined,
  slice: RateLimitWindowSlice | null | undefined
): ChatUsageWindow | null {
  if (typeof key !== 'string' || key === '') return null
  const percentUsed = fractionToPercent(slice?.utilization)
  if (percentUsed === null) return null
  return {
    key,
    label: windowLabel(key),
    percentUsed,
    resetsAt: toIsoResetsAt(slice?.resetsAt),
  }
}

// ----------------------------------------------------------------- push: /usage report

/** Structural slice of an assistant message's usage_report (SDK-free). */
export interface UsageReportSlice {
  rate_limits?: {
    /** The server's usage rows; null when the CLI could not fetch them. */
    limits?: UsageReportLimitRowSlice[] | null
  } | null
}

export interface UsageReportLimitRowSlice {
  /** The server's meter kind, e.g. 'session', 'weekly_all', 'weekly_scoped'. */
  kind?: string
  /** The server's row group, e.g. 'session' or 'weekly'. */
  group?: string
  /** Some servers also send a display label on the row. */
  label?: string
  /** Share of the window used, 0-100. */
  percent?: number
  resets_at?: string | null
  scope?: {
    model?: { display_name?: string } | null
    surface?: { display_name?: string } | null
  } | null
  severity?: string
  /** The server's headline pick; informational for this parser. */
  is_active?: boolean
}

/**
 * Parse a /usage report's structured twin. Rows map to windows keyed by their
 * meter kind (a scoped row appends its scope label so scoped windows never
 * collide), labeled from the scope's display name, the row's own label, or
 * the kind; the report status is the worst row severity. Returns null when
 * the report carries no limits at all (nothing was fetched); an empty limits
 * array yields a windowless report — a status and receipt time only.
 */
export function parseUsageReport(
  report: UsageReportSlice | null | undefined,
  receivedAt: string = new Date().toISOString()
): ChatUsageReport | null {
  const limits = report?.rate_limits?.limits
  if (!Array.isArray(limits)) return null
  const windows: ChatUsageWindow[] = []
  let status: ChatUsageStatus = 'allowed'
  for (const row of limits) {
    if (!row || typeof row !== 'object') continue
    const percentUsed = percentValue(row.percent)
    if (percentUsed === null || typeof row.kind !== 'string' || row.kind === '') {
      continue
    }
    const scopeLabel =
      row.scope?.model?.display_name ?? row.scope?.surface?.display_name
    const key = scopeLabel ? `${row.kind}:${scopeLabel}` : row.kind
    windows.push({
      key,
      label: scopeLabel ?? row.label ?? windowLabel(key),
      percentUsed,
      resetsAt: toIsoResetsAt(row.resets_at),
    })
    status = worstStatus(status, severityStatus(row.severity))
  }
  return { status, windows, receivedAt }
}

// ----------------------------------------------------------------- pull: usage control

/** Structural slice of the usage control reply (SDK-free). */
export interface UsagePullSlice {
  /** 'pro' | 'max' | ... , or null for API-key/3P-provider sessions. */
  subscription_type?: string | null
  /** False when plan rate limits do not apply (API key, Bedrock, Vertex, ...). */
  rate_limits_available?: boolean
  rate_limits?: UsagePullRateLimitsSlice | null
}

export interface UsagePullRateLimitsSlice {
  five_hour?: UsagePullWindowSlice | null
  seven_day?: UsagePullWindowSlice | null
  seven_day_opus?: UsagePullWindowSlice | null
  seven_day_sonnet?: UsagePullWindowSlice | null
  seven_day_oauth_apps?: UsagePullWindowSlice | null
  /** Per-model weekly windows, labeled by the server. */
  model_scoped?: UsagePullModelWindowSlice[] | null
}

export interface UsagePullWindowSlice {
  /** Percentage of the window used, 0-100. */
  utilization?: number | null
  resets_at?: string | null
}

export interface UsagePullModelWindowSlice extends UsagePullWindowSlice {
  display_name?: string
}

/** The fixed pull windows in display order. */
const PULL_WINDOW_KINDS = [
  'five_hour',
  'seven_day',
  'seven_day_opus',
  'seven_day_sonnet',
  'seven_day_oauth_apps',
] as const

/**
 * Parse a usage control reply. Pull utilization is already percent 0-100.
 * Returns null when plan limits do not apply or no rate limits came back;
 * otherwise a report whose status is allowed (the pull carries no severity —
 * warning/limited come only from pushed reports).
 */
export function parseUsagePull(
  response: UsagePullSlice | null | undefined,
  receivedAt: string = new Date().toISOString()
): ChatUsageReport | null {
  if (response?.rate_limits_available === false) return null
  const limits = response?.rate_limits
  if (!limits || typeof limits !== 'object') return null
  const windows: ChatUsageWindow[] = []
  for (const key of PULL_WINDOW_KINDS) {
    const window = percentWindow(key, limits[key], windowLabel(key))
    if (window) windows.push(window)
  }
  if (Array.isArray(limits.model_scoped)) {
    for (const row of limits.model_scoped) {
      if (!row || typeof row !== 'object') continue
      if (typeof row.display_name !== 'string' || row.display_name === '') continue
      const window = percentWindow(
        `model_scoped:${row.display_name}`,
        row,
        row.display_name
      )
      if (window) windows.push(window)
    }
  }
  return { status: 'allowed', windows, receivedAt }
}

/** One percent-scaled window, or null when its utilization is unusable. */
function percentWindow(
  key: string,
  slice: UsagePullWindowSlice | null | undefined,
  label: string
): ChatUsageWindow | null {
  const percentUsed = percentValue(slice?.utilization)
  if (percentUsed === null) return null
  return { key, label, percentUsed, resetsAt: toIsoResetsAt(slice?.resets_at) }
}

// ----------------------------------------------------------------- per-profile store

/** Notified with the latest report (or null) whenever a profile's data changes. */
export type UsageLimitListener = (
  profileId: string,
  report: ChatUsageReport | null
) => void

interface UsageLimitState {
  /** Latest report; a windowless one still holds status and receipt time. */
  report: ChatUsageReport | null
  /** Set when a pull yielded nothing: later pulls are skipped, pushes land. */
  noDataAt: string | null
  /** True once this profile's one pull per store lifetime has been claimed. */
  pullClaimed: boolean
}

/**
 * Latest plan-usage report per Claude profile, in memory only (usage bar
 * design D3): merging keeps held windows when a report carries none, older
 * data never overwrites newer, and a "no data" verdict suppresses the pull
 * fallback until any push replaces it.
 */
export class UsageLimitStore {
  private readonly profiles = new Map<string, UsageLimitState>()
  private readonly listeners = new Set<UsageLimitListener>()

  /** Subscribe to profile data changes; returns an unsubscribe function. */
  subscribe(listener: UsageLimitListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** The latest report for a profile, or null (also under a no-data verdict). */
  get(profileId: string): ChatUsageReport | null {
    return this.profiles.get(profileId)?.report ?? null
  }

  /**
   * Claim this profile's one usage pull: true only when no pull has been
   * claimed and the profile holds neither a report nor a no-data verdict.
   * Design D1 — the pull is gap-filling, not a poll, and a provider that
   * reports nothing must not pay a control round-trip on every turn.
   */
  claimPull(profileId: string): boolean {
    const state = this.state(profileId)
    if (state.pullClaimed || state.report !== null || state.noDataAt !== null) {
      return false
    }
    state.pullClaimed = true
    return true
  }

  /**
   * Record a captured report (push or pull). A windowless report keeps the
   * windows already held (spec: a report without window data must not replace
   * it) and always clears a no-data verdict; an older report never overwrites
   * a newer one.
   */
  record(profileId: string, report: ChatUsageReport): void {
    const state = this.state(profileId)
    if (
      state.report &&
      Date.parse(state.report.receivedAt) > Date.parse(report.receivedAt)
    ) {
      return
    }
    const windows =
      report.windows.length > 0 ? report.windows : (state.report?.windows ?? [])
    const next = { ...report, windows }
    const changed = JSON.stringify(state.report) !== JSON.stringify(next)
    state.report = next
    state.noDataAt = null
    if (changed) this.notify(profileId)
  }

  /**
   * Record that no usage data could be obtained for a profile. Never
   * displaces a report that already landed (the pull raced a push).
   */
  recordNoData(profileId: string, at: string = new Date().toISOString()): void {
    const state = this.state(profileId)
    if (state.report !== null || state.noDataAt !== null) return
    state.noDataAt = at
    this.notify(profileId)
  }

  private state(profileId: string): UsageLimitState {
    let state = this.profiles.get(profileId)
    if (!state) {
      state = { report: null, noDataAt: null, pullClaimed: false }
      this.profiles.set(profileId, state)
    }
    return state
  }

  private notify(profileId: string): void {
    const report = this.get(profileId)
    for (const listener of this.listeners) {
      listener(profileId, report)
    }
  }
}
