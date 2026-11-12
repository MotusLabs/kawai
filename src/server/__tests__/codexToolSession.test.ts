// The Codex tool-session fixture's cleanup (task-ce05430a R4 A13, review
// findings-1b6c7a20 F1). closeAll() must settle every call it owns before it
// removes a session's root: a queued call (the reviewer's probe, kept
// verbatim except its import), a call in flight on a held handler, two
// overlapping closeAll() calls, a session opened while the join waits, and
// a raw driver failure reported as the original value. Sessions run the
// production composition through the fixture; the only private reads are
// the fixture's own per-session state, taken before closeAll() clears it.
import fs from 'node:fs'
import { expect, test } from 'bun:test'
import { z } from 'zod'
import type { TeamToolSpec } from '../team/mailboxTools'
import { CLOSED, CodexToolSessions } from './codexToolSession'

type State = {
  waiting: Array<{ resolve(): void }>
  root: { root: string }
  driver: { kill(): void; settled(): Promise<void> }
}
const stateOf = (sessions: CodexToolSessions, id: string) =>
  (sessions as unknown as { live: Map<string, State> }).live.get(id)!

/** A table whose one tool waits on a gate the test opens. */
function gated() {
  let open!: () => void
  const gate = new Promise<void>(resolve => (open = resolve))
  let entered!: () => void
  const running = new Promise<void>(resolve => (entered = resolve))
  const table: TeamToolSpec[] = [{
    name: 'held', description: 'held', schema: z.object({}),
    handler: async () => {
      entered()
      await gate
      return { held: true }
    },
  }]
  return { table, open, running }
}

const settledWith = async (promise: Promise<unknown>) =>
  promise.then(value => ({ value }), (error: unknown) => ({ error }))

test('closeAll must not leave a previously queued fixture call pending after joining and removing its root', async () => {
  const sessions = new CodexToolSessions(() => [])
  const pending = sessions.call('queued', 'missing', {})
  // Save only the fixture's waiters for emergency release in finally. No
  // protocol frame, runtime result or expected outcome is fabricated.
  const state = (sessions as unknown as {live: Map<string, {waiting: Array<{resolve(): void}>}>}).live.get('queued')!
  let completed = false
  const observed = pending.then(() => { completed = true }, () => { completed = true })
  try {
    await sessions.closeAll()
    await new Promise<void>(resolve => setTimeout(resolve, 10))
    expect(completed).toBe(true)
  } finally {
    // The broken implementation cannot settle this queued waiter itself.
    // Release its fixture-only waiter solely to join the probe's promise.
    for (const waiter of state.waiting.splice(0)) waiter.resolve()
    await Promise.allSettled([observed, sessions.closeAll()])
  }
})

test('a queued call and the call queued behind it are refused as closed, with no send, before the root goes', async () => {
  const sessions = new CodexToolSessions(() => [])
  const first = settledWith(sessions.call('s', 'missing', {}))
  const second = settledWith(sessions.call('s', 'missing', {}))
  const state = stateOf(sessions, 's')
  await sessions.closeAll()
  expect(await first).toEqual({ error: new Error(CLOSED) })
  expect(await second).toEqual({ error: new Error(CLOSED) })
  expect(state.waiting).toEqual([])
  expect(fs.existsSync(state.root.root)).toBe(false)
})

test('an in-flight call on a held handler is refused as closed; the join waits for the driver before the root goes', async () => {
  const { table, open, running } = gated()
  const sessions = new CodexToolSessions(() => table)
  const call = settledWith(sessions.call('s', 'held', {}))
  const state = stateOf(sessions, 's')
  let closed: Promise<unknown> | null = null
  try {
    await running
    expect(state.waiting).toHaveLength(1)
    closed = settledWith(sessions.closeAll())
    // The waiter is refused synchronously by the close.
    expect(state.waiting).toEqual([])
    expect(await call).toEqual({ error: new Error(CLOSED) })
  } finally {
    open()
    expect(await (closed ?? settledWith(sessions.closeAll()))).toEqual({ value: undefined })
  }
  expect(fs.existsSync(state.root.root)).toBe(false)
})

test('overlapping closeAll calls share one join and close each session once', async () => {
  const sessions = new CodexToolSessions(() => [])
  const call = settledWith(sessions.call('s', 'missing', {}))
  const state = stateOf(sessions, 's')
  let kills = 0
  const kill = state.driver.kill.bind(state.driver)
  state.driver.kill = () => {
    kills += 1
    kill()
  }
  const a = sessions.closeAll()
  const b = sessions.closeAll()
  expect(b).toBe(a)
  await a
  expect(kills).toBe(1)
  expect(await call).toEqual({ error: new Error(CLOSED) })
  expect(fs.existsSync(state.root.root)).toBe(false)
})

test('a session opened while the join waits is closed by that join, its call refused and its root removed', async () => {
  const { table, open, running } = gated()
  const sessions = new CodexToolSessions(() => table)
  const held = settledWith(sessions.call('s', 'held', {}))
  const first = stateOf(sessions, 's')
  await running
  const closed = settledWith(sessions.closeAll())
  try {
    const late = settledWith(sessions.call('s', 'missing', {}))
    const second = stateOf(sessions, 's')
    expect(second).not.toBe(first)
    open()
    expect(await closed).toEqual({ value: undefined })
    expect(await held).toEqual({ error: new Error(CLOSED) })
    // The late call settled by the time the join did: refused by the close,
    // or answered before the join reached it. It never stays pending.
    let lateSettled = false
    void late.then(() => (lateSettled = true))
    await Promise.resolve()
    expect(lateSettled).toBe(true)
    const lateOutcome = await late
    if ('error' in lateOutcome) expect(lateOutcome.error).toEqual(new Error(CLOSED))
    expect(fs.existsSync(first.root.root)).toBe(false)
    expect(fs.existsSync(second.root.root)).toBe(false)
  } finally {
    open()
    await Promise.allSettled([closed, sessions.closeAll()])
  }
})

test('a raw driver failure rejects closeAll once as the original value, after its calls settled and its root went', async () => {
  const sessions = new CodexToolSessions(() => [])
  const call = settledWith(sessions.call('s', 'missing', {}))
  const state = stateOf(sessions, 's')
  const raw = { raw: 'driver failure' }
  const settled = state.driver.settled.bind(state.driver)
  state.driver.settled = async () => {
    await settled()
    throw raw
  }
  const outcome = await settledWith(sessions.closeAll())
  expect(outcome).toEqual({ error: raw })
  expect((outcome as { error: unknown }).error).toBe(raw)
  expect(await call).toEqual({ error: new Error(CLOSED) })
  expect(fs.existsSync(state.root.root)).toBe(false)
  // The join is spent: the next closeAll has nothing left to report.
  expect(await settledWith(sessions.closeAll())).toEqual({ value: undefined })
})
