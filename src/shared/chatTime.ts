// Chat event times (chat-transcript-layout D2). `ChatEventBase.at` is an ISO
// string, or empty when the source recorded no time (undated history rows);
// every consumer reads it through validTime so an unknown or malformed value
// yields nothing rather than an Invalid Date or a guessed clock.

/** The event time as a Date, or null when it is unknown or unparseable. */
export function validTime(at: string | null | undefined): Date | null {
  if (!at) return null
  const date = new Date(at)
  return Number.isNaN(date.getTime()) ? null : date
}

/** The earlier of two event times, keeping a valid one over an unknown one. */
export function earliestTime(first: string, second: string): string {
  const a = validTime(first)
  const b = validTime(second)
  if (!a) return b ? second : first
  if (!b) return first
  return b.getTime() < a.getTime() ? second : first
}
