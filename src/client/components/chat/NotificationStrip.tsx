// The notification strip (notification strip design D7): glanceable warnings
// directly under the chat header, beside the usage bar — one line per active
// notice, styled by severity, each closable. Nothing renders when the
// session has no visible notices: the strip is never a placeholder. Closing
// routes by source (design D6): the caller's close action sends agent
// dismissals to the server and hides account notices per browser tab.
import type { ChatNotification } from '@shared/chat'

/** Solid semantic tokens; /opacity utilities are dead CSS in this project. */
const SEVERITY_CLASS: Record<ChatNotification['severity'], string> = {
  warning: 'text-approval',
  error: 'text-chat-danger',
  info: 'text-primary',
}

export default function NotificationStrip({ notifications, onClose }: {
  notifications: ChatNotification[]
  onClose: (notice: ChatNotification) => void
}) {
  if (notifications.length === 0) return null
  return (
    <div className="border-b border-border px-3 py-2" data-testid="chat-notifications">
      <ul className="mx-auto flex max-w-3xl flex-col gap-1">
        {notifications.map((notice) => (
          <NotificationRow key={`${notice.source}:${notice.key}`} notice={notice} onClose={onClose} />
        ))}
      </ul>
    </div>
  )
}

function NotificationRow({ notice, onClose }: {
  notice: ChatNotification
  onClose: (notice: ChatNotification) => void
}) {
  return (
    <li
      className={`flex items-center gap-2 text-chat-meta ${SEVERITY_CLASS[notice.severity]}`}
      data-testid="chat-notification"
      data-severity={notice.severity}
      data-key={notice.key}
    >
      {(notice.severity === 'warning' || notice.severity === 'error') && (
        <span aria-hidden="true">⚠</span>
      )}
      <span className="min-w-0 flex-1 truncate">
        {notice.text}
        {notice.hint && <span className="text-secondary"> · {notice.hint}</span>}
      </span>
      <button
        type="button"
        className="btn shrink-0 px-1.5 py-0 text-chat-meta text-secondary"
        aria-label={`Dismiss ${notice.text}`}
        data-testid="chat-notification-close"
        onClick={() => onClose(notice)}
      >
        ×
      </button>
    </li>
  )
}
