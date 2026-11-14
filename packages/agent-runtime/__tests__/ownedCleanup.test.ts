// The shared test-cleanup owner (helpers/ownedCleanup.ts, task-666e5edd) on
// pure helper models: each owner's cleanup body is a scripted function over
// gates the test releases, not a driver, so these cases prove the join
// mechanics only (the fixtures' real-driver witnesses live in
// claudeCompatibilityCleanup.test.ts and Kawai's claudeRuntimeHarnessJoin
// tests). Each case is finite and derived from an accepted probe: the
// reservation-before-reentry class (task-d52b6709), the held overlap
// 8779de0b, the finalization-gap registration a681127c and the first
// rejection join-all (task-98101592 F2). Every gate is released and every
// join awaited in finally.
import { expect, test } from 'bun:test'
import { ownedAggregate, ownedOnce, type OwnedOnce } from './helpers/ownedCleanup.js'

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

function gate(): { held: Promise<void>; release(): void } {
  let release!: () => void
  const held = new Promise<void>((resolve) => (release = resolve))
  return { held, release }
}

/** Whether `promise` has already settled: its reaction is queued before the probe's. */
async function settledNow(promise: Promise<unknown>): Promise<boolean> {
  const mark = promise.then(() => true, () => true)
  return Promise.race([mark, Promise.resolve().then(() => false)])
}

/** A model owner: its cleanup runs `body` once through ownedOnce; `asserted` holds an exactly asserted failure. */
interface Owner {
  name: string
  once: OwnedOnce<void>
  body: () => Promise<void>
  runs: number
  asserted: { error: unknown } | null
}

function model() {
  const aggregate = ownedAggregate<Owner, void>({
    join: (owner) => owner.once.run(owner.body),
    // No assertion (null) is not an assertion of undefined: only an exact asserted value suppresses.
    failures: (owner, outcome) =>
      outcome.status === 'rejected' && (owner.asserted === null || owner.asserted.error !== outcome.reason)
        ? [outcome.reason]
        : [],
    message: 'model cleanups failed',
  })
  const owner = (name: string, script: () => Promise<void> = async () => {}): Owner => {
    const o: Owner = { name, once: ownedOnce<void>(), runs: 0, asserted: null, body: async () => {} }
    o.body = () => {
      o.runs++
      return script()
    }
    aggregate.add(o)
    return o
  }
  return { aggregate, owner }
}

test('an owned cleanup is reserved before its body runs: a synchronous reentry gets the same promise and one body', async () => {
  const once = ownedOnce<string>()
  const inner: Array<Promise<string>> = []
  let runs = 0
  const body = (): Promise<string> => {
    runs++
    // The reentry happens before run() has returned: only a reserved promise can answer it.
    inner.push(once.run(body), once.run(body))
    return Promise.resolve('stopped')
  }
  const outer = once.run(body)
  expect(inner.length).toBe(2)
  expect(inner.every((p) => p === outer)).toBe(true)
  expect(once.current).toBe(outer)
  expect(once.run(body)).toBe(outer)
  expect([await outer, runs]).toEqual(['stopped', 1])
})

test('a body that throws synchronously rejects the reserved promise with the original value', async () => {
  const once = ownedOnce<void>()
  const raw = 7
  const reserved = once.run(() => {
    throw raw
  })
  let caught: unknown = 'none'
  await reserved.catch((error: unknown) => (caught = error))
  expect(caught).toBe(raw)
  expect(once.run(async () => {})).toBe(reserved)
})

test('overlapping aggregate joins share one barrier that settles only after a held owner is released', async () => {
  const { aggregate, owner } = model()
  const g = gate()
  const held = owner('held', () => g.held)
  let first: Promise<void> | undefined
  try {
    first = aggregate.join()
    const second = aggregate.join()
    expect(second).toBe(first)
    expect(aggregate.pending).toBe(first)
    await tick()
    expect(await settledNow(first)).toBe(false)
    expect(aggregate.join()).toBe(first)
    g.release()
    await first
    expect([held.runs, aggregate.size, aggregate.pending]).toEqual([1, 0, null])
    const next = aggregate.join()
    expect(next).not.toBe(first)
    await next
  } finally {
    g.release()
    await Promise.allSettled([first, aggregate.join()])
  }
})

test('an owner registered while the join waits is joined by it before it settles', async () => {
  const { aggregate, owner } = model()
  const g1 = gate()
  const g2 = gate()
  owner('first', () => g1.held)
  let first: Promise<void> | undefined
  let late: Owner | undefined
  try {
    first = aggregate.join()
    late = owner('late', () => g2.held)
    g1.release()
    await tick()
    // The first owner is joined; the late one holds its gate, and the join is still pending.
    expect([await settledNow(first), late.runs, aggregate.has(late)]).toEqual([false, 1, true])
    g2.release()
    await first
    expect([late.runs, aggregate.size]).toEqual([1, 0])
  } finally {
    g1.release()
    g2.release()
    await Promise.allSettled([first, aggregate.join()])
  }
})

test('a join queued by the last owner\'s settlement gets a new barrier that joins the late owner', async () => {
  const { aggregate, owner } = model()
  const a = owner('a')
  let late: Owner | undefined
  let first: Promise<void> | undefined
  let second: Promise<void> | undefined
  try {
    first = aggregate.join()
    // Attached after the join subscribed to a's cleanup, as in probe a681127c.
    const scheduled = a.once.run(a.body).then(() => {
      queueMicrotask(() => {
        late = owner('late')
        second = aggregate.join()
      })
    })
    await scheduled
    await tick()
    expect(second).toBeDefined()
    expect(second).not.toBe(first)
    expect(await settledNow(first)).toBe(true)
    await second
    // The new barrier joined the late owner: its one body ran and it left the set.
    expect([late!.runs, aggregate.has(late!), await settledNow(late!.once.current!)]).toEqual([1, false, true])
  } finally {
    await Promise.allSettled([first, second, aggregate.join()])
  }
})

test('every owner is joined after a first rejection and the original raw values are rethrown in order', async () => {
  const { aggregate, owner } = model()
  const boom = new Error('first cleanup failed')
  const g = gate()
  const failing = owner('failing', () => Promise.reject(boom))
  const held = owner('held', () => g.held)
  const raw = [undefined, null, 'text', 0] as const
  const raws = raw.map((value, index) => owner(`raw${index}`, () => Promise.reject(value)))
  let joined: Promise<void> | undefined
  try {
    joined = aggregate.join()
    await tick()
    // The first rejection did not end the join: the held owner keeps it pending.
    expect(await settledNow(joined)).toBe(false)
    g.release()
    const caught = await joined.then(() => null, (error: unknown) => error)
    expect(caught).toBeInstanceOf(AggregateError)
    const errors = (caught as AggregateError).errors
    expect(errors.length).toBe(5)
    expect(errors[0]).toBe(boom)
    raw.forEach((value, index) => expect(errors[index + 1]).toBe(value))
    expect([failing, held, ...raws].map((o) => o.runs)).toEqual([1, 1, 1, 1, 1, 1])
  } finally {
    g.release()
    await Promise.allSettled([joined, aggregate.join()])
  }
})

test('an asserted undefined failure is suppressed while an unasserted undefined is rethrown', async () => {
  const { aggregate, owner } = model()
  const asserted = owner('asserted', () => Promise.reject(undefined))
  owner('unasserted', () => Promise.reject(undefined))
  asserted.asserted = { error: undefined }
  const outcome = await aggregate.join().then(
    () => ({ rejected: false, reason: 'none' as unknown }),
    (reason: unknown) => ({ rejected: true, reason }),
  )
  // One failure remains, so it rejects raw: the reason is the original undefined, not an AggregateError.
  expect(outcome).toEqual({ rejected: true, reason: undefined })
})

test('one unasserted failure rejects as the original object, and an empty join settles in the call itself', async () => {
  const { aggregate, owner } = model()
  const boom = new Error('only failure')
  owner('failing', () => Promise.reject(boom))
  owner('fine')
  const caught = await aggregate.join().then(() => null, (error: unknown) => error)
  expect(caught).toBe(boom)
  const empty = aggregate.join()
  expect(await settledNow(empty)).toBe(true)
  expect(aggregate.join()).not.toBe(empty)
})
