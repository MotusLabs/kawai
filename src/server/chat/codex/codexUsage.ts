// Codex rate-limit normalization (codex-chat-sessions D9, PR E 7.1): the
// app-server's RateLimitSnapshot — pushed on `account/rateLimits/updated`
// and returned by `account/rateLimits/read` — becomes the same
// ChatUsageReport Claude plans use, so the usage bar renders Codex windows
// through the existing meter. One window per primary/secondary, keyed
// `codex:primary`/`codex:secondary`; the label comes from
// windowDurationMins (300 → 5-hour, 10080 → weekly) with Codex's limit
// name appended when it names one, and the window length rides as periodMs
// for the bar's elapsed marker. A window without a usable percentage is
// dropped while the others still render. Pure and SDK-free, so tests pin
// the recorded wire shapes.
import type { ChatUsageReport, ChatUsageSource, ChatUsageWindow } from '../../../shared/chat'
import { percentValue, toIsoResetsAt } from '../usageLimits'
import type { RateLimitSnapshot } from './protocol/v2/RateLimitSnapshot'

/** Display label for one window's length; null or unusable falls back to a plain window. */
export function codexWindowLabel(mins: number | null): string {
  if (mins === null || !Number.isFinite(mins) || mins <= 0) return 'Window'
  if (mins === 300) return '5-hour'
  if (mins === 10080) return 'weekly'
  if (mins % 1440 === 0) return `${mins / 1440}-day`
  if (mins % 60 === 0) return `${mins / 60}-hour`
  return `${mins} min`
}

/** One primary/secondary window, or null when its percentage is unusable. */
function codexWindow(
  key: string,
  window: { usedPercent?: unknown; windowDurationMins?: unknown; resetsAt?: unknown } | null | undefined,
  limitName: unknown,
): ChatUsageWindow | null {
  const percentUsed = percentValue(window?.usedPercent)
  if (percentUsed === null) return null
  const mins = typeof window?.windowDurationMins === 'number' && Number.isFinite(window.windowDurationMins)
    ? window.windowDurationMins
    : null
  const name = typeof limitName === 'string' && limitName.trim() !== '' ? limitName.trim() : null
  const label = codexWindowLabel(mins)
  return {
    key,
    label: name ? `${label} · ${name}` : label,
    percentUsed,
    resetsAt: toIsoResetsAt(window?.resetsAt),
    ...(mins !== null ? { periodMs: mins * 60_000 } : {}),
  }
}

/**
 * A Codex rate-limit snapshot as a usage report. The report is limited
 * while Codex's rateLimitReachedType is set (any reached kind), whatever
 * the individual windows read; otherwise allowed — Codex pushes no warning
 * severity for these windows.
 */
export function normalizeRateLimitSnapshot(
  snapshot: RateLimitSnapshot | null | undefined,
  receivedAt: string = new Date().toISOString(),
  source: ChatUsageSource = 'push',
): ChatUsageReport {
  const windows: ChatUsageWindow[] = []
  const primary = codexWindow('codex:primary', snapshot?.primary, snapshot?.limitName)
  if (primary) windows.push(primary)
  const secondary = codexWindow('codex:secondary', snapshot?.secondary, snapshot?.limitName)
  if (secondary) windows.push(secondary)
  return {
    status: snapshot?.rateLimitReachedType != null ? 'limited' : 'allowed',
    windows,
    receivedAt,
    source,
  }
}

/** The usage read reply's snapshot, or null when it carries none. */
export function snapshotOfRateLimitsRead(result: unknown): RateLimitSnapshot | null {
  const rateLimits = (result as { rateLimits?: unknown } | null | undefined)?.rateLimits
  return rateLimits && typeof rateLimits === 'object' ? rateLimits as RateLimitSnapshot : null
}
