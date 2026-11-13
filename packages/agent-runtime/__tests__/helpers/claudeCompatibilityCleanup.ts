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
//
// The reservation and the join are the shared test helper ownedCleanup.ts
// (task-666e5edd), which Kawai's Claude runtime harness uses too: an
// overlapping finishAll() gets the pending join, and a driver tracked while
// it is pending is stopped and joined by it. The stop body, the outcome shape
// and the assertion rule stay here.
import { expect } from 'bun:test'
import { AgentRuntimeError } from '../../src/errors.js'
import type { Driver } from './claudeDriverHarness.js'
import { ownedAggregate, ownedOnce, type OwnedOnce } from './ownedCleanup.js'

/** A stop's outcome: resolved, or rejected with the original error. */
export interface StopOutcome {
  resolved: boolean
  error?: unknown
}

interface Entry {
  stop: OwnedOnce<StopOutcome>
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
  private readonly owned = ownedAggregate<Driver, StopOutcome>({
    join: (f) => this.stop(f),
    failures: (f, outcome) => {
      // Read before the entry leaves: only an asserted stop failure is suppressed.
      const asserted = this.entries.get(f)?.asserted === true
      this.entries.delete(f)
      if (outcome.status === 'rejected') return [outcome.reason]
      return !outcome.value.resolved && !asserted ? [outcome.value.error] : []
    },
    message: 'unasserted compatibility-fixture stop failures',
  })

  /** Track a driver; its stop is owned here from now on. */
  track(f: Driver): Driver {
    if (!this.entries.has(f)) {
      this.entries.set(f, { stop: ownedOnce<StopOutcome>(), asserted: false })
      this.owned.add(f)
    }
    return f
  }

  /** The driver's one stop: reserved before the kill runs, joined by every later call. */
  stop(f: Driver): Promise<StopOutcome> {
    // Reserved first; the body starts now, so a reentrant stop() inside kill() sees the stored promise.
    return this.entry(f).stop.run(async () => {
      this.killed.set(f, (this.killed.get(f) ?? 0) + 1)
      try {
        await f.d.kill()
        return { resolved: true }
      } catch (error) {
        return { resolved: false, error }
      }
    })
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
  finishAll(): Promise<void> {
    return this.owned.join()
  }

  private entry(f: Driver): Entry {
    const entry = this.entries.get(f)
    if (!entry) throw new Error('driver not tracked by this cleanup')
    return entry
  }
}
