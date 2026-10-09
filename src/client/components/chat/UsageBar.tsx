// The usage bar (usage bar design D5): glanceable chrome directly under the
// chat header — one thin utilization meter per known plan window, labelled
// with the percent used and the local reset time. Warning and limited
// reports tint the meters. Nothing renders when the profile has no window
// data: the bar is "always visible" only in the sense that it never has to
// be opened, never as a placeholder with nothing to report. A missing
// window is omitted, not shown empty, so a provider reporting only some
// meters gets a shorter bar.
import type { ChatUsageReport, ChatUsageWindow } from '@shared/chat'

/** Local reset time; the weekday joins once it is more than a day away. */
export function formatUsageReset(resetsAt: string, now: number = Date.now()): string {
  const resets = new Date(resetsAt)
  if (Number.isNaN(resets.getTime())) return ''
  const far = resets.getTime() - now > 24 * 60 * 60 * 1000
  return far
    ? resets.toLocaleString(undefined, {
        weekday: 'short',
        hour: 'numeric',
        minute: '2-digit',
      })
    : resets.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

export default function UsageBar({ report }: { report: ChatUsageReport | null }) {
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
      <div className="mx-auto flex max-w-3xl flex-col gap-1.5">
        {report.windows.map((window) => (
          <UsageMeter key={window.key} window={window} />
        ))}
      </div>
    </div>
  )
}

function UsageMeter({ window }: { window: ChatUsageWindow }) {
  // The fill clamps to the track; percents are already 0-100 by contract.
  const percent = Math.round(window.percentUsed)
  return (
    <div
      className="flex items-center gap-2 text-chat-meta text-secondary"
      data-testid="chat-usage-window"
      data-key={window.key}
    >
      <span className="w-28 shrink-0 truncate" data-testid="chat-usage-label">{window.label}</span>
      <span className="chat-usage-meter" aria-hidden="true">
        <span
          className="chat-usage-fill"
          style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
        />
      </span>
      <span className="shrink-0 tabular-nums" data-testid="chat-usage-percent">{percent}%</span>
      {window.resetsAt && (
        <span className="shrink-0 truncate" data-testid="chat-usage-reset">
          resets {formatUsageReset(window.resetsAt)}
        </span>
      )}
    </div>
  )
}
