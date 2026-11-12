// The compatibility fixture's own cleanup invariant (task-98101592 A5,
// helpers/claudeCompatibilityHarness.ts): one cleanup promise per adapter,
// reserved before any effect, so a reentrant finish() from a callback inside
// kill and overlapping finish() calls join one body; finishAll() joins every
// cleanup and then rethrows each failure no test asserted, as the original
// object; failed() suppresses a failure only when its raw causes match
// exactly. Each case is finite: a fixed number of adapters and calls.
import { afterEach, describe, expect, test } from 'bun:test'
import { busy, compatibilityAdapter, finishAll, rawCauses, settle, until, type Harness } from './helpers/claudeCompatibilityHarness'

afterEach(async () => {
  await finishAll()
})

/** An adapter whose stop fails with `boom`: a plain interrupt the scripted CLI rejects. */
async function failing(boom: Error): Promise<Harness> {
  const h = compatibilityAdapter()
  await busy(h, ['interrupt_receipt_v1'])
  h.scripts[0]!.answers.push(boom)
  await h.driver.interrupt()
  await until(() => h.scripts[0]!.interrupts.length === 1)
  await settle()
  return h
}

/** finishAll()'s rejection, or null when it resolved. */
async function rejection(): Promise<unknown> {
  try {
    await finishAll()
    return null
  } catch (error) {
    return error
  }
}

describe('compatibility fixture cleanup', () => {
  test('a reentrant finish from a callback inside kill and overlapping finishes join one cleanup body', async () => {
    const box: { h?: Harness; armed: boolean; inner: Array<Promise<unknown>> } = { armed: false, inner: [] }
    const h = (box.h = compatibilityAdapter({
      onStatus: () => {
        if (box.armed && box.inner.length < 3) box.inner.push(box.h!.finish())
      },
    }))
    await busy(h)
    box.armed = true
    const first = h.finish()
    const second = h.finish()
    const outcome = await first
    // The callback inside kill reentered finish(): the reservation was already stored.
    const joined: Array<Promise<unknown>> = [second, ...box.inner]
    expect(box.inner.length > 0).toBe(true)
    expect(joined.every((p) => p === first)).toBe(true)
    const settled: unknown[] = await Promise.all(joined)
    expect(settled.every((value) => value === outcome)).toBe(true)
    // finishAll() overlapping after the body joins it too: still one body.
    await finishAll()
    expect([outcome, h.bodies()]).toEqual([{ resolved: true, closed: true }, 1])
  })

  test('an unasserted cleanup failure is joined, then rethrown as the original object', async () => {
    const boom = new Error('unasserted stop failure')
    const h = await failing(boom)
    const caught = await rejection()
    expect(h.bodies()).toBe(1)
    // The settled() rejection itself, whose only raw cause is boom.
    expect(caught).not.toBeNull()
    expect(rawCauses(caught)).toEqual([boom])
    expect(rawCauses(caught)[0]).toBe(boom)
  })

  test('only an exactly asserted failure is suppressed; several unasserted ones rethrow together after every cleanup ran', async () => {
    const asserted = new Error('asserted')
    const left = new Error('left A')
    const right = new Error('left B')
    const a = await failing(asserted)
    await a.failed([asserted])
    const b = await failing(left)
    const c = await failing(right)
    // A mismatched assertion does not mark the failure asserted.
    let mismatch: unknown = null
    try {
      await b.failed([])
    } catch (error) {
      mismatch = error
    }
    expect(mismatch).not.toBeNull()
    const caught = await rejection()
    expect([a.bodies(), b.bodies(), c.bodies()]).toEqual([1, 1, 1])
    expect(caught).toBeInstanceOf(AggregateError)
    const errors = (caught as AggregateError).errors
    expect(errors.length).toBe(2)
    // Each the original settled() rejection, in adapter order, with exactly its own raw cause.
    expect(errors.map((error) => rawCauses(error).length)).toEqual([1, 1])
    expect([rawCauses(errors[0])[0] === left, rawCauses(errors[1])[0] === right]).toEqual([true, true])
  })
})
