// Text for a chat session paused with parked work (profile routing): the
// reason and, when known, the local time its resume is due.
import type { SessionParkedState } from '@shared/types'

export function parkedLabel(parked: SessionParkedState): string {
  if (!parked.until) return `Paused: ${parked.reason}`
  const until = new Date(parked.until)
  const sameDay = until.toDateString() === new Date().toDateString()
  const time = sameDay
    ? until.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : until.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  return `Paused: ${parked.reason} · resumes ${time}`
}
