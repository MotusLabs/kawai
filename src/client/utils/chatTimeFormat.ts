// Local presentation of chat message times (chat-transcript-layout D2): a
// short clock for the gutter, the full date, time, and zone for hover and
// assistive technology, and a calendar-day key and label for day separators.
// Every function takes the event's `at` through validTime, so an unknown or
// malformed time formats to null — never an Invalid Date string. `timeZone`
// is the test seam; the app always uses the browser's zone.
import { validTime } from '@shared/chatTime'

export interface ChatTimeLabels {
  /** The ISO value for `<time dateTime>`. */
  iso: string
  /** Short local clock, e.g. `14:05`. */
  clock: string
  /** Full local date and time with its zone. */
  full: string
}

// A formatter is expensive to construct. Cache formatting contexts, never
// message timestamps; explicit-zone callers cannot replace browser defaults.
const formatters = new Map<string, Intl.DateTimeFormat>()
const styles = {
  clock: { hour: '2-digit', minute: '2-digit' },
  full: { dateStyle: 'full', timeStyle: 'long' },
  day: { year: 'numeric', month: '2-digit', day: '2-digit' },
  dayLabel: { dateStyle: 'full' },
} as const

function formatter(kind: keyof typeof styles, timeZone?: string): Intl.DateTimeFormat {
  const key = JSON.stringify([kind, timeZone ?? null])
  let value = formatters.get(key)
  if (!value) {
    value = new Intl.DateTimeFormat(kind === 'day' ? 'en-CA' : undefined, { ...styles[kind], timeZone })
    // Bounded even if explicit-zone callers supply many different zones.
    if (formatters.size >= 32) formatters.delete(formatters.keys().next().value!)
    formatters.set(key, value)
  }
  return value
}

export function chatTimeLabels(at: string, timeZone?: string): ChatTimeLabels | null {
  const date = validTime(at)
  if (!date) return null
  return {
    iso: date.toISOString(),
    clock: formatter('clock', timeZone).format(date),
    full: formatter('full', timeZone).format(date),
  }
}

/** The local calendar day (`YYYY-MM-DD`) of a time, or null when unknown. */
export function chatDayKey(at: string, timeZone?: string): string | null {
  const date = validTime(at)
  if (!date) return null
  return formatter('day', timeZone).format(date)
}

/** A day separator's label, e.g. `Thursday, October 15, 2026`. */
export function chatDayLabel(at: string, timeZone?: string): string | null {
  const date = validTime(at)
  if (!date) return null
  return formatter('dayLabel', timeZone).format(date)
}
