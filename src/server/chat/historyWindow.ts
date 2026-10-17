// The recent-history window a chat attach or history page delivers
// (chat-history-window design D1): pure and SDK-free, so it is unit-testable
// without a manager. Attach sends only the turns of the last 24 hours ending
// at the session's newest dated event — at least the newest turn — and a
// page (chat-history-page) sends the 24 hours before the oldest turn the
// client already holds, at least one turn. Units are turn boundaries, so a
// cut never separates a tool call from its result or splits an assistant
// message. `hasOlder` says whether anything older remains, and `startId`
// names the window's first event (the client's reconnect `historyFrom` and
// page `beforeId`).
import type { ChatEvent } from '../../shared/chat'
import { validTime } from '../../shared/chatTime'

/** Window length: attach and each page deliver one day of turns. */
export const HISTORY_WINDOW_MS = 24 * 60 * 60 * 1000

export interface HistoryWindowOptions {
  /**
   * Anchor override (ISO time): the window ends 24 hours before this instead
   * of the newest dated event. Tests pin it; production leaves it unset.
   */
  endAt?: string
  /**
   * Reconnect: the oldest event id the client already holds. When found and
   * older than the default start, the window begins at that event's unit so
   * a reconnect never trims what was shown. Unknown ids are ignored.
   */
  fromId?: string
  /**
   * Page: the oldest event id the client already holds. The page ends
   * before that event's unit and is anchored 24 hours before its time.
   * Unknown ids make the window `stale` (the client re-attaches).
   */
  beforeId?: string
  /**
   * Search reveal: an event id, or a `tool:<callId>` anchor as the search
   * emits them, resolved to the event carrying that tool call. Extends the
   * window back to that event's unit so the revealed row is included.
   * Unknown ids are ignored (the reveal falls back on its own).
   */
  throughId?: string
}

export interface HistoryWindowResult {
  /** The window's events, oldest first. */
  events: ChatEvent[]
  /** Id of the window's first event, or null when the window is empty. */
  startId: string | null
  /** True when events older than the window's start remain. */
  hasOlder: boolean
  /** True only when a named `beforeId` is not in the list. */
  stale?: boolean
}

/** One turn boundary unit: its start index and first valid time (ms). */
interface Unit {
  start: number
  /** First validTime in the unit, inherited from the previous dated unit when undated; null before any dated unit. */
  time: number | null
}

/** `request_resolved`, `notice`, and `error` carry no turn. */
function turnIdOf(event: ChatEvent): string | undefined {
  return 'turnId' in event ? event.turnId : undefined
}

/**
 * Cut points are index 0, every `turn_started`, and every new `turnId`:
 * live turns open with a `turn_started` event, while replayed user and peer
 * turns open with their message (the replay assigns each a fresh
 * `hist-turn-N`), so both shapes cut on turn boundaries. Events without a
 * turn (notices, request resolutions) belong to the unit they sit in.
 */
function unitsOf(events: ChatEvent[]): Unit[] {
  const units: Unit[] = []
  let lastTurnId: string | undefined
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!
    const turnId = turnIdOf(event)
    const opens =
      event.type === 'turn_started' ||
      (turnId !== undefined && turnId !== lastTurnId)
    if (turnId !== undefined) lastTurnId = turnId
    if (opens) units.push({ start: index, time: null })
    const unit = units[units.length - 1]
    if (unit && unit.time === null) {
      const time = validTime(event.at)
      if (time) unit.time = time.getTime()
    }
  }
  // An undated unit takes the nearest earlier dated unit's time, so it never
  // jumps the window; before any dated unit there is nothing to inherit.
  let previous: number | null = null
  for (const unit of units) {
    if (unit.time === null) {
      unit.time = previous
    } else {
      previous = unit.time
    }
  }
  return units
}

/** The newest valid time of any event, or null when none is dated. */
function newestTimeOf(events: ChatEvent[]): number | null {
  let newest: number | null = null
  for (const event of events) {
    const time = validTime(event.at)
    if (time && (newest === null || time.getTime() > newest)) newest = time.getTime()
  }
  return newest
}

/** A search anchor: an exact event id, or the event with that tool call. */
function resolveAnchor(events: ChatEvent[], anchorId: string): number {
  const exact = events.findIndex(event => event.id === anchorId)
  if (exact >= 0) return exact
  if (!anchorId.startsWith('tool:')) return -1
  const toolCallId = anchorId.slice('tool:'.length)
  return events.findIndex(
    event =>
      (event.type === 'tool_call' || event.type === 'tool_result') &&
      event.toolCallId === toolCallId
  )
}

export function historyWindow(
  events: ChatEvent[],
  options: HistoryWindowOptions = {}
): HistoryWindowResult {
  const empty: HistoryWindowResult = { events: [], startId: null, hasOlder: false }
  if (events.length === 0) return empty
  const units = unitsOf(events)
  /** The unit containing `index` (index 0 always opens the first unit). */
  const unitAt = (index: number): Unit => {
    let current = units[0]!
    for (const unit of units) {
      if (unit.start > index) break
      current = unit
    }
    return current
  }

  // A page both bounds (it ends before the named event's unit) and anchors
  // (24 hours before that unit's time) the window.
  let end = events.length
  let pageAnchor: number | null = null
  if (options.beforeId !== undefined) {
    const index = events.findIndex(event => event.id === options.beforeId)
    if (index < 0) return { ...empty, stale: true }
    end = unitAt(index).start
    pageAnchor = unitAt(index).time
  }

  const override = options.endAt !== undefined ? validTime(options.endAt) : null
  const anchor = override?.getTime() ?? pageAnchor ?? newestTimeOf(events)
  // No dated event at all: nothing to measure against, keep the whole list.
  if (anchor === null) {
    const window = events.slice(0, end)
    return { events: window, startId: window[0]?.id ?? null, hasOlder: false }
  }
  const cutoff = anchor - HISTORY_WINDOW_MS

  // At least one turn: start no later than the last unit inside the window.
  let start = 0
  for (const unit of units) {
    if (unit.start >= end) break
    start = unit.start
  }
  // The oldest unit inside the window: the first whose time reached the cutoff.
  for (const unit of units) {
    if (unit.start >= end) break
    if (unit.time !== null && unit.time >= cutoff) {
      start = unit.start
      break
    }
  }
  // Reconnect: widen to the client's oldest held event's unit.
  if (options.fromId !== undefined) {
    const index = events.findIndex(event => event.id === options.fromId)
    if (index >= 0) {
      const from = unitAt(index).start
      if (from < start) start = from
    }
  }
  // Search reveal: extend back to the revealed entry's unit.
  if (options.throughId !== undefined) {
    const index = resolveAnchor(events, options.throughId)
    if (index >= 0) {
      const through = unitAt(index).start
      if (through < start) start = through
    }
  }
  const window = events.slice(start, end)
  return { events: window, startId: window[0]?.id ?? null, hasOlder: start > 0 }
}
