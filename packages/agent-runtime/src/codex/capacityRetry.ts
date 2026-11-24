// The Codex capacity retry policy (codex-capacity-retry D3, task 1.2): pure
// timing decisions over injected clocks, random source and timers; the
// effects live in capacityRecovery.ts.
// - Window. The first eligible terminal `serverOverloaded` of a logical turn
//   fixes `deadline = monotonic now + 600_000 ms`; nothing extends it (not
//   progress, duplicate frames or another capacity failure). An equivalent
//   epoch deadline is kept for display only.
// - Delay. For retry ordinal n (1-based, counting this runtime's retries,
//   never Codex's internal attempts): cap = min(60_000, 2_000 * 2^(n-1)), and
//   the delay is the positive equal-jitter sample
//   floor(cap/2 + r * (cap/2 + 1)) clamped to cap, r in [0, 1): uniform over
//   the integers [cap/2, cap], never zero and never above sixty seconds.
// - Due. A retry whose due time is at or after the deadline is not
//   scheduled: only the deadline wakeup is armed (`expiring`), and no attempt
//   is squeezed into the remaining time.
// - Wake. Expiry is decided first from the monotonic clock: now >= deadline
//   expires; otherwise now < due waits again; otherwise dispatch. The timer
//   that fired is not trusted to name which of these it is, and a wall-clock
//   jump changes nothing (only `monotonic` decides).

export const CAPACITY_WINDOW_MS = 600_000
export const CAPACITY_BASE_DELAY_MS = 2_000
export const CAPACITY_MAX_DELAY_MS = 60_000

/** The policy's time, randomness and timer seam (tests inject a fake one). */
export interface CapacityClock {
  /** Milliseconds on a monotonic clock: the only input to dispatch eligibility. */
  monotonic(): number
  /** Epoch milliseconds, for display only. */
  epoch(): number
  /** A fraction in [0, 1). */
  random(): number
  setTimer(delayMs: number, fire: () => void): unknown
  clearTimer(handle: unknown): void
}

export const systemCapacityClock: CapacityClock = {
  monotonic: () => performance.now(),
  epoch: () => Date.now(),
  random: () => Math.random(),
  setTimer: (delayMs, fire) => setTimeout(fire, Math.max(0, delayMs)),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/** The delay cap of retry ordinal `ordinal` (1-based). */
export function capacityDelayCap(ordinal: number): number {
  const n = Math.max(1, Math.floor(ordinal))
  // 2_000 * 2^(n-1) passes 60_000 at n = 6; larger exponents stay capped (no overflow to Infinity matters).
  return Math.min(CAPACITY_MAX_DELAY_MS, CAPACITY_BASE_DELAY_MS * 2 ** Math.min(n - 1, 30))
}

/** The equal-jitter delay of retry ordinal `ordinal` for the random fraction `r`. */
export function capacityRetryDelay(ordinal: number, r: number): number {
  const cap = capacityDelayCap(ordinal)
  const fraction = Number.isFinite(r) ? Math.min(Math.max(r, 0), 1) : 0
  return Math.min(cap, Math.floor(cap / 2 + fraction * (cap / 2 + 1)))
}

/** The deadline a first terminal capacity failure at monotonic `now` fixes. */
export function capacityDeadline(now: number): number {
  return now + CAPACITY_WINDOW_MS
}

export type CapacitySchedule =
  /** Wake at `due` (monotonic) to dispatch retry `ordinal`. */
  | { kind: 'retry'; due: number; delayMs: number }
  /** No retry fits before the deadline: wake only at the deadline to expire. */
  | { kind: 'expiring'; due: number; delayMs: number }

/** Where retry `ordinal` lands, at monotonic `now`, inside `deadline` (T4: due at the deadline does not fit). */
export function capacitySchedule(now: number, deadline: number, ordinal: number, r: number): CapacitySchedule {
  const delayMs = capacityRetryDelay(ordinal, r)
  const due = now + delayMs
  if (due >= deadline) return { kind: 'expiring', due: deadline, delayMs: Math.max(0, deadline - now) }
  return { kind: 'retry', due, delayMs }
}

/** C1-C5: the structured capacity error, exactly; any other kind, a missing one or an object variant is not (never text). */
export function isCodexCapacityError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { codexErrorInfo?: unknown }).codexErrorInfo === 'serverOverloaded'
}

export type CapacityWake = 'expire' | 'wait' | 'dispatch'

/** A wakeup's decision at monotonic `now`: expiry first (L10), then early (L8), else dispatch (L9). */
export function capacityWake(now: number, due: number, deadline: number): CapacityWake {
  if (now >= deadline) return 'expire'
  if (now < due) return 'wait'
  return 'dispatch'
}
