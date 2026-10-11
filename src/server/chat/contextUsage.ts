// Pure context-meter state (context meter designs D1–D3, D7): per-request
// usage, compaction drops, and the three threshold sources (observed report,
// profile window, model window) resolve into one ChatContextUsage reading.
// Side-effect free and SDK-free (reports are matched structurally, like
// chatActivity.ts and usageLimits.ts), so tests pin shapes copied from real
// wire captures and the driver only maps frames onto inputs.
//
// A reading exists only once both a used count and a threshold are known
// (D7): nothing is published before the first model request, and a
// conversation reset clears back to that state rather than leaving a stale
// occupancy behind.
import type { ChatContextUsage } from '../../shared/chat'

/** Threshold sources, strongest first (design D2). */
export type ChatContextThresholdSource = 'report' | 'profile' | 'window'

export interface ChatContextState {
  /** Latest per-request used tokens; null before the first request (D7). */
  usedTokens: number | null
  /** When `usedTokens` was measured. */
  measuredAt: string | null
  /** Threshold observed from a context-usage report (D2 step 1). */
  reportThreshold: number | null
  /**
   * False when `reportThreshold` is just `rawMaxTokens` with no reserve
   * subtracted — a window standing in for the threshold, like D2 step 3.
   */
  reportThresholdExact: boolean
  /**
   * Autocompact reserve observed in a report; shrinks a profile window (D2
   * step 2). Cleared when a later report answers without a buffer row, so a
   * vanished reserve cannot keep shrinking the denominator.
   */
  reportReserve: number | null
  /** Profile window (CLAUDE_CODE_AUTO_COMPACT_WINDOW) at the last spawn (D2). */
  profileWindow: number | null
  /** Largest model contextWindow seen on a result's modelUsage (D2 step 3). */
  modelWindow: number | null
  /** Last reading handed out; suppresses identical re-publishes. */
  lastPublished: ChatContextUsage | null
}

export function initialChatContextState(): ChatContextState {
  return {
    usedTokens: null,
    measuredAt: null,
    reportThreshold: null,
    reportThresholdExact: true,
    reportReserve: null,
    profileWindow: null,
    modelWindow: null,
    lastPublished: null,
  }
}

/**
 * Structural slice of an SDK context-usage control reply. Only the fields the
 * threshold resolution reads; unknown fields are ignored so a richer report
 * needs no change here.
 */
export interface ChatContextReportSlice {
  autoCompactThreshold?: unknown
  rawMaxTokens?: unknown
  categories?: Array<{ kind?: unknown; tokens?: unknown }>
}

/** What the caller should do with the tracker's answer. */
export type ChatContextStep =
  /** Nothing changed, or there is still no reading to show. */
  | { kind: 'none' }
  /** A new (or re-scaled) reading: hand it on. `persist` asks for a write now. */
  | { kind: 'reading'; usage: ChatContextUsage; persist: boolean }
  /** A previous reading is gone: clear the meter and the stored column. */
  | { kind: 'clear' }

const NONE: ChatContextStep = { kind: 'none' }

/** A positive finite token count, or null for absent/zero/NaN values. */
function positiveFinite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : null
}

/**
 * Owns one session's context-meter state (context meter designs D1–D3, D7).
 * Each mutator answers with the step the caller should take — publish, clear,
 * or nothing — so identical re-publications are suppressed here rather than
 * in the driver.
 */
export class ChatContextTracker {
  private state: ChatContextState = initialChatContextState()

  getState(): ChatContextState {
    return this.state
  }

  /**
   * The latest request's usage (design D1): `input + cache_read +
   * cache_creation + output` is what the next request pays, never the session
   * total. The latest request wins. Non-positive sums are ignored (D7).
   */
  readRequest(used: number, at: string): ChatContextStep {
    if (!Number.isFinite(used) || used <= 0) return NONE
    this.state = { ...this.state, usedTokens: used, measuredAt: at }
    return this.publish()
  }

  /**
   * Adopt a compaction's post size (design D3). `postTokens` absent,
   * non-finite, or zero keeps the last reading — never a placeholder. The
   * write this boundary owes is the manager's, keyed on the compacted
   * notice; this only moves the meter.
   */
  compact(postTokens: number | null, at: string): ChatContextStep {
    const post = positiveFinite(postTokens)
    if (post === null) return NONE
    this.state = { ...this.state, usedTokens: post, measuredAt: at }
    return this.publish()
  }

  /** Largest model contextWindow seen (design D2 step 3). */
  noteModelWindow(window: number): ChatContextStep {
    const next = positiveFinite(window)
    if (next === null) return NONE
    const largest = Math.max(this.state.modelWindow ?? 0, next)
    if (largest === this.state.modelWindow) return NONE
    this.state = { ...this.state, modelWindow: largest }
    return this.publish()
  }

  /**
   * Adopt a context-usage report (design D2 step 1). Buffer rows are the
   * autocompact reserve. A report that answers with categories but no buffer
   * row clears the reserve — auto-compact off, or the reserve gone — so a
   * stale one cannot keep shrinking the derived threshold. A report with no
   * categories at all leaves the reserve alone (it simply did not say).
   */
  applyReport(report: ChatContextReportSlice): ChatContextStep {
    const categories = Array.isArray(report.categories) ? report.categories : []
    const reserve = categories.reduce((sum, category) => {
      const tokens = positiveFinite(category?.tokens)
      return category?.kind === 'buffer' && tokens !== null ? sum + tokens : sum
    }, 0)
    const reportReserve = categories.length > 0 && reserve <= 0 ? null : reserve > 0 ? reserve : this.state.reportReserve

    const direct = positiveFinite(report.autoCompactThreshold)
    let reportThreshold = this.state.reportThreshold
    let reportThresholdExact = this.state.reportThresholdExact
    if (direct !== null) {
      reportThreshold = direct
      reportThresholdExact = true
    } else {
      const raw = positiveFinite(report.rawMaxTokens)
      if (raw !== null) {
        const derived = positiveFinite(raw - (reportReserve ?? 0))
        if (derived !== null) {
          reportThreshold = derived
          // rawMaxTokens minus nothing is the window, not the threshold.
          reportThresholdExact = (reportReserve ?? 0) > 0
        }
      }
    }
    this.state = { ...this.state, reportThreshold, reportThresholdExact, reportReserve }
    return this.publish({ persist: true })
  }

  /**
   * Re-read the profile window at spawn (design D2 step 2). Process-scoped
   * report readings die with the process they were observed on — they outrank
   * the profile, so a stale threshold would survive a window change whenever
   * the new probe fails to answer.
   */
  setProfileWindow(window: number | null): ChatContextStep {
    this.state = {
      ...this.state,
      profileWindow: window,
      reportThreshold: null,
      reportThresholdExact: true,
      reportReserve: null,
    }
    return this.publish({ persist: true })
  }

  /** A conversation reset empties the window: nothing is measured any more. */
  resetConversation(): ChatContextStep {
    if (this.state.usedTokens === null && this.state.lastPublished === null) return NONE
    this.state = {
      ...this.state,
      usedTokens: null,
      measuredAt: null,
      lastPublished: null,
    }
    return { kind: 'clear' }
  }

  /**
   * Denominator (design D2): the observed report threshold, else the profile
   * window less an observed reserve, else the profile window on its own, else
   * the model window. Steps 2-without-reserve and 3 are windows standing in
   * for the threshold and are labelled as approximations.
   */
  private threshold(): { tokens: number; source: ChatContextThresholdSource } | null {
    if (this.state.reportThreshold !== null) {
      return { tokens: this.state.reportThreshold, source: 'report' }
    }
    const window = this.state.profileWindow ?? this.state.modelWindow
    if (window === null) return null
    const reserve = this.state.reportReserve
    if (this.state.profileWindow !== null && reserve !== null && reserve > 0) {
      const derived = positiveFinite(this.state.profileWindow - reserve)
      if (derived !== null) return { tokens: derived, source: 'profile' }
    }
    return {
      tokens: window,
      source: this.state.profileWindow !== null ? 'profile' : 'window',
    }
  }

  /** The current reading, or null when nothing has been measured (D7). */
  currentReading(): ChatContextUsage | null {
    const used = this.state.usedTokens
    const resolved = this.threshold()
    if (used === null || resolved === null) return null
    return {
      usedTokens: used,
      thresholdTokens: resolved.tokens,
      percentage: Math.round((used / resolved.tokens) * 1000) / 10,
      at: this.state.measuredAt ?? new Date().toISOString(),
      // Anything that is a window standing in for the threshold (D2 steps
      // 2–3) is labelled as such — the meter must not claim a distance to
      // compaction it does not know.
      ...(this.isApproximate(resolved) ? { thresholdApproximate: true } : {}),
    }
  }

  /** True when the resolved denominator is a window, not a measured threshold. */
  private isApproximate(resolved: { source: ChatContextThresholdSource }): boolean {
    if (resolved.source === 'report') return !this.state.reportThresholdExact
    if (resolved.source === 'profile') return !this.hasDerivedProfileThreshold()
    return true
  }

  /** Profile-window-minus-reserve is a derived threshold, not a stand-in. */
  private hasDerivedProfileThreshold(): boolean {
    return (
      this.state.profileWindow !== null &&
      this.state.reportReserve !== null &&
      this.state.reportReserve > 0
    )
  }

  /**
   * Hand out the current reading when it differs from the last one. `persist`
   * marks the re-scale cases (a probe answer, a spawn-time re-anchor) that
   * must not wait for the next turn boundary.
   */
  private publish(options: { persist?: boolean } = {}): ChatContextStep {
    const usage = this.currentReading()
    if (!usage) return NONE
    const last = this.state.lastPublished
    if (
      last &&
      last.usedTokens === usage.usedTokens &&
      last.thresholdTokens === usage.thresholdTokens &&
      last.at === usage.at &&
      Boolean(last.thresholdApproximate) === Boolean(usage.thresholdApproximate)
    ) {
      return NONE
    }
    this.state = { ...this.state, lastPublished: usage }
    return { kind: 'reading', usage, persist: options.persist === true }
  }
}

/**
 * Sum of a request's usage fields (design D1): what the next request pays for
 * the window, never a session total. Zero when the frame carries no usable
 * numbers, so callers can ignore the result.
 */
export function sumRequestUsage(usage: {
  input_tokens?: unknown
  cache_read_input_tokens?: unknown
  cache_creation_input_tokens?: unknown
  output_tokens?: unknown
}): number {
  const part = (value: unknown) =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
  return (
    part(usage.input_tokens) +
    part(usage.cache_read_input_tokens) +
    part(usage.cache_creation_input_tokens) +
    part(usage.output_tokens)
  )
}

/** A positive token count from an env-style string; anything else is unset. */
export function parsePositiveTokens(value: string | undefined): number | null {
  if (!value) return null
  return positiveFinite(Number(value))
}
