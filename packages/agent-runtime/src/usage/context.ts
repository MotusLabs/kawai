// Context-window occupancy (design §6, task 5.2; from Kawai's committed
// contextUsage.ts, context meter designs D1-D3, D7). Pure and SDK-free:
// per-request usage, compaction drops and three threshold sources (observed
// report, profile window, model window) resolve into one ContextUsage.
// - A reading exists only once a used count and a threshold are both known
//   (D7). A conversation reset clears back to that state.
// - The latest request wins: input + cache read + cache creation + output is
//   what the next request pays, never a session total (D1).
// - A window standing in for the compaction threshold is labelled
//   `thresholdApproximate`; the meter never claims a distance it does not know.
// Per-request usage can arrive in pieces (GLM reports zeros when a request
// starts and the counts only in its final delta), so mergeRequestUsage folds
// every source of one request together.
import type { ContextUsage } from './types.js'

/** Threshold sources, strongest first (D2). */
export type ContextThresholdSource = 'report' | 'profile' | 'window'

/** What the caller does with a tracker answer; `persist` asks for a write now (R2 meta). */
export type ContextStep = { kind: 'none' } | { kind: 'reading'; usage: ContextUsage; persist: boolean } | { kind: 'clear' }

/** How a reading's threshold was derived, as reported in ContextUsageMeta (R2). */
export type ContextThresholdLabel = 'report-threshold' | 'report-window-fallback' | 'report-window-reserve' | 'profile-window-fallback' | 'profile-window-reserve' | 'model-window-fallback'

/** Structural slice of a Claude context-usage control reply; other fields are ignored. */
export interface ContextReportSlice {
  autoCompactThreshold?: unknown
  rawMaxTokens?: unknown
  categories?: Array<{ kind?: unknown; tokens?: unknown }>
}

interface ContextState {
  usedTokens: number | null
  measuredAt: string | null
  reportThreshold: number | null
  /** False when reportThreshold is rawMaxTokens with no reserve subtracted (a window). */
  reportThresholdExact: boolean
  reportReserve: number | null
  profileWindow: number | null
  modelWindow: number | null
  lastPublished: ContextUsage | null
}

const NONE: ContextStep = { kind: 'none' }

/** A positive finite count, or null for absent, zero or NaN values. */
export function positiveFinite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

/** One session's context-meter state; each mutator answers with the step to take. */
export class ContextTracker {
  private state: ContextState = {
    usedTokens: null, measuredAt: null, reportThreshold: null, reportThresholdExact: true,
    reportReserve: null, profileWindow: null, modelWindow: null, lastPublished: null,
  }

  /** The latest request's used tokens (D1); a non-positive sum is ignored (D7). */
  readRequest(used: number, at: string): ContextStep {
    if (!Number.isFinite(used) || used <= 0) return NONE
    this.state = { ...this.state, usedTokens: used, measuredAt: at }
    return this.publish()
  }

  /** A compaction's post size (D3); an unknown or zero size keeps the last reading. */
  compact(postTokens: number | null, at: string): ContextStep {
    const post = positiveFinite(postTokens)
    if (post === null) return NONE
    this.state = { ...this.state, usedTokens: post, measuredAt: at }
    return this.publish()
  }

  /** The largest model context window seen (D2 step 3). */
  noteModelWindow(window: unknown): ContextStep {
    const next = positiveFinite(window)
    if (next === null) return NONE
    const largest = Math.max(this.state.modelWindow ?? 0, next)
    if (largest === this.state.modelWindow) return NONE
    this.state = { ...this.state, modelWindow: largest }
    return this.publish()
  }

  /**
   * A context-usage report (D2 step 1). Buffer rows are the autocompact
   * reserve; a report with categories but no buffer row clears it, a report
   * with no categories leaves it alone.
   */
  applyReport(report: ContextReportSlice): ContextStep {
    const categories = Array.isArray(report.categories) ? report.categories : []
    const reserve = categories.reduce((sum, category) => {
      const tokens = positiveFinite(category?.tokens)
      return category?.kind === 'buffer' && tokens !== null ? sum + tokens : sum
    }, 0)
    const reportReserve = categories.length > 0 && reserve <= 0 ? null : reserve > 0 ? reserve : this.state.reportReserve
    let { reportThreshold, reportThresholdExact } = this.state
    const direct = positiveFinite(report.autoCompactThreshold)
    if (direct !== null) {
      reportThreshold = direct
      reportThresholdExact = true
    } else {
      const raw = positiveFinite(report.rawMaxTokens)
      const derived = raw === null ? null : positiveFinite(raw - (reportReserve ?? 0))
      if (derived !== null) {
        reportThreshold = derived
        reportThresholdExact = (reportReserve ?? 0) > 0
      }
    }
    this.state = { ...this.state, reportThreshold, reportThresholdExact, reportReserve }
    return this.publish(true)
  }

  /** The profile window at a spawn (D2 step 2); process-scoped report readings die with their process. */
  setProfileWindow(window: number | null): ContextStep {
    this.state = { ...this.state, profileWindow: window, reportThreshold: null, reportThresholdExact: true, reportReserve: null }
    return this.publish(true)
  }

  /** A conversation reset empties the window: nothing is measured any more. */
  resetConversation(): ContextStep {
    if (this.state.usedTokens === null && this.state.lastPublished === null) return NONE
    this.state = { ...this.state, usedTokens: null, measuredAt: null, lastPublished: null }
    return { kind: 'clear' }
  }

  /** The current reading, or null when nothing is measured (D7). */
  current(): ContextUsage | null {
    const used = this.state.usedTokens
    const resolved = this.threshold()
    if (used === null || resolved === null) return null
    return {
      usedTokens: used,
      thresholdTokens: resolved.tokens,
      percentage: Math.round((used / resolved.tokens) * 1000) / 10,
      at: this.state.measuredAt ?? new Date().toISOString(),
      thresholdApproximate: this.approximate(resolved.source),
    }
  }

  /** The derivation label of a reading this tracker just published (R2 meta). */
  thresholdLabel(usage: ContextUsage): ContextThresholdLabel {
    if (this.state.reportThreshold !== null) return this.state.reportThresholdExact ? 'report-threshold' : usage.thresholdApproximate ? 'report-window-fallback' : 'report-window-reserve'
    if (this.state.profileWindow !== null) return usage.thresholdApproximate ? 'profile-window-fallback' : 'profile-window-reserve'
    return 'model-window-fallback'
  }

  /** The report threshold, else the profile window less a reserve, else the profile window, else the model window. */
  private threshold(): { tokens: number; source: ContextThresholdSource } | null {
    if (this.state.reportThreshold !== null) return { tokens: this.state.reportThreshold, source: 'report' }
    const window = this.state.profileWindow ?? this.state.modelWindow
    if (window === null) return null
    const reserve = this.state.reportReserve
    if (this.state.profileWindow !== null && reserve !== null && reserve > 0) {
      const derived = positiveFinite(this.state.profileWindow - reserve)
      if (derived !== null) return { tokens: derived, source: 'profile' }
    }
    return { tokens: window, source: this.state.profileWindow !== null ? 'profile' : 'window' }
  }

  private approximate(source: ContextThresholdSource): boolean {
    if (source === 'report') return !this.state.reportThresholdExact
    if (source === 'profile') return !(this.state.profileWindow !== null && (this.state.reportReserve ?? 0) > 0)
    return true
  }

  private publish(persist = false): ContextStep {
    const usage = this.current()
    if (!usage) return NONE
    const last = this.state.lastPublished
    if (last && last.usedTokens === usage.usedTokens && last.thresholdTokens === usage.thresholdTokens && last.at === usage.at && last.thresholdApproximate === usage.thresholdApproximate) return NONE
    this.state = { ...this.state, lastPublished: usage }
    return { kind: 'reading', usage, persist }
  }
}

/** The four counted per-request usage fields (D1). */
export interface RequestUsage {
  input_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
  output_tokens: number
}

export const EMPTY_REQUEST_USAGE: RequestUsage = { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 }

type UsageSlice = { [K in keyof RequestUsage]?: unknown }

/** A request's used tokens: input + cache read + cache creation + output (D1). */
export function sumRequestUsage(usage: UsageSlice): number {
  const part = (value: unknown) => positiveFinite(value) ?? 0
  return part(usage.input_tokens) + part(usage.cache_read_input_tokens) + part(usage.cache_creation_input_tokens) + part(usage.output_tokens)
}

/**
 * Fold one usage source (message_start, message_delta, assistant frame) into
 * the request's running usage (E1): every counted field is cumulative within a
 * request, so the field-wise maximum is right in any order.
 */
export function mergeRequestUsage(current: RequestUsage, incoming: UsageSlice): RequestUsage {
  const field = (key: keyof RequestUsage) => {
    const value = incoming[key]
    return typeof value === 'number' && Number.isFinite(value) && value > current[key] ? value : current[key]
  }
  return {
    input_tokens: field('input_tokens'),
    cache_read_input_tokens: field('cache_read_input_tokens'),
    cache_creation_input_tokens: field('cache_creation_input_tokens'),
    output_tokens: field('output_tokens'),
  }
}

/** A positive token count from an env-style string (CLAUDE_CODE_AUTO_COMPACT_WINDOW); anything else is unset. */
export function parsePositiveTokens(value: string | undefined): number | null {
  return value ? positiveFinite(Number(value)) : null
}
