// Limit signals from Claude Code's classified API errors (profile-routing
// design D6), SDK-free like usageLimits.ts. A `system/api_retry` frame is a
// retried attempt (`final: false`); a failed assistant message is the turn's
// final failure. Both count when the error class is `rate_limit`,
// `billing_error`, or `overloaded`, or when the HTTP status is 429 whatever
// the class — gateways often report quota exhaustion under another class, so
// the raw status and message ride along for routing rules to inspect. HTTP
// 402 (payment required: out of credit) is always a final limit in the
// `credit` window, whatever the class or retry (openrouter-provider D7):
// waiting creates no credit.

/** Error classes that always count as a limit. */
export const LIMIT_ERROR_CLASSES: ReadonlySet<string> = new Set(['rate_limit', 'billing_error', 'overloaded'])

/** The window a 402 counts against: no reset, ended by new credit. */
export const CREDIT_LIMIT_WINDOW = 'credit'

/** One limit failure as the driver sees it; the session adds identity. */
export interface ChatLimitSignal {
  kind: string
  final: boolean
  status: number | null
  message: string | null
  resetsAt: string | null
  /**
   * The limit window: the rejected rate-limit report's (`seven_day_opus`, …),
   * `credit` for a 402, or null when unnamed.
   */
  window: string | null
}

/** The fields a 402 forces: final, credit window, no reset. */
const CREDIT = { final: true, resetsAt: null, window: CREDIT_LIMIT_WINDOW } as const

/** Structural slice of a `system/api_retry` frame. */
export interface ApiRetrySlice {
  error?: string
  error_status?: number | null
}

export function retryLimitSignal(frame: ApiRetrySlice, resetsAt: string | null, window: string | null = null): ChatLimitSignal | null {
  const status = typeof frame.error_status === 'number' ? frame.error_status : null
  const kind = frame.error ?? 'unknown'
  if (status === 402) return { kind, status, message: null, ...CREDIT }
  if (!LIMIT_ERROR_CLASSES.has(kind) && status !== 429) return null
  return { kind, final: false, status, message: null, resetsAt, window }
}

/**
 * A failed assistant message (its wrapper `error` class plus the text Claude
 * Code shows, e.g. `API Error: 429 {...}`). The status is read from that text.
 */
export function assistantLimitSignal(
  error: string | undefined,
  text: string,
  resetsAt: string | null,
  window: string | null = null
): ChatLimitSignal | null {
  if (!error) return null
  const match = /API Error:\s*(\d{3})\b/.exec(text)
  const status = match ? Number(match[1]) : null
  const message = text.trim() || null
  if (status === 402) return { kind: error, status, message, ...CREDIT }
  if (!LIMIT_ERROR_CLASSES.has(error) && status !== 429) return null
  return { kind: error, final: true, status, message, resetsAt, window }
}

const FIXED_OFFSET = /^([+-])(\d{2}):(\d{2})$/

/** Minutes east of UTC for a fixed `±HH:MM` offset or an IANA zone at an instant; null if unusable. */
function offsetMinutes(timeZone: string, at: number): number | null {
  const fixed = FIXED_OFFSET.exec(timeZone)
  if (fixed) {
    const minutes = Number(fixed[2]) * 60 + Number(fixed[3])
    return Number(fixed[2]) > 23 || Number(fixed[3]) > 59 ? null : (fixed[1] === '-' ? -minutes : minutes)
  }
  try {
    const name = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
      .formatToParts(at).find(part => part.type === 'timeZoneName')?.value ?? ''
    const match = /^GMT(?:([+-])(\d{2}):(\d{2}))?$/.exec(name)
    if (!match) return null
    const minutes = match[1] ? Number(match[2]) * 60 + Number(match[3]) : 0
    return match[1] === '-' ? -minutes : minutes
  } catch {
    return null
  }
}

/** Whether a profile's `limitResetTimeZone` is usable: an IANA zone or a fixed `±HH:MM` offset. */
export function isResetTimeZone(timeZone: string): boolean {
  return offsetMinutes(timeZone, Date.now()) !== null
}

/**
 * A reset time a gateway writes into its error text without a zone (GLM:
 * `Your limit will reset at 2026-10-13 17:17:00`), read in the profile's
 * `limitResetTimeZone`. Null when the text has no such time or the zone is unusable.
 */
export function textResetsAt(text: string, timeZone: string): string | null {
  const match = /\breset(?:s)?\s+at\s+(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/i.exec(text)
  if (!match) return null
  const [year, month, day, hour, minute, second] = match.slice(1).map(part => Number(part ?? 0))
  const wall = Date.UTC(year, month - 1, day, hour, minute, second)
  // Out-of-range parts (month 13, day 45, hour 25) roll over in Date.UTC; refuse them.
  const check = new Date(wall)
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day
    || check.getUTCHours() !== hour || check.getUTCMinutes() !== minute || check.getUTCSeconds() !== second) return null
  // The offset depends on the instant (DST); one correction settles it.
  const first = offsetMinutes(timeZone, wall)
  if (first === null) return null
  const guess = wall - first * 60_000
  const offset = offsetMinutes(timeZone, guess) ?? first
  return new Date(wall - offset * 60_000).toISOString()
}

/** An announced reset wins; otherwise the profile zone reads one from a final signal's error text. */
export function withTextReset(signal: ChatLimitSignal, timeZone: string | undefined): ChatLimitSignal {
  if (signal.resetsAt || !signal.final || !signal.message || !timeZone) return signal
  const resetsAt = textResetsAt(signal.message, timeZone)
  return resetsAt ? { ...signal, resetsAt } : signal
}

/** Structural slice of a `rate_limit_event`'s info, for the reset time. */
export interface RejectedRateLimitSlice {
  status?: string
  /** Epoch seconds. */
  resetsAt?: number | null
  /** The window the rejection names (`five_hour`, `seven_day_opus`, …). */
  rateLimitType?: string
}

/**
 * The provider reset time a `rate_limit_event` announces when it reports the
 * request as rejected; null for any other status or a missing time.
 */
export function rejectedResetsAt(info: RejectedRateLimitSlice | null | undefined): string | null {
  if (info?.status !== 'rejected' || typeof info.resetsAt !== 'number' || !Number.isFinite(info.resetsAt)) return null
  return new Date(info.resetsAt * 1000).toISOString()
}

/**
 * The window a rejected `rate_limit_event` names (providers-and-workers D7):
 * the pair the driver keeps beside its reset. Null for any other status or an
 * unnamed window.
 */
export function rejectedWindow(info: RejectedRateLimitSlice | null | undefined): string | null {
  if (info?.status !== 'rejected' || typeof info.rateLimitType !== 'string' || info.rateLimitType === '') return null
  return info.rateLimitType
}
