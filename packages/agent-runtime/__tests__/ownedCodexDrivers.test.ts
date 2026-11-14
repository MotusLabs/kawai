// The cleanup owner codexStopOrder.test.ts gives its drivers (batch B F2,
// helpers/ownedCodexDrivers.ts). Each driver is a real public-factory Codex
// driver from the harness (in-process spawn, never started), enrolled with
// the owner through the harness's fixture-internal `enroll`. Its kill() is
// then replaced by a finite outcome: a raw rejection, or one held until the
// test releases it. Every held gate is released in finally, and every join
// is awaited before the test asserts on its outcome.
import { describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import type { CodexAgentDriver, ProcessExitReceipt } from '../src/contract.js'
import { codexDriver } from './helpers/codexDriverHarness.js'
import { ownedCodexDrivers, type Admission, type OwnedCodexDrivers } from './helpers/ownedCodexDrivers.js'

const tick = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

interface Inert {
  driver: CodexAgentDriver
  /** Restore the real kill, stop the never-started driver and remove its root. */
  dispose(): Promise<void>
}

/** A harness driver admitted to `owner` (or to an earlier `admission`) before it is constructed. */
function inert(owner: OwnedCodexDrivers, admission: Admission = owner.admit()): Inert {
  const h = codexDriver({ inProcess: true, enroll: (driver) => admission.enroll(driver) })
  const kill = h.driver.kill.bind(h.driver)
  return {
    driver: h.driver,
    async dispose() {
      h.driver.kill = kill
      await kill()
      rmSync(h.root.root, { recursive: true, force: true })
    },
  }
}

/** A promise whose state the test reads synchronously. */
function watch(promise: Promise<unknown>): { state: 'pending' | 'resolved' | 'rejected' } {
  const seen = { state: 'pending' as 'pending' | 'resolved' | 'rejected' }
  promise.then(() => (seen.state = 'resolved'), () => (seen.state = 'rejected'))
  return seen
}

/** The rejection value of a settled join, or a marker when it resolved. */
const reasonOf = (promise: Promise<unknown>) => promise.then(() => 'resolved' as const, (error: unknown) => ({ error }))

describe('the owned Codex driver cleanup (F2)', () => {
  test('two overlapping closes share one join that stays pending while a kill is held, then both reject with the raw kill failure', async () => {
    const owner = ownedCodexDrivers()
    const a = inert(owner)
    const b = inert(owner)
    const rawA = { raw: 'A' }
    let release!: () => void
    const held = new Promise<ProcessExitReceipt>((resolve) => (release = () => resolve({ mode: 'kill', processes: [] } as unknown as ProcessExitReceipt)))
    a.driver.kill = () => Promise.reject(rawA)
    b.driver.kill = () => held
    const first = owner.close()
    const second = owner.close()
    const seenFirst = watch(first)
    const seenSecond = watch(second)
    try {
      await tick(20)
      expect([seenFirst.state, seenSecond.state]).toEqual(['pending', 'pending'])
      expect(second).toBe(first)
    } finally {
      release()
      await Promise.allSettled([first, second])
      await Promise.all([a.dispose(), b.dispose()])
    }
    const [outcomeFirst, outcomeSecond] = await Promise.all([reasonOf(first), reasonOf(second)])
    expect(outcomeFirst !== 'resolved' && outcomeFirst.error).toBe(rawA)
    expect(outcomeSecond !== 'resolved' && outcomeSecond.error).toBe(rawA)
  })

  test('an already admitted driver enrolled during a close delays that same close, while a new admission is refused before construction', async () => {
    const owner = ownedCodexDrivers()
    const a = inert(owner)
    const rawA = { raw: 'A' }
    const rawLate = { raw: 'late' }
    a.driver.kill = () => Promise.reject(rawA)
    const admitted = owner.admit()
    const closing = owner.close()
    const seen = watch(closing)
    let late: Inert | null = null
    let constructed = 0
    try {
      expect(owner.closed).toBe(true)
      expect(() => {
        owner.admit()
        constructed += 1
      }).toThrow('the driver owner is closed; no new driver is admitted')
      expect(constructed).toBe(0)
      expect(() => owner.open()).toThrow('a close is still joining; the owner cannot reopen')
      await tick(20)
      expect(seen.state).toBe('pending')
      late = inert(owner, admitted)
      late.driver.kill = () => Promise.reject(rawLate)
    } finally {
      if (!late) admitted.abandon(new Error('the test ended before the late driver enrolled'))
      await Promise.allSettled([closing])
      await Promise.all([a.dispose(), late?.dispose()])
    }
    const outcome = await reasonOf(closing)
    const error = outcome !== 'resolved' ? outcome.error : null
    expect(error).toBeInstanceOf(AggregateError)
    const errors = (error as AggregateError).errors
    expect(errors).toHaveLength(2)
    expect(errors[0]).toBe(rawA)
    expect(errors[1]).toBe(rawLate)
    owner.open()
    expect(owner.closed).toBe(false)
  })

  test('only an authorized occurrence of the exact rejection value is suppressed; repeats, undefined, structural copies and unconsumed authorizations are reported', async () => {
    const owner = ownedCodexDrivers()
    const x = { raw: 'X' }
    const copy = structuredClone(x)
    const drivers = Array.from({ length: 7 }, () => inert(owner))
    const [d1, d2, d3, d4, d5, d6, d7] = drivers.map((d) => d.driver) as CodexAgentDriver[]
    const reject = (value: unknown) => () => Promise.reject(value)
    d1!.kill = reject(x)
    d2!.kill = reject(x)
    d3!.kill = reject(undefined)
    d4!.kill = reject(null)
    d5!.kill = reject(x)
    d6!.kill = () => Promise.resolve({ mode: 'kill', processes: [] } as unknown as ProcessExitReceipt)
    d7!.kill = reject(x)
    owner.authorize(d1!, x)
    owner.authorize(d4!, null)
    owner.authorize(d5!, x)
    owner.authorize(d5!, x)
    owner.authorize(d6!, undefined)
    owner.authorize(d7!, copy)
    const closing = owner.close()
    try {
      await Promise.allSettled([closing])
    } finally {
      await Promise.all(drivers.map((d) => d.dispose()))
    }
    const outcome = await reasonOf(closing)
    const error = outcome !== 'resolved' ? outcome.error : null
    expect(error).toBeInstanceOf(AggregateError)
    const errors = (error as AggregateError).errors as unknown[]
    expect(errors).toHaveLength(6)
    expect(errors[0]).toBe(x)
    expect(errors[1]).toBe(undefined)
    expect((errors[2] as Error).message).toBe('an authorized stop failure was never observed')
    expect((errors[2] as Error).cause).toBe(x)
    expect((errors[3] as Error).message).toBe('an authorized stop failure was never observed')
    expect('cause' in (errors[3] as Error) && (errors[3] as Error).cause).toBe(undefined)
    expect(errors[4]).toBe(x)
    expect((errors[5] as Error).cause).toBe(copy)
    // A close whose every rejection was authorized exactly resolves, leaving no authorization behind.
    owner.open()
    const clean = inert(owner)
    const y = { raw: 'Y' }
    clean.driver.kill = reject(y)
    owner.authorize(clean.driver, y)
    try {
      expect(await reasonOf(owner.close())).toBe('resolved')
    } finally {
      await clean.dispose()
    }
    expect(() => owner.authorize(clean.driver, y)).toThrow('authorize names a driver this owner does not hold')
  })
})
