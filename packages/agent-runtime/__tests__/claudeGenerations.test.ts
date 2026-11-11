// Generation ownership and stop accounting on a controlled query (task 4.1
// corrections A2/A3). The session runs unchanged; only the SDK's query() is
// replaced. That queryFactory is the declared native-free seam (R4 B4): no
// spawner is ever called, so no generation has a process or native evidence,
// and the stop's native account adds nothing here. The native account is
// proven on the production path in claudeNativeStop.test.ts.
//
// - A2: a failed initialize leaves its query live (the process stays alive
//   until stop). After that failed start, the retained generation's frames
//   and exit change nothing. This holds both while unstarted and after a new
//   generation has opened a turn. The latter case reaches the session's real
//   generation guard (`generation !== this.current()` in handle).
// - These unstarted rows are qualified apart from the lifecycle table's
//   virgin unstarted rows (U01/U02), where no query exists at all.
// - A3: stop excludes only a cancellation proven at its source. The query's
//   own cancel path mints the SDK's AbortError after the stop aborted that
//   query's controller with the stop's token. Every other failure, before,
//   during or after termination, fails the stop after the join, with the
//   original error kept by identity.
// - Controls: the timing classifier mutants (a stop flag alone, or the
//   AbortError class without the stop's token) each fail an ordering test
//   here; the positive witnesses are separate tests.
import { AbortError } from '@anthropic-ai/claude-agent-sdk'
import { describe, expect, test } from 'bun:test'
import { AgentRuntimeError } from '../src/errors.js'
import { driver, type Driver, type DriverHooks } from './helpers/claudeDriverHarness.js'
import { frames } from './helpers/controlledQuery.js'

const tick = () => new Promise((resolve) => setTimeout(resolve, 5))

async function rejection(promise: Promise<unknown>): Promise<AgentRuntimeError> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(AgentRuntimeError)
    return error as AgentRuntimeError
  }
  throw new Error('expected a rejection')
}

/** Everything a caller could observe, frozen for comparison. */
function observed(f: Driver) {
  return JSON.stringify({ events: f.events, results: f.results, ends: f.ends, states: f.states, state: f.d.state, pending: f.d.pendingRequests() })
}

/** Start once with a failed initialize whose query stays live; returns that query and the start's error. */
async function failedStart(f: Driver) {
  const start = f.d.start()
  start.catch(() => {})
  while (f.queries.length === 0) await tick()
  const q1 = f.q()
  q1.failInit(new Error('initialize refused'))
  const error = await rejection(start)
  expect([error.category, f.d.state, q1.isEnded]).toEqual(['transport', 'unstarted', false])
  return { q1, error }
}

/** Late output of the retired generation: a UUID-less result, an init, text, a native task notification, then its exit. */
async function lateOutput(q1: ReturnType<Driver['q']>) {
  q1.push(frames.init('sess-old', 'model-old'), frames.text('stale text'), frames.result([], 'stale result'), frames.taskNotification('task-old'))
  await q1.drain()
  q1.exit()
  await tick()
}

describe('A2: a failed start retains its query; its later frames change nothing', () => {
  test('a retired generation cannot finish, open or end the active turn of its successor', async () => {
    const f = driver()
    const { q1, error } = await failedStart(f)
    const restart = f.d.start()
    while (f.queries.length < 2) await tick()
    f.q().ready()
    await restart
    const handle = await f.d.send('B')
    await tick()
    const before = observed(f)
    await lateOutput(q1)
    expect(observed(f)).toBe(before)
    expect(f.d.state).toBe('active')
    let settled = false
    void handle.result.then(() => (settled = true))
    await tick()
    expect(settled).toBe(false)
    // The successor's own result still completes B.
    const q2 = f.q()
    q2.push(frames.init(), frames.result([q2.prompts[0]!.uuid!], 'B done'))
    expect((await handle.result).outcome).toBe('success')
    // A3: the failed start is still reported by the stop.
    const stop = await rejection(f.d.kill())
    expect([stop.category, stop.causes]).toEqual(['stop', [error]])
  })

  test('while unstarted after the failed start, its result, native output and exit change nothing', async () => {
    const f = driver()
    const { q1 } = await failedStart(f)
    const before = observed(f)
    await lateOutput(q1)
    expect(observed(f)).toBe(before)
    expect([f.d.state, f.ends]).toEqual(['unstarted', []])
    // Its init named another session: the next start must still resume the supplied one.
    const restart = f.d.start()
    while (f.queries.length < 2) await tick()
    expect(f.q().options.resume).toBe('sess-saved')
    f.q().ready()
    await restart
    expect(observed(f)).toBe(JSON.stringify({ ...JSON.parse(before), states: [...JSON.parse(before).states, 'starting', 'idle'], state: 'idle' }))
    expect((await rejection(f.d.kill())).category).toBe('stop')
  })
})

async function launched(hooks: DriverHooks = {}) {
  const f = driver(hooks)
  const start = f.d.start()
  start.catch(() => {})
  while (f.queries.length === 0) await tick()
  return { f, start, q: f.q() }
}

async function activeTurn(hooks: DriverHooks = {}) {
  const { f, start, q } = await launched(hooks)
  q.ready()
  await start
  const handle = await f.d.send('A')
  return { f, q, handle }
}

/** The stop rejects after the join, keeping exactly `expected` by identity. */
async function stopFailsWith(f: Driver, expected: unknown[]) {
  const stop = await rejection(f.d.kill())
  expect(stop.category).toBe('stop')
  expect(stop.causes).toHaveLength(expected.length)
  stop.causes.forEach((cause, i) => expect(cause).toBe(expected[i]))
  expect(f.d.lifecycle.jobs.size).toBe(0)
}

describe('A3: only a cancellation proven at its source is excluded', () => {
  test('positive witness: a stop before the query exists is the driver\'s own refusal; the stop succeeds', async () => {
    const f = driver()
    const start = f.d.start()
    start.catch(() => {})
    const receipt = await f.d.kill()
    expect([(await rejection(start)).category, f.queries.length, receipt.js]).toEqual(['stopped', 0, 'settled'])
  })

  test('positive witness: a stop during initialize aborts the query, whose AbortError is the cancellation; the stop succeeds', async () => {
    const { f, start } = await launched()
    const receipt = await f.d.kill()
    const error = await rejection(start)
    expect(error.category).toBe('stopped')
    expect(error.causes[0]).toBeInstanceOf(AbortError)
    expect(receipt.js).toBe('settled')
  })

  test('initialize: E rejected, then kill called synchronously before any catch runs: the stop reports E', async () => {
    const { f, start, q } = await launched()
    const e = new Error('initialize refused')
    q.failInit(e)
    const stop = f.d.kill()
    const startError = await rejection(start)
    expect([startError.category, startError.causes[0]]).toEqual(['transport', e])
    await stopFailsWith(f, [startError]).then(() => stop.catch(() => {}))
  })

  test('initialize: E before the stop, and E while the stop begins (before termination), are both reported', async () => {
    for (const when of ['before', 'during'] as const) {
      const e = new Error(`initialize failed ${when}`)
      let q: ReturnType<Driver['q']> | null = null
      const { f, start, q: launchedQuery } = await launched({ onState: (state) => state === 'stopping' && when === 'during' && q?.failInit(e) })
      q = launchedQuery
      if (when === 'before') {
        q.failInit(e)
        await tick()
      }
      const stop = f.d.kill()
      const startError = await rejection(start)
      expect(startError.causes[0]).toBe(e)
      await stopFailsWith(f, [startError]).then(() => stop.catch(() => {}))
    }
  })

  test('read: an independent read failure before, during or after termination is reported', async () => {
    for (const when of ['before', 'during', 'after'] as const) {
      const e = new Error(`read failed ${when}`)
      let q: ReturnType<Driver['q']> | null = null
      const { f, q: query } = await activeTurn({ onState: (state) => state === 'stopping' && when === 'during' && q?.failRead(e) })
      q = query
      if (when === 'before') {
        q.failRead(e)
        while (f.d.state !== 'exited') await tick()
      }
      if (when === 'after') q.holdOnClose = true
      const stop = f.d.kill()
      if (when === 'after') {
        // Terminated (aborted, closed) but the stream still open: an independent failure now is still a failure.
        await tick()
        q.failRead(e)
      }
      await stopFailsWith(f, [e]).then(() => stop.catch(() => {}))
    }
  })

  test('interrupt: a control failure before or during the stop is reported; the abort-caused rejection is not', async () => {
    for (const when of ['before', 'during', 'stop-cancelled'] as const) {
      const e = new Error(`interrupt failed ${when}`)
      let q: ReturnType<Driver['q']> | null = null
      const { f, q: query } = await activeTurn({ onState: (state) => state === 'stopping' && when === 'during' && q?.failHeldInterrupts(e) })
      q = query
      if (when === 'before') q.interruptFailure = e
      else q.holdInterrupt = true
      await f.d.interrupt()
      await tick()
      if (when === 'stop-cancelled') expect((await f.d.kill()).js).toBe('settled')
      else await stopFailsWith(f, [e])
    }
  })

  test('a caller-supplied controller aborting is the caller\'s, not the stop\'s: its AbortError is reported', async () => {
    const caller = new AbortController()
    const { f, start } = await launched({ sdkOptions: { abortController: caller } })
    caller.abort('caller gave up')
    const startError = await rejection(start)
    expect(startError.category).toBe('transport')
    expect(startError.causes[0]).toBeInstanceOf(AbortError)
    // The stream's AbortError, when it ends, is the caller's too: both are reported.
    const stop = await rejection(f.d.kill())
    expect(stop.causes[0]).toBe(startError)
    expect(stop.causes.slice(1).map((c) => c instanceof AbortError)).toEqual([true])
  })
})
