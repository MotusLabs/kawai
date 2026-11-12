// The one test-cleanup owner the Claude fixtures share (task-666e5edd):
// Kawai's src/server/__tests__/fixtures/claudeRuntimeHarness.ts and the
// package's helpers/claudeCompatibilityCleanup.ts delegate their join
// mechanics here and keep their own stop bodies, outcome shapes and
// assertion rules. Test code only: no production export, no dependency, no
// imports, so package tests stay independent of Kawai.
//
// - ownedOnce(): one owned cleanup. The promise is reserved before the body
//   runs, and the body starts synchronously inside the first run(), so a
//   reentry from the body (or a callback it triggers) and every overlapping
//   call get that same promise; one body runs, ever.
// - ownedAggregate(): a suite-level join over registered entries
//   (task-602c71e9 R6/R7, findings-74686a77 F2 and findings-7712679a). One
//   in-flight join is reserved before any entry's cleanup runs and handed to
//   every overlapping caller. One owner drains: it joins every live entry
//   with allSettled (entries registered while it waits are joined by a later
//   pass), removes an entry only after its cleanup settled, and collects the
//   failures the caller's filter reports. The final empty observation, the
//   release of the slot and the settlement of the reserved promise are one
//   synchronous step in that owner's own continuation, on success and
//   failure alike, so a later call gets a new join only after the previous
//   one settled. One failure rejects as the original value (undefined, null
//   and primitives included); several reject as an AggregateError of the
//   originals in order.
//
// The helper owns join mechanics only. It does not know its caller's
// context: a cleanup that awaits its own join from inside a callback that
// cleanup owns still waits on itself, and the fixtures keep their own
// guards against that.

/** One owned cleanup: reserved before its body runs, shared by every call. */
export interface OwnedOnce<T> {
  /** Runs `body` once, synchronously on the first call; every call returns the one reserved promise. */
  run(body: () => Promise<T>): Promise<T>
  /** The reserved promise, or null before the first run(). */
  readonly current: Promise<T> | null
}

export function ownedOnce<T>(): OwnedOnce<T> {
  let reserved: Promise<T> | null = null
  return {
    get current() {
      return reserved
    },
    run(body) {
      if (reserved) return reserved
      let settle!: { resolve(value: T): void; reject(error: unknown): void }
      reserved = new Promise<T>((resolve, reject) => (settle = { resolve, reject }))
      // Every caller and the aggregate observe this promise; a rejection nobody awaited yet is not a crash.
      void reserved.catch(() => {})
      let started: Promise<T>
      try {
        started = body()
      } catch (error) {
        started = Promise.reject(error)
      }
      started.then(settle.resolve, settle.reject)
      return reserved
    },
  }
}

export interface OwnedAggregateOptions<E, R> {
  /** The entry's outside cleanup, joined before the entry leaves the set. */
  join(entry: E): Promise<R>
  /** The original failures to report for a joined entry (none once the caller asserted them). */
  failures(entry: E, outcome: PromiseSettledResult<R>): readonly unknown[]
  /** The AggregateError message when several failures are reported. */
  message: string
}

/** A suite-level join over registered entries (see the header). */
export interface OwnedAggregate<E> {
  /** Register an entry; idempotent. A pending join owns it. */
  add(entry: E): void
  has(entry: E): boolean
  readonly size: number
  /** The pending join, or a new one reserved now. */
  join(): Promise<void>
  /** The pending join, or null when none is in flight. */
  readonly pending: Promise<void> | null
}

type Settle = { resolve(): void; reject(error: unknown): void }

export function ownedAggregate<E, R>(options: OwnedAggregateOptions<E, R>): OwnedAggregate<E> {
  const live = new Set<E>()
  let joining: Promise<void> | null = null

  const joinEntry = (entry: E): Promise<R> => {
    try {
      return options.join(entry)
    } catch (error) {
      return Promise.reject(error)
    }
  }

  async function drain(settle: Settle): Promise<void> {
    const failures: unknown[] = []
    for (;;) {
      if (live.size === 0) {
        // One synchronous completion step: empty decision, slot release, settlement.
        joining = null
        if (failures.length === 0) settle.resolve()
        else if (failures.length === 1) settle.reject(failures[0])
        else settle.reject(new AggregateError(failures, options.message))
        return
      }
      const entries = [...live]
      const outcomes = await Promise.allSettled(entries.map(joinEntry))
      for (const entry of entries) live.delete(entry)
      outcomes.forEach((outcome, index) => {
        try {
          failures.push(...options.failures(entries[index]!, outcome))
        } catch (error) {
          failures.push(error)
        }
      })
    }
  }

  return {
    add: (entry) => void live.add(entry),
    has: (entry) => live.has(entry),
    get size() {
      return live.size
    },
    get pending() {
      return joining
    },
    join() {
      if (joining) return joining
      let settle!: Settle
      const reserved = new Promise<void>((resolve, reject) => (settle = { resolve, reject }))
      joining = reserved
      void drain(settle)
      return reserved
    },
  }
}
