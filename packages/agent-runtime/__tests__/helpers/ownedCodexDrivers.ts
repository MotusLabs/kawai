// ownedCodexDrivers.ts - the one cleanup owner of a test file's Codex drivers
// (batch B F2, sweep 7553f8ac A9). codexStopOrder.test.ts uses it instead of
// the shared stopDrivers registry: each driver is enrolled here, through the
// harness's fixture-internal `enroll`, and never in that registry.
//
// - Admission: admit() reserves an entry before the driver is constructed, so
//   a close that starts while an admitted construction is still pending waits
//   for it (enroll) or reports why it was abandoned. Once close() starts, no
//   new admission is accepted until open() at the next sequence boundary, and
//   open() refuses while a close is still joining.
// - Joins: close() is the accepted ownedAggregate join (helpers/ownedCleanup.ts):
//   one in-flight join shared by every overlapping caller, entries registered
//   while it waits are joined by it, and an entry leaves only after its join
//   settled. An entry's join is its driver's kill(), the driver's one terminal
//   promise.
// - Failures: every rejection is reported as its original value. A test may
//   suppress one occurrence of an exact rejection value only through
//   authorize(), after it asserted that value; each authorization consumes one
//   matching occurrence, compared with Object.is (undefined and null
//   included), and an authorization no outcome consumed is itself reported.
//
// Only outside callers call this owner; no driver callback reaches it.
import type { CodexAgentDriver, ProcessExitReceipt } from '../../src/contract.js'
import { ownedAggregate } from './ownedCleanup.js'

interface Entry {
  /** Settles with the enrolled driver; rejects with the abandoned construction's error. */
  driver: Promise<CodexAgentDriver>
  /** Exact rejection values a test asserted, one occurrence each. */
  authorized: unknown[]
}

/** One admitted, not yet constructed driver. */
export interface Admission {
  enroll(driver: CodexAgentDriver): void
  abandon(error: unknown): void
}

export interface OwnedCodexDrivers {
  /** Reserve ownership before constructing a driver; throws once close() started. */
  admit(): Admission
  /** Suppress one occurrence of `value` as `driver`'s stop rejection; call only after asserting it exactly. */
  authorize(driver: CodexAgentDriver, value: unknown): void
  /** Close admission and join every entry; rejects with every unauthorized failure. */
  close(): Promise<void>
  /** Reopen admission at a new sequence; throws while a close is joining. */
  open(): void
  readonly closed: boolean
}

export function ownedCodexDrivers(): OwnedCodexDrivers {
  let closed = false
  const byDriver = new Map<CodexAgentDriver, Entry>()
  const entries = ownedAggregate<Entry, ProcessExitReceipt>({
    join: (entry) => entry.driver.then((driver) => driver.kill()),
    failures: (entry, outcome) => {
      const reported: unknown[] = []
      if (outcome.status === 'rejected') {
        const index = entry.authorized.findIndex((value) => Object.is(value, outcome.reason))
        if (index >= 0) entry.authorized.splice(index, 1)
        else reported.push(outcome.reason)
      }
      for (const value of entry.authorized.splice(0)) reported.push(new Error('an authorized stop failure was never observed', { cause: value }))
      for (const [driver, owned] of byDriver) if (owned === entry) byDriver.delete(driver)
      return reported
    },
    message: 'owned Codex driver cleanup failed',
  })
  return {
    get closed() {
      return closed
    },
    admit() {
      if (closed) throw new Error('the driver owner is closed; no new driver is admitted')
      let settle!: { resolve(driver: CodexAgentDriver): void; reject(error: unknown): void }
      const entry: Entry = { driver: new Promise((resolve, reject) => (settle = { resolve, reject })), authorized: [] }
      let done = false
      entries.add(entry)
      return {
        enroll(driver) {
          if (done) throw new Error('this admission already settled')
          done = true
          byDriver.set(driver, entry)
          settle.resolve(driver)
        },
        abandon(error) {
          if (done) throw new Error('this admission already settled')
          done = true
          settle.reject(error)
        },
      }
    },
    authorize(driver, value) {
      const entry = byDriver.get(driver)
      if (!entry) throw new Error('authorize names a driver this owner does not hold')
      entry.authorized.push(value)
    },
    close() {
      closed = true
      return entries.join()
    },
    open() {
      if (entries.pending) throw new Error('a close is still joining; the owner cannot reopen')
      closed = false
    },
  }
}
