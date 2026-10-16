// A message's local time (chat-transcript-layout D2): semantic `<time>` with
// the short clock shown, the full date, time, and zone on hover and read by
// assistive technology. An unknown time renders nothing.
import { chatTimeLabels } from '../../utils/chatTimeFormat'

export default function ChatTime({ at, className = '' }: { at: string; className?: string }) {
  const labels = chatTimeLabels(at)
  if (!labels) return null
  return <time dateTime={labels.iso} title={labels.full} className={`tabular-nums ${className}`.trim()}>
    <span aria-hidden="true">{labels.clock}</span>
    <span className="sr-only">{labels.full}</span>
  </time>
}
