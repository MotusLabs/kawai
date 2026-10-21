// Codex limit signals (codex-chat-sessions D9, PR E 7.2): the driver maps a
// failed turn's codexErrorInfo and a retrying `error` notification onto the
// same ChatLimitSignal the Claude drivers report, so cooldown, park, release,
// forward, and the urgent-mail refusal work unchanged. The reset comes from
// the latest rate-limit snapshot the session received: the latest resetsAt
// among its exhausted windows (used percent at 100 — the snapshot names no
// window when the limit is reached); a window below its limit never extends
// it, and none known leaves the 1 h default. Login- or plan-scoped kinds
// record once for the Codex home's provider (`codex-home-<12 hex>`), so
// every profile on the home cools through the shared cooldown; the session's
// own budget cools its profile alone, with no provider. A 402 is not a
// credit limit here — the credit rule belongs to the Claude paths
// (openrouter-provider 3.1) — and any Codex failure outside the table
// records nothing at all.
import type { ChatLimitSignal } from '../limitSignals'
import { toIsoResetsAt } from '../usageLimits'
import type { CodexErrorInfo } from './protocol/v2/CodexErrorInfo'
import type { RateLimitSnapshot } from './protocol/v2/RateLimitSnapshot'

/** Why a Codex turn hit a limit: the shared login or plan, or one session's own budget. */
export type CodexLimitScope = 'login' | 'session'

/** The fields of a turn or notification error the signal reads. */
interface CodexErrorSlice {
  codexErrorInfo?: unknown
  message?: unknown
}

/** The scope of a Codex limit kind, or null for every other failure. */
export function codexLimitScope(info: CodexErrorInfo | null | undefined): CodexLimitScope | null {
  if (info === 'usageLimitExceeded' || info === 'rateLimitExceeded' || info === 'serverOverloaded') return 'login'
  if (info === 'sessionBudgetExceeded') return 'session'
  return null
}

/**
 * The latest reset among the snapshot's exhausted windows, as ISO; null when
 * no window is exhausted or carries a usable time.
 */
export function latestExhaustedReset(snapshot: RateLimitSnapshot | null | undefined): string | null {
  let latest: string | null = null
  for (const window of [snapshot?.primary, snapshot?.secondary]) {
    if (!window || typeof window.usedPercent !== 'number' || window.usedPercent < 100) continue
    const reset = toIsoResetsAt(window.resetsAt)
    if (reset && (latest === null || Date.parse(reset) > Date.parse(latest))) latest = reset
  }
  return latest
}

/** The signal's message, or null when the error names none. */
function signalMessage(error: CodexErrorSlice): string | null {
  return typeof error.message === 'string' && error.message.trim() !== '' ? error.message : null
}

/** The failed turn's final limit signal, or null for every other failure. */
export function codexTurnLimitSignal(
  turn: { status?: unknown; error?: CodexErrorSlice | null },
  latestSnapshot: RateLimitSnapshot | null | undefined,
): ChatLimitSignal | null {
  if (turn.status !== 'failed' || !turn.error) return null
  const info = turn.error.codexErrorInfo
  if (!codexLimitScope(info as CodexErrorInfo | undefined)) return null
  return {
    kind: info as string,
    final: true,
    status: null,
    message: signalMessage(turn.error),
    resetsAt: latestExhaustedReset(latestSnapshot),
    window: null,
  }
}

/** A retrying `error` notification's non-final signal; a not-retrying one records nothing. */
export function codexRetryLimitSignal(
  notification: { willRetry?: unknown; error?: CodexErrorSlice | null } | null | undefined,
  latestSnapshot: RateLimitSnapshot | null | undefined,
): ChatLimitSignal | null {
  if (notification?.willRetry !== true || !notification.error) return null
  const info = notification.error.codexErrorInfo
  if (!codexLimitScope(info as CodexErrorInfo | undefined)) return null
  return {
    kind: info as string,
    final: false,
    status: null,
    message: signalMessage(notification.error),
    resetsAt: latestExhaustedReset(latestSnapshot),
    window: null,
  }
}

/**
 * The provider a recorded Codex limit event names: the home's provider for
 * the login-scoped kinds (one event cools every profile on the home), none
 * for the session's own budget. Every other kind — a Claude kind included —
 * passes its provider through unchanged.
 */
export function codexLimitProviderId(kind: string, homeProviderId: string): string | null {
  return codexLimitScope(kind as CodexErrorInfo) === 'session' ? null : homeProviderId
}
