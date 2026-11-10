// Limit failures (design §6, task 5.2; from Kawai's committed limitSignals.ts
// and codex/codexLimits.ts). Pure and SDK-free.
// - Claude: a `system/api_retry` frame is a retried attempt (final false), a
//   failed assistant message the turn's final failure. Both count for the
//   classes rate_limit, billing_error and overloaded, or any HTTP 429.
//   HTTP 402 is always a final limit in the `credit` window with no reset:
//   waiting creates no credit.
// - The reset and window come from the latest rejected rate_limit_event
//   while it is still ahead. A zone-less `reset at <date time>` in the error
//   text needs the host's time zone for the provider (textResetsAt,
//   withTextReset); the driver has none and leaves resetsAt null.
// - Codex: usageLimitExceeded, rateLimitExceeded and serverOverloaded are
//   login-scoped, sessionBudgetExceeded the session's own; a failed turn is
//   final, a retrying `error` notification non-final. The reset is the latest
//   among the snapshot's exhausted windows. A Codex 402 is not a credit limit.
import type { LimitFailure } from './types.js'
import { codexExhaustedReset } from './quota.js'

/** Claude error classes that always count as a limit. */
export const LIMIT_ERROR_CLASSES: ReadonlySet<string> = new Set(['rate_limit', 'billing_error', 'overloaded'])

/** The window a 402 counts against. */
export const CREDIT_LIMIT_WINDOW = 'credit'

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** A Claude api_retry frame's limit failure (non-final), or null when it is not a limit. */
export function retryLimitFailure(frame: unknown, resetsAt: string | null, window: string | null): LimitFailure | null {
  const slice = isObject(frame) ? frame : {}
  const status = typeof slice.error_status === 'number' ? slice.error_status : null
  const kind = typeof slice.error === 'string' && slice.error ? slice.error : 'unknown'
  if (status === 402) return { type: 'failure', kind, final: true, status, message: null, resetsAt: null, window: CREDIT_LIMIT_WINDOW }
  if (!LIMIT_ERROR_CLASSES.has(kind) && status !== 429) return null
  return { type: 'failure', kind, final: false, status, message: null, resetsAt, window }
}

/** A failed Claude assistant message's final limit failure (status read from `API Error: NNN`), or null. */
export function assistantLimitFailure(error: unknown, text: string, resetsAt: string | null, window: string | null): LimitFailure | null {
  if (typeof error !== 'string' || !error) return null
  const match = /API Error:\s*(\d{3})\b/.exec(text)
  const status = match ? Number(match[1]) : null
  const message = text.trim() || null
  if (status === 402) return { type: 'failure', kind: error, final: true, status, message, resetsAt: null, window: CREDIT_LIMIT_WINDOW }
  if (!LIMIT_ERROR_CLASSES.has(error) && status !== 429) return null
  return { type: 'failure', kind: error, final: true, status, message, resetsAt, window }
}

/** The reset a rejected rate_limit_event announces (epoch seconds), as ISO; null otherwise. */
export function rejectedResetsAt(info: unknown): string | null {
  if (!isObject(info) || info.status !== 'rejected' || typeof info.resetsAt !== 'number' || !Number.isFinite(info.resetsAt)) return null
  return new Date(info.resetsAt * 1000).toISOString()
}

/** The window a rejected rate_limit_event names; null otherwise. */
export function rejectedWindow(info: unknown): string | null {
  if (!isObject(info) || info.status !== 'rejected' || typeof info.rateLimitType !== 'string' || info.rateLimitType === '') return null
  return info.rateLimitType
}

const FIXED_OFFSET = /^([+-])(\d{2}):(\d{2})$/

/** Minutes east of UTC for a `±HH:MM` offset or an IANA zone at an instant; null when unusable. */
function offsetMinutes(timeZone: string, at: number): number | null {
  const fixed = FIXED_OFFSET.exec(timeZone)
  if (fixed) {
    const minutes = Number(fixed[2]) * 60 + Number(fixed[3])
    return Number(fixed[2]) > 23 || Number(fixed[3]) > 59 ? null : fixed[1] === '-' ? -minutes : minutes
  }
  try {
    const name = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' }).formatToParts(at).find((part) => part.type === 'timeZoneName')?.value ?? ''
    const match = /^GMT(?:([+-])(\d{2}):(\d{2}))?$/.exec(name)
    if (!match) return null
    const minutes = match[1] ? Number(match[2]) * 60 + Number(match[3]) : 0
    return match[1] === '-' ? -minutes : minutes
  } catch {
    return null
  }
}

/** Whether a reset time zone (IANA zone or `±HH:MM`) is usable. */
export function isResetTimeZone(timeZone: string): boolean {
  return offsetMinutes(timeZone, Date.now()) !== null
}

/** A zone-less `reset at YYYY-MM-DD HH:MM[:SS]` in error text, read in `timeZone`; null when absent or unusable. */
export function textResetsAt(text: string, timeZone: string): string | null {
  const match = /\breset(?:s)?\s+at\s+(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/i.exec(text)
  if (!match) return null
  const [year, month, day, hour, minute, second] = match.slice(1).map((part) => Number(part ?? 0)) as [number, number, number, number, number, number]
  const wall = Date.UTC(year, month - 1, day, hour, minute, second)
  const check = new Date(wall)
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day || check.getUTCHours() !== hour || check.getUTCMinutes() !== minute || check.getUTCSeconds() !== second) return null
  const first = offsetMinutes(timeZone, wall)
  if (first === null) return null
  const offset = offsetMinutes(timeZone, wall - first * 60_000) ?? first
  return new Date(wall - offset * 60_000).toISOString()
}

/** An announced reset wins; otherwise a final failure's text is read in the host's `timeZone`. */
export function withTextReset(failure: LimitFailure, timeZone: string | undefined): LimitFailure {
  if (failure.resetsAt || !failure.final || !failure.message || !timeZone) return failure
  const resetsAt = textResetsAt(failure.message, timeZone)
  return resetsAt ? { ...failure, resetsAt } : failure
}

/** Why a Codex turn hit a limit: the shared login or plan, or the session's own budget; null for other failures. */
export function codexLimitScope(info: unknown): 'login' | 'session' | null {
  if (info === 'usageLimitExceeded' || info === 'rateLimitExceeded' || info === 'serverOverloaded') return 'login'
  if (info === 'sessionBudgetExceeded') return 'session'
  return null
}

/** A Codex error's limit failure (`final` as given), or null when its codexErrorInfo is not a limit kind. */
export function codexLimitFailure(error: unknown, final: boolean, snapshot: unknown): LimitFailure | null {
  if (!isObject(error) || codexLimitScope(error.codexErrorInfo) === null) return null
  const message = typeof error.message === 'string' && error.message.trim() !== '' ? error.message : null
  return { type: 'failure', kind: error.codexErrorInfo as string, final, status: null, message, resetsAt: codexExhaustedReset(snapshot), window: null }
}
