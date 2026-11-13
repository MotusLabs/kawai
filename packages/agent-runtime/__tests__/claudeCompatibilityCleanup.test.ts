// The package compatibility fixtures' cleanup owner
// (helpers/claudeCompatibilityCleanup.ts, task-98101592 A5 / finding F2) on
// real ClaudeSession drivers over controlled queries, through the same helper
// both package after-hooks use. A stop that rejects never keeps the owner
// from stopping and joining every other driver. Each unasserted failure is
// rethrown as the original object, several together as an AggregateError, and
// only an exact raw-cause assertion suppresses one. A stop reentered from the
// driver's own stopping callback joins the one reserved stop. Each case is
// finite: two drivers at most, one stop each.
import { afterEach, describe, expect, test } from 'bun:test'
import { CompatibilityCleanup, rawCauses } from './helpers/claudeCompatibilityCleanup.js'
import { driver, type Driver, type DriverHooks } from './helpers/claudeDriverHarness.js'

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

/** Owners these tests created; a test that failed early still has its drivers stopped and its failures reported. */
const owners: CompatibilityCleanup[] = []
afterEach(async () => {
  for (const owner of owners.splice(0)) await owner.finishAll()
})

function owner(): CompatibilityCleanup {
  const cleanup = new CompatibilityCleanup()
  owners.push(cleanup)
  return cleanup
}

async function idle(cleanup: CompatibilityCleanup, hooks: DriverHooks = {}): Promise<Driver> {
  const f = cleanup.track(driver(hooks))
  const start = f.d.start()
  while (f.queries.length === 0) await tick()
  f.q().ready()
  await start
  return f
}

/** A driver whose stopping callback throws `boom`, so its stop rejects. */
const throwing = (cleanup: CompatibilityCleanup, boom: Error) =>
  idle(cleanup, {
    onState: (state) => {
      if (state === 'stopping') throw boom
    },
  })

async function rejection(cleanup: CompatibilityCleanup): Promise<unknown> {
  try {
    await cleanup.finishAll()
    return null
  } catch (error) {
    return error
  }
}

describe('package compatibility cleanup owner', () => {
  test('a first rejecting stop does not keep the after-hook from stopping the next driver; the original is rethrown', async () => {
    const cleanup = owner()
    const boom = new Error('first driver stop observer failed')
    const first = await throwing(cleanup, boom)
    const second = await idle(cleanup)
    const caught = await rejection(cleanup)
    // The rejecting stop was joined (its one kill ran); the next driver was still stopped.
    expect([cleanup.kills(first), cleanup.kills(second), second.d.state]).toEqual([1, 1, 'stopped'])
    expect(caught).not.toBeNull()
    expect(rawCauses(caught).length).toBe(1)
    expect(rawCauses(caught)[0]).toBe(boom)
  })

  test('two rejecting stops are both joined and rethrown together as their originals', async () => {
    const cleanup = owner()
    const left = new Error('left stop failed')
    const right = new Error('right stop failed')
    const a = await throwing(cleanup, left)
    const b = await throwing(cleanup, right)
    const caught = await rejection(cleanup)
    // Both rejecting stops were joined: each ran its one kill.
    expect([cleanup.kills(a), cleanup.kills(b)]).toEqual([1, 1])
    expect(caught).toBeInstanceOf(AggregateError)
    const errors = (caught as AggregateError).errors
    expect(errors.map((error) => rawCauses(error).length)).toEqual([1, 1])
    expect([rawCauses(errors[0])[0] === left, rawCauses(errors[1])[0] === right]).toEqual([true, true])
  })

  test('only an exactly asserted stop failure is suppressed; a mismatched assertion leaves it reported', async () => {
    const cleanup = owner()
    const asserted = new Error('asserted stop failure')
    const left = new Error('unasserted stop failure')
    const a = await throwing(cleanup, asserted)
    const b = await throwing(cleanup, left)
    await cleanup.failed(a, [asserted])
    let mismatch: unknown = null
    try {
      await cleanup.failed(b, [])
    } catch (error) {
      mismatch = error
    }
    expect(mismatch).not.toBeNull()
    const caught = await rejection(cleanup)
    expect(rawCauses(caught).length).toBe(1)
    expect(rawCauses(caught)[0]).toBe(left)
  })

  test('a stop reentered from the stopping callback joins the one reserved stop', async () => {
    const cleanup = owner()
    const inner: Array<Promise<unknown>> = []
    const box: { f?: Driver } = {}
    const f = (box.f = await idle(cleanup, {
      onState: (state) => {
        if (state === 'stopping' && inner.length < 3) inner.push(cleanup.stop(box.f!))
      },
    }))
    const outer = cleanup.stop(f)
    const outcome = await outer
    expect(inner.length > 0).toBe(true)
    expect(inner.every((p) => p === outer)).toBe(true)
    expect([outcome, cleanup.kills(f), f.d.state]).toEqual([{ resolved: true }, 1, 'stopped'])
  })

  // Delegation witness (task-666e5edd): the after-hook is the shared helper's
  // join over real drivers. A second finishAll() while the first is pending
  // gets the same promise, and a driver first tracked from a stopping callback
  // the pending join owns is stopped and joined before it settles.
  test('an overlapping after-hook shares the pending join, which stops a driver tracked while it runs', async () => {
    const cleanup = owner()
    const late = driver()
    const lateStart = late.d.start()
    while (late.queries.length === 0) await tick()
    late.q().ready()
    await lateStart
    let trackedLate = false
    await idle(cleanup, {
      onState: (state) => {
        if (state === 'stopping' && !trackedLate) {
          trackedLate = true
          cleanup.track(late)
        }
      },
    })
    let first: Promise<void> | undefined
    try {
      first = cleanup.finishAll()
      expect(cleanup.finishAll()).toBe(first)
      await first
      expect([trackedLate, cleanup.kills(late), late.d.state]).toEqual([true, 1, 'stopped'])
      // The join settled with its slot released: the next call starts a new, empty one.
      const next = cleanup.finishAll()
      expect(next).not.toBe(first)
      await next
    } finally {
      await Promise.allSettled([first, late.d.kill()])
    }
  })
})
