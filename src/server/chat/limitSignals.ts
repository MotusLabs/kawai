// Limit signals from Claude Code's classified API errors (profile-routing
// design D6), SDK-free like usageLimits.ts. A `system/api_retry` frame is a
// retried attempt (`final: false`); a failed assistant message is the turn's
// final failure. Both count when the error class is `rate_limit`,
// `billing_error`, or `overloaded`, or when the HTTP status is 429 whatever
// the class — gateways often report quota exhaustion under another class, so
// the raw status and message ride along for routing rules to inspect.

/** Error classes that always count as a limit. */
export const LIMIT_ERROR_CLASSES: ReadonlySet<string> = new Set(['rate_limit', 'billing_error', 'overloaded'])

/** One limit failure as the driver sees it; the session adds identity. */
export interface ChatLimitSignal {
  kind: string
  final: boolean
  status: number | null
  message: string | null
  resetsAt: string | null
}

/** Structural slice of a `system/api_retry` frame. */
export interface ApiRetrySlice {
  error?: string
  error_status?: number | null
}

export function retryLimitSignal(frame: ApiRetrySlice, resetsAt: string | null): ChatLimitSignal | null {
  const status = typeof frame.error_status === 'number' ? frame.error_status : null
  const kind = frame.error ?? 'unknown'
  if (!LIMIT_ERROR_CLASSES.has(kind) && status !== 429) return null
  return { kind, final: false, status, message: null, resetsAt }
}

/**
 * A failed assistant message (its wrapper `error` class plus the text Claude
 * Code shows, e.g. `API Error: 429 {...}`). The status is read from that text.
 */
export function assistantLimitSignal(
  error: string | undefined,
  text: string,
  resetsAt: string | null
): ChatLimitSignal | null {
  if (!error) return null
  const match = /API Error:\s*(\d{3})\b/.exec(text)
  const status = match ? Number(match[1]) : null
  if (!LIMIT_ERROR_CLASSES.has(error) && status !== 429) return null
  return { kind: error, final: true, status, message: text.trim() || null, resetsAt }
}

/** Structural slice of a `rate_limit_event`'s info, for the reset time. */
export interface RejectedRateLimitSlice {
  status?: string
  /** Epoch seconds. */
  resetsAt?: number | null
}

/**
 * The provider reset time a `rate_limit_event` announces when it reports the
 * request as rejected; null for any other status or a missing time.
 */
export function rejectedResetsAt(info: RejectedRateLimitSlice | null | undefined): string | null {
  if (info?.status !== 'rejected' || typeof info.resetsAt !== 'number' || !Number.isFinite(info.resetsAt)) return null
  return new Date(info.resetsAt * 1000).toISOString()
}
