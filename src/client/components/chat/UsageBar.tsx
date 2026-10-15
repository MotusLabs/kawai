// The usage bar (usage bar design D5): glanceable chrome directly under the
// chat header — one thin utilization meter per known plan window, labelled
// with the percent used and the local reset time. Warning and limited
// reports tint the meters. Nothing renders when the profile has no window
// data: the bar is "always visible" only in the sense that it never has to
// be opened, never as a placeholder with nothing to report. A missing
// window is omitted, not shown empty, so a provider reporting only some
// meters gets a shorter bar.
//
// Elapsed time (usage-bar-time-pace): a window whose server-supplied period
// length and reset time are known gets a thin tick on its track at the share
// of the window already gone, so fill past the tick reads as usage ahead of
// an even pace. The tick adds no row, column, or text; the exact numbers sit
// in the row's hover text and the track's accessible label. A minute clock
// moves the tick between reports; a passed reset hides it until new data.
import type { ChatUsageReport, ChatUsageWindow } from '@shared/chat'
import { useTickingClock } from './chatElapsed'

const MINUTE_MS = 60 * 1000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

/** Local reset time; the weekday joins once it is more than a day away. */
export function formatUsageReset(resetsAt: string, now: number = Date.now()): string {
  const resets = new Date(resetsAt)
  if (Number.isNaN(resets.getTime())) return ''
  const far = resets.getTime() - now > DAY_MS
  return far
    ? resets.toLocaleString(undefined, {
        weekday: 'short',
        hour: 'numeric',
        minute: '2-digit',
      })
    : resets.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

/**
 * Share of the window already elapsed, 0-1: one minus time left over the
 * period. Null — no marker — without a usable reset time or period, or once
 * the reset has passed (the held usage is stale until the next report).
 */
export function usageElapsedShare(window: ChatUsageWindow, now: number): number | null {
  if (!window.resetsAt || !window.periodMs || window.periodMs <= 0) return null
  const resets = Date.parse(window.resetsAt)
  if (Number.isNaN(resets) || resets <= now) return null
  return Math.min(1, Math.max(0, 1 - (resets - now) / window.periodMs))
}

/** Time left as `3d 4h`, `2h 30m`, `45m`, or `<1m`. */
export function formatUsageTimeLeft(ms: number): string {
  if (ms < MINUTE_MS) return '<1m'
  const days = Math.floor(ms / DAY_MS)
  const hours = Math.floor((ms % DAY_MS) / HOUR_MS)
  const minutes = Math.floor((ms % HOUR_MS) / MINUTE_MS)
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

export default function UsageBar({ report }: { report: ChatUsageReport | null }) {
  // Tick only while some window could carry a marker; the render reads the
  // clock itself so a newly eligible window is placed at once.
  const markable = report?.windows.some((window) => window.resetsAt && window.periodMs) ?? false
  useTickingClock(markable, MINUTE_MS)
  const now = Date.now()
  if (!report || report.windows.length === 0) return null
  const statusClass =
    report.status === 'warning'
      ? 'chat-usage-warning'
      : report.status === 'limited'
        ? 'chat-usage-limited'
        : ''
  return (
    <div
      className={`chat-usage border-b border-border px-3 py-2 ${statusClass}`}
      data-testid="chat-usage"
      data-status={report.status}
    >
      <div className="mx-auto flex max-w-2xl flex-col gap-1.5">
        {report.windows.map((window) => (
          <UsageMeter key={window.key} window={window} now={now} />
        ))}
      </div>
    </div>
  )
}

function UsageMeter({ window, now }: { window: ChatUsageWindow; now: number }) {
  // The fill clamps to the track; percents are already 0-100 by contract.
  const percent = Math.round(window.percentUsed)
  const elapsed = usageElapsedShare(window, now)
  const elapsedPercent = elapsed === null ? null : Math.round(elapsed * 100)
  const reset = window.resetsAt ? formatUsageReset(window.resetsAt, now) : ''
  const summary =
    elapsedPercent !== null && window.resetsAt
      ? `${percent}% used · ${elapsedPercent}% of window elapsed · resets in ${formatUsageTimeLeft(Date.parse(window.resetsAt) - now)}`
      : reset
        ? `${percent}% used · resets ${reset}`
        : `${percent}% used`
  return (
    <div
      className="flex items-center gap-2 text-chat-meta text-secondary"
      data-testid="chat-usage-window"
      data-key={window.key}
      title={summary}
    >
      <span className="w-28 shrink-0 truncate" data-testid="chat-usage-label">{window.label}</span>
      <span
        className="chat-usage-meter"
        data-testid="chat-usage-meter"
        {...(elapsedPercent === null
          ? { 'aria-hidden': true }
          : { role: 'img', 'aria-label': `${window.label}: ${summary}` })}
      >
        <span
          className="chat-usage-fill"
          style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
        />
        {elapsed !== null && (
          <span
            className="chat-usage-time"
            data-testid="chat-usage-time"
            style={{ left: `${elapsed * 100}%` }}
          />
        )}
      </span>
      <span className="shrink-0 tabular-nums" data-testid="chat-usage-percent">{percent}%</span>
      {reset && (
        <span className="shrink-0 truncate" data-testid="chat-usage-reset">
          resets {reset}
        </span>
      )}
    </div>
  )
}
