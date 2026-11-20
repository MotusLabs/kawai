// The independent reference model of codex-capacity-retry's lifecycle and
// timing tables (design "Acceptance oracles"), for the P1-P3 model-based
// properties. It is written from the tables, not from capacityRecovery.ts:
// it predicts, per logical turn, the phase (idle / running attempt / backoff),
// the fixed monotonic deadline, the next due time, the retry ordinal, how many
// continuations were dispatched, how many terminal events were published and
// which native attempts must receive the one cleanup interrupt.
// - Timing (T1-T3): cap = min(60000, 2000 * 2^(n-1)); delay =
//   min(cap, floor(cap/2 + r * (cap/2 + 1))).
// - L2/L3/L4: a capacity completion fixes the deadline once; at or after it
//   the turn ends (L4); a due at or after it only expires (L3), else one retry.
// - L8/L9/L10 at each wakeup, expiry first: now >= deadline ends the turn,
//   now < due waits, else one continuation is dispatched.
// - L11/L12/L20: Stop or an urgent interruption ends the turn; only a running
//   attempt gets a turn/interrupt (once its id is known); backoff gets none.
// - L13: human input during backoff ends the turn (interrupted) and opens a
//   new one; during a running attempt it steers (no model change).

export const WINDOW = 600_000

export function referenceDelay(n: number, r: number): number {
  const cap = Math.min(60_000, 2_000 * 2 ** (n - 1))
  return Math.min(cap, Math.floor(cap / 2 + r * (cap / 2 + 1)))
}

export type Phase = 'idle' | 'running' | 'backoff'

export class CapacityModel {
  phase: Phase = 'idle'
  deadline: number | null = null
  due: number | null = null
  ordinal = 0
  continuations = 0
  terminals = 0
  /** Attempt ids the model expects one cleanup or Stop interrupt for, in order. */
  readonly interrupts: string[] = []
  /** Every dispatched continuation's time and the deadline it had to beat (P2). */
  readonly dispatches: Array<{ at: number; deadline: number }> = []

  /** A matching terminal capacity completion of the running attempt at `now`, with random fraction `r`. */
  capacityFailure(now: number, r: number): void {
    this.deadline ??= now + WINDOW
    if (now >= this.deadline) return this.end()
    const n = this.ordinal + 1
    const due = now + referenceDelay(n, r)
    if (due >= this.deadline) {
      this.due = this.deadline
    } else {
      this.ordinal = n
      this.due = due
    }
    this.phase = 'backoff'
  }

  /** A success, another failure or a refused continuation start: the turn ends once. */
  end(): void {
    this.terminals += 1
    this.phase = 'idle'
    this.deadline = null
    this.due = null
    this.ordinal = 0
  }

  /** A new logical turn opens (human, peer or urgent input) with a fresh budget. */
  open(): void {
    this.phase = 'running'
    this.deadline = null
    this.due = null
    this.ordinal = 0
  }

  /** One wakeup at `now` (L8-L10); returns whether a continuation was dispatched. */
  wake(now: number): boolean {
    if (this.phase !== 'backoff' || this.due === null || this.deadline === null) return false
    if (now >= this.deadline) {
      this.end()
      return false
    }
    if (now < this.due) return false
    this.dispatches.push({ at: now, deadline: this.deadline })
    this.continuations += 1
    this.phase = 'running'
    this.due = null
    return true
  }

  /** Time moves from `from` to `to` with timers firing at their due times: every wakeup in between. */
  advance(from: number, to: number): number[] {
    const dispatched: number[] = []
    let now = from
    while (this.phase === 'backoff' && this.due !== null && this.due <= to) {
      now = Math.max(now, this.due)
      if (this.wake(now)) dispatched.push(now)
    }
    return dispatched
  }

  /** The backend ended before a cancelled attempt's id was known (L16): its cleanup interrupt is no longer owed. */
  forget(attempt: string): void {
    const index = this.interrupts.lastIndexOf(attempt)
    if (index >= 0) this.interrupts.splice(index, 1)
  }

  /** Stop, urgent interruption or lifecycle end (L11, L12, L20): `attempt` is the running attempt's id, if any. */
  cancel(attempt: string | null): void {
    if (this.phase === 'running' && attempt !== null) this.interrupts.push(attempt)
    if (this.phase !== 'idle') this.end()
  }
}
