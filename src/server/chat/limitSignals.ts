// Kawai's view of limit failures (profile-routing design D6). Classification
// lives in @motuslabs/agent-runtime's public usage entry: a retried
// `system/api_retry` attempt or a failed assistant message counts for the
// classes rate_limit, billing_error and overloaded, or any HTTP 429, and an
// HTTP 402 is always a final limit in the `credit` window with no reset
// (openrouter-provider D7). The package driver reports a `LimitFailure`;
// runtimeEvents.ts maps it to the ChatLimitSignal below.
//
// Kawai keeps two host policies: the profile's `limitResetTimeZone`, whose
// validity is memoized per zone string (catalog-resolution-cache D3), and
// reading a zone-less reset from a final failure's text in that zone.
import { isResetTimeZone as checkResetTimeZone, withTextReset as withFailureTextReset } from '@motuslabs/agent-runtime/usage'
import type { LimitFailure } from '@motuslabs/agent-runtime/usage'

export { CREDIT_LIMIT_WINDOW, LIMIT_ERROR_CLASSES } from '@motuslabs/agent-runtime/usage'

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

const ZONE_MEMO_LIMIT = 256
const zoneValidity = new Map<string, boolean>()

/**
 * Whether a profile's `limitResetTimeZone` is usable: an IANA zone or a fixed
 * `±HH:MM` offset (the package's uncached check). A zone name's validity does
 * not change while the server runs, so the answer is memoized per string
 * (catalog-resolution-cache D3), bounded by dropping the oldest entry.
 */
export function isResetTimeZone(timeZone: string): boolean {
  const known = zoneValidity.get(timeZone)
  if (known !== undefined) return known
  const valid = checkResetTimeZone(timeZone)
  zoneValidity.set(timeZone, valid)
  if (zoneValidity.size > ZONE_MEMO_LIMIT) zoneValidity.delete(zoneValidity.keys().next().value as string)
  return valid
}

/**
 * An announced reset wins; otherwise the profile zone reads one from a final
 * signal's error text (GLM: `Your limit will reset at 2026-10-13 17:17:00`).
 * The signal itself comes back when nothing was read.
 */
export function withTextReset(signal: ChatLimitSignal, timeZone: string | undefined): ChatLimitSignal {
  const failure: LimitFailure = { type: 'failure', ...signal }
  const read = withFailureTextReset(failure, timeZone)
  return read === failure ? signal : { ...signal, resetsAt: read.resetsAt }
}
