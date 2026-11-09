// Usage, context, quota and limit-wait types (design §6). Kawai's names are
// kept (cacheCreationTokens means cache-write tokens), but unknown values are
// null instead of the legacy zero default, so a missing measurement is never
// mistaken for a measured zero (R08).

/** One turn's token counts. A null field was not reported by the provider. */
export interface TokenUsage {
  inputTokens: number | null
  outputTokens: number | null
  cacheReadTokens: number | null
  /** Cache-write (creation) input tokens. */
  cacheCreationTokens: number | null
}

/** The latest context-window reading. */
export interface ContextUsage {
  usedTokens: number
  thresholdTokens: number
  /** Share of the threshold in use; not clamped to 100. */
  percentage: number
  /** ISO timestamp of the measurement. */
  at: string
  /** True when thresholdTokens is a window standing in for an unknown compaction threshold. */
  thresholdApproximate: boolean
}

export type QuotaStatus = 'allowed' | 'warning' | 'limited'

/** One provider quota window. */
export interface QuotaWindow {
  /** Provider window identity (e.g. `five_hour`, `seven_day_opus`, `codex:primary`). */
  key: string
  label: string
  /** Share used, 0-100. */
  percentUsed: number
  /** ISO reset time, or null when the provider gave none. */
  resetsAt: string | null
  /** Window length when known; null, never guessed. */
  periodMs: number | null
}

/**
 * Where a quota report came from (design §6). `host-login-pull` follows the
 * login of the supplied Claude home, which may be a different account than a
 * proxy session's; it is only reported when the caller opted into that source.
 */
export type QuotaSource = 'push' | 'report' | 'host-login-pull' | 'host-supplied'

/** A normalized quota report, independent of turn state (R04). */
export interface QuotaReport {
  status: QuotaStatus
  windows: readonly QuotaWindow[]
  /** ISO receipt time. */
  receivedAt: string
  source: QuotaSource
  /** Which account the windows describe, as far as the runtime knows. */
  accountScope: 'session' | 'host-login' | 'unknown'
}

/** One limit failure: a retried attempt or the turn's final failure. */
export interface LimitFailure {
  type: 'failure'
  kind: string
  /** True when the turn failed; false for a retried attempt. */
  final: boolean
  status: number | null
  message: string | null
  resetsAt: string | null
  /** Window identity, `credit` for a 402, or null when unnamed. */
  window: string | null
}

/** A provider-observed retry wait began (R05). */
export interface LimitWaitStart {
  type: 'wait-start'
  waitId: string
  turnId: string | null
  window: string | null
  resetsAt: string | null
}

/**
 * The matching wait ended (R05/R06): `resumed` only on an observed retry,
 * never because a reset time passed.
 */
export interface LimitWaitEnd {
  type: 'wait-end'
  waitId: string
  cause: 'resumed' | 'cancelled' | 'process-ended'
}

export type LimitEvent = LimitFailure | LimitWaitStart | LimitWaitEnd
