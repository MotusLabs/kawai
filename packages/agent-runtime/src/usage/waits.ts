// Observed limit waits (design §6, task 5.3): the wait-start/wait-end
// lifetime both drivers report through onLimitEvent.
// - A retried limit failure on a turn starts one wait for that turn; a further
//   retry on the same turn keeps it.
// - It ends `resumed` only when the runtime is observed making progress on
//   that turn after the retry (the driver calls `progressed`).
// - A successful result on the turn is such progress. It ends `cancelled`
//   when the turn ends any other way (interrupt, stop, a failed result), and
//   `process-ended` when the process exits unexpectedly.
// No timer runs and no reset time or quota percentage ends a wait. Each
// transition returns the events to publish; the driver decides its own facts
// first and publishes after.
import type { LimitWaitEnd, LimitWaitStart } from './types.js'

export class LimitWaits {
  private readonly open = new Map<string, string>()

  /** A retried limit failure on `turnId`: the wait-start to publish, or null when one is open. */
  retried(turnId: string, window: string | null, resetsAt: string | null): LimitWaitStart | null {
    if (this.open.has(turnId)) return null
    const waitId = crypto.randomUUID()
    this.open.set(turnId, waitId)
    return { type: 'wait-start', waitId, turnId, window, resetsAt }
  }

  /** The runtime made progress on `turnId`: its open wait ends resumed. */
  progressed(turnId: string): LimitWaitEnd | null {
    return this.end(turnId, 'resumed')
  }

  /** The turn ended: `resumed` only for a successful result. */
  ended(turnId: string, cause: LimitWaitEnd['cause']): LimitWaitEnd | null {
    return this.end(turnId, cause)
  }

  /** Every open wait ends with `cause` (a stop or an unexpected exit). */
  endAll(cause: 'cancelled' | 'process-ended'): LimitWaitEnd[] {
    const ends = [...this.open.values()].map((waitId) => ({ type: 'wait-end' as const, waitId, cause }))
    this.open.clear()
    return ends
  }

  private end(turnId: string, cause: LimitWaitEnd['cause']): LimitWaitEnd | null {
    const waitId = this.open.get(turnId)
    if (waitId === undefined) return null
    this.open.delete(turnId)
    return { type: 'wait-end', waitId, cause }
  }
}
