// Manual timer clock for the auto-answer deadline (question-auto-answer D2's
// seam): nothing fires on its own — tests advance it by hand, in schedule
// order, so settlement interleavings (QA-P1) are deterministic.
import type { ChatTimerScheduler } from '../../chat/timerScheduler'

export class ManualClock implements ChatTimerScheduler {
  private nextId = 1
  private readonly scheduled = new Map<number, { at: number; fire: () => void }>()
  private nowMs = 0

  schedule(ms: number, fire: () => void): unknown {
    const id = this.nextId++
    this.scheduled.set(id, { at: this.nowMs + ms, fire })
    return id
  }

  cancel(handle: unknown): void {
    this.scheduled.delete(handle as number)
  }

  /** Run every callback due at or before now+ms, earliest first. */
  advance(ms: number): void {
    const target = this.nowMs + ms
    for (;;) {
      const due = [...this.scheduled.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])
      if (due.length === 0) break
      const [id, timer] = due[0]!
      this.scheduled.delete(id)
      this.nowMs = Math.max(this.nowMs, timer.at)
      timer.fire()
    }
    this.nowMs = target
  }

  /** Live scheduled callbacks. */
  get pendingCount(): number {
    return this.scheduled.size
  }
}
