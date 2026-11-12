// The package compatibility fixtures' one cleanup owner (task-98101592 A5,
// finding F2). Each driver a test starts is tracked here, and every stop of a
// tracked driver goes through stop(), which stores the driver's one stop
// promise before any effect and only then starts the kill, synchronously as a
// direct kill() would, so a reentrant or overlapping stop, from a test, a
// driver callback or the after-hook, joins that promise. finishAll() (the
// after-hook) stops every tracked driver and joins them all whatever rejects, then rethrows each
// failure no test asserted as the original object (an AggregateError of the
// originals when there are several). failed() suppresses a failure only after
// its raw causes matched exactly by identity, order and count.
import { expect } from 'bun:test'
import { AgentRuntimeError } from '../../src/errors.js'
import type { Driver } from './claudeDriverHarness.js'

/** A stop's outcome: resolved, or rejected with the original error. */
export interface StopOutcome {
  resolved: boolean
  error?: unknown
}

interface Entry {
  stopping: Promise<StopOutcome> | null
  asserted: boolean
}

/** Leaf causes of a stop rejection: AgentRuntimeError causes and AggregateError errors are opened, depth first. */
export function rawCauses(error: unknown): unknown[] {
  if (error instanceof AggregateError) return error.errors.flatMap((cause) => rawCauses(cause))
  if (error instanceof AgentRuntimeError && error.causes.length > 0) return error.causes.flatMap((cause) => rawCauses(cause))
  return [error]
}

export class CompatibilityCleanup {
  private readonly entries = new Map<Driver, Entry>()
  /** Kill bodies run per driver; kept after finishAll() so a test can count them. */
  private readonly killed = new WeakMap<Driver, number>()

  /** Track a driver; its stop is owned here from now on. */
  track(f: Driver): Driver {
    if (!this.entries.has(f)) this.entries.set(f, { stopping: null, asserted: false })
    return f
  }

  /** The driver's one stop: reserved before the kill runs, joined by every later call. */
  stop(f: Driver): Promise<StopOutcome> {
    const entry = this.entry(f)
    if (entry.stopping === null) {
      let begin!: (outcome: Promise<StopOutcome>) => void
      entry.stopping = new Promise<StopOutcome>((resolve) => (begin = resolve))
      // Reserved above; the body starts now, so a reentrant stop() inside kill() sees the stored promise.
      begin(
        (async () => {
          this.killed.set(f, (this.killed.get(f) ?? 0) + 1)
          try {
            await f.d.kill()
            return { resolved: true }
          } catch (error) {
            return { resolved: false, error }
          }
        })(),
      )
    }
    return entry.stopping
  }

  /** How many kill bodies ran for this driver (one, once stopped). */
  kills(f: Driver): number {
    return this.killed.get(f) ?? 0
  }

  /** Stop, require a failure whose raw causes are exactly `expected`, and only then mark it asserted. */
  async failed(f: Driver, expected: readonly unknown[]): Promise<StopOutcome> {
    const outcome = await this.stop(f)
    const raw = rawCauses(outcome.error)
    expect([outcome.resolved, raw.length]).toEqual([false, expected.length])
    raw.forEach((cause, index) => expect(cause).toBe(expected[index]))
    this.entry(f).asserted = true
    return outcome
  }

  /** The after-hook: stop and join every tracked driver, then rethrow each unasserted failure. */
  async finishAll(): Promise<void> {
    const tracked = [...this.entries]
    const outcomes = await Promise.allSettled(tracked.map(([f]) => this.stop(f)))
    for (const [f] of tracked) this.entries.delete(f)
    const unasserted: unknown[] = []
    outcomes.forEach((result, index) => {
      if (result.status === 'rejected') unasserted.push(result.reason)
      else if (!result.value.resolved && !tracked[index]![1].asserted) unasserted.push(result.value.error)
    })
    if (unasserted.length === 1) throw unasserted[0]
    if (unasserted.length > 1) throw new AggregateError(unasserted, 'unasserted compatibility-fixture stop failures')
  }

  private entry(f: Driver): Entry {
    const entry = this.entries.get(f)
    if (!entry) throw new Error('driver not tracked by this cleanup')
    return entry
  }
}
