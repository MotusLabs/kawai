// The auto-answer deadline's timer seam (question-auto-answer D2): the
// driver schedules through this interface, and tests install a manual clock
// they advance by hand instead of waiting on real timers.
export interface ChatTimerScheduler {
  /** Schedule `fire` after `ms`; returns an opaque handle for `cancel`. */
  schedule(ms: number, fire: () => void): unknown
  /** Cancel a scheduled fire; an unknown or already-fired handle is ignored. */
  cancel(handle: unknown): void
}

/** Production scheduler over the process's real timers. */
export const realTimerScheduler: ChatTimerScheduler = {
  schedule: (ms, fire) => setTimeout(fire, ms),
  cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}
