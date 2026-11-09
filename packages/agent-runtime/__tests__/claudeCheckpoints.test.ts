// @reads: packages/agent-runtime/__tests__/fixtures/**
// Claude checkpoint persistence (task 4.4, Claude unit; design §2, R10, I2,
// with L06/L08/L10/L21 preserved). The production ClaudeSession runs on a
// controlled query; onCheckpoint is a test-held promise, so every ordering
// below is decided by the test: pending, success, rejection, a stop or
// interrupt while persisting, two persistences in a row, and reentrant
// calls from inside onCheckpoint.
import { describe, expect, test } from 'bun:test'
import type { ResumeCheckpoint, TurnHandle } from '../src/contract.js'
import { AgentRuntimeError } from '../src/errors.js'
import type { AgentEvent } from '../src/events.js'
import { driver, type Driver, type DriverHooks } from './helpers/claudeDriverHarness.js'
import { frames } from './helpers/controlledQuery.js'

const tick = (ms = 0) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** onCheckpoint as a test-held promise per call. */
function persistence() {
  const calls: { checkpoint: ResumeCheckpoint; resolve(): void; reject(error: unknown): void }[] = []
  const onCheckpoint = (checkpoint: ResumeCheckpoint) =>
    new Promise<void>((resolve, reject) => {
      calls.push({ checkpoint, resolve, reject })
    })
  return { calls, onCheckpoint }
}

async function idle(hooks: DriverHooks): Promise<Driver> {
  const f = driver(hooks)
  const start = f.d.start()
  while (f.queries.length === 0) await tick()
  f.q().ready()
  await start
  return f
}

/** Settles to the value, the rejection, or 'pending' after the event loop drains. */
async function outcome<T>(promise: Promise<T>): Promise<T | AgentRuntimeError | 'pending'> {
  let state: T | AgentRuntimeError | 'pending' = 'pending'
  promise.then(
    (value) => (state = value),
    (error: AgentRuntimeError) => (state = error),
  )
  await tick()
  await tick()
  return state
}

const prompts = (f: Driver) => f.q().prompts.map((p): string | undefined => p.uuid)
const userMessages = (f: Driver) => f.events.filter((e) => e.type === 'user_message').map((e) => (e as Extract<AgentEvent, { type: 'user_message' }>).messageUuid)
const startedTurns = (f: Driver) => f.events.filter((e) => e.type === 'turn_started').map((e) => (e as Extract<AgentEvent, { type: 'turn_started' }>).turnId)
const errorCategories = (f: Driver) => f.events.filter((e) => e.type === 'error').map((e) => (e as Extract<AgentEvent, { type: 'error' }>).error.category)

/** An idle driver whose first turn T0 revealed `sessionId`; that persistence is held. */
async function persisting(sessionId = 'sess-new') {
  const p = persistence()
  const f = await idle({ onCheckpoint: p.onCheckpoint })
  const t0 = await f.d.send('first')
  f.q().push(frames.init(sessionId))
  await f.q().drain()
  return { f, p, t0 }
}

describe('Claude checkpoints: report and gate (A1, R10, I2)', () => {
  // @covers: agent-runtime › Runtime identity is available for persistence › Checkpoint persistence fails
  test('a new session id is reported once, and a later send is acknowledged only after it persisted', async () => {
    const { f, p, t0 } = await persisting()
    expect(p.calls.map((c) => c.checkpoint)).toEqual([{ runtime: 'claude', runtimeSessionId: 'sess-new' }])
    // The first turn, already acknowledged, is not gated: its result settles while persisting.
    f.q().push(frames.result([t0.messageUuid], 'zero'))
    expect((await t0.result).finalText).toBe('zero')
    const next = f.d.send('second')
    expect(await outcome(next)).toBe('pending')
    // Nothing of the dependent send is accepted yet: no prompt, no user message.
    expect(prompts(f)).toEqual([t0.messageUuid])
    expect(userMessages(f)).toEqual([t0.messageUuid])
    p.calls[0]!.resolve()
    const handle = await next
    await tick()
    expect(prompts(f)).toEqual([t0.messageUuid, handle.messageUuid])
    expect(userMessages(f)).toEqual([t0.messageUuid, handle.messageUuid])
    // A repeated init with the same id reports nothing new.
    f.q().push(frames.init('sess-new'))
    await f.q().drain()
    expect(p.calls).toHaveLength(1)
    await f.d.kill()
  })

  test('the resumed identity counts as already persisted: no callback and no gate', async () => {
    const p = persistence()
    const f = await idle({ onCheckpoint: p.onCheckpoint })
    const t0 = await f.d.send('first')
    f.q().push(frames.init('sess-saved'), frames.result([t0.messageUuid], 'zero'))
    await t0.result
    expect(p.calls).toHaveLength(0)
    const next = await f.d.send('second')
    await tick()
    expect(prompts(f)).toEqual([t0.messageUuid, next.messageUuid])
    // The respawn resume target is the caller's identity (I1).
    expect(f.q().options.resume).toBe('sess-saved')
    await f.d.kill()
  })

  test('without onCheckpoint nothing is gated', async () => {
    const f = await idle({})
    const t0 = await f.d.send('first')
    f.q().push(frames.init('sess-new'), frames.result([t0.messageUuid], 'zero'))
    await t0.result
    const next = await f.d.send('second')
    await tick()
    expect(prompts(f)).toEqual([t0.messageUuid, next.messageUuid])
    await f.d.kill()
  })

  test('two identities persist in order, and a waiter released by the first waits for the second', async () => {
    const { f, p, t0 } = await persisting('sess-a')
    f.q().push(frames.init('sess-b'))
    await f.q().drain()
    expect(p.calls).toHaveLength(1) // the second report waits for the first
    f.q().push(frames.result([t0.messageUuid], 'zero'))
    await t0.result
    const next = f.d.send('second')
    p.calls[0]!.resolve()
    await tick()
    expect(p.calls.map((c) => c.checkpoint.runtimeSessionId)).toEqual(['sess-a', 'sess-b'])
    expect(await outcome(next)).toBe('pending')
    expect(prompts(f)).toEqual([t0.messageUuid])
    p.calls[1]!.resolve()
    const handle = await next
    await tick()
    expect(prompts(f)).toEqual([t0.messageUuid, handle.messageUuid])
    await f.d.kill()
  })
})

describe('Claude checkpoints: admission while persisting (L08, L21, L10)', () => {
  test('L21: two queued sends released together open one turn at a time, in order, with their own results', async () => {
    const { f, p, t0 } = await persisting()
    const a = f.d.send('a', { continuation: 'queue' })
    const b = f.d.send('b', { continuation: 'queue' })
    await tick()
    // T0 finishes while the persistence is held: the driver goes idle with no queued turn.
    f.q().push(frames.result([t0.messageUuid], 'zero'))
    await t0.result
    expect(f.d.state).toBe('idle')
    p.calls[0]!.resolve()
    const [ha, hb] = (await Promise.all([a, b])) as [TurnHandle, TurnHandle]
    await tick()
    expect(prompts(f)).toEqual([t0.messageUuid, ha.messageUuid, hb.messageUuid])
    // Only A opened; B is queued behind it.
    expect(startedTurns(f)).toHaveLength(2)
    expect(f.d.lifecycle.activeTurnId).toBe(ha.turnId)
    f.q().push(frames.result([ha.messageUuid], 'ra'))
    expect(await ha.result).toMatchObject({ turnId: ha.turnId, messageUuid: ha.messageUuid, finalText: 'ra' })
    await f.q().drain()
    expect(f.d.lifecycle.activeTurnId).toBe(hb.turnId)
    f.q().push(frames.result([hb.messageUuid], 'rb'))
    expect(await hb.result).toMatchObject({ turnId: hb.turnId, messageUuid: hb.messageUuid, finalText: 'rb' })
    expect(f.results.map((r) => r.turnId)).toEqual([t0.turnId, ha.turnId, hb.turnId])
    expect(f.d.state).toBe('idle')
    await f.d.kill()
  })

  test('L08: a default send while active is refused busy at once, even if the turn ends before persistence', async () => {
    const { f, p, t0 } = await persisting()
    const busy = await outcome(f.d.send('now'))
    expect(busy).toBeInstanceOf(AgentRuntimeError)
    expect((busy as AgentRuntimeError).category).toBe('busy')
    f.q().push(frames.result([t0.messageUuid], 'zero'))
    await t0.result
    p.calls[0]!.resolve()
    await tick()
    expect(prompts(f)).toEqual([t0.messageUuid])
    await f.d.kill()
  })

  test('L10: an interrupt while a send waits refuses it as interrupted, and nothing is sent', async () => {
    const { f, p } = await persisting()
    const waiting = f.d.send('later', { continuation: 'queue' })
    await tick()
    await f.d.interrupt()
    p.calls[0]!.resolve()
    const refused = await outcome(waiting)
    expect(refused).toBeInstanceOf(AgentRuntimeError)
    expect((refused as AgentRuntimeError).category).toBe('not-ready')
    expect((refused as AgentRuntimeError).code).toBe('interrupted')
    expect(f.q().prompts).toHaveLength(1)
    await f.d.kill()
  })

  test('L10: an interrupt in the same tick as a queued send refuses it, and later work keeps its own accounting', async () => {
    const { f, p, t0 } = await persisting()
    const next = f.d.send('later', { continuation: 'queue' })
    void f.d.interrupt() // no tick: the send has yielded once but not yet resumed
    p.calls[0]!.resolve()
    const refused = await outcome(next)
    expect(refused).toBeInstanceOf(AgentRuntimeError)
    expect((refused as AgentRuntimeError).category).toBe('not-ready')
    expect((refused as AgentRuntimeError).code).toBe('interrupted')
    expect(prompts(f)).toEqual([t0.messageUuid])
    expect(startedTurns(f)).toHaveLength(1)
    expect(f.d.state).toBe('idle')
    // A new turn and a queued send after it still correlate, in order, and the driver ends idle.
    const b = await f.d.send('b')
    const c = await f.d.send('c', { continuation: 'queue' })
    await tick()
    expect(prompts(f)).toEqual([t0.messageUuid, b.messageUuid, c.messageUuid])
    f.q().push(frames.result([t0.messageUuid], 'late'), frames.init('sess-new'), frames.result([b.messageUuid], 'rb'))
    expect(await b.result).toMatchObject({ turnId: b.turnId, finalText: 'rb' })
    await f.q().drain()
    expect(f.d.lifecycle.activeTurnId).toBe(c.turnId)
    f.q().push(frames.result([c.messageUuid], 'rc'))
    expect(await c.result).toMatchObject({ turnId: c.turnId, finalText: 'rc' })
    expect(f.d.state).toBe('idle')
    await f.d.kill()
  })

  test('L10 without onCheckpoint: a queued send interrupted before it resumed is refused, not enqueued', async () => {
    const f = await idle({})
    const t0 = await f.d.send('first')
    f.q().push(frames.init('sess-new'))
    await f.q().drain()
    const next = f.d.send('later', { continuation: 'queue' })
    void f.d.interrupt()
    const refused = await outcome(next)
    expect(refused).toBeInstanceOf(AgentRuntimeError)
    expect((refused as AgentRuntimeError).code).toBe('interrupted')
    expect(prompts(f)).toEqual([t0.messageUuid])
    expect(f.d.state).toBe('idle')
    await f.d.kill()
  })
})

describe('Claude checkpoints: rejection and stop (A2)', () => {
  // @covers: agent-runtime › Runtime identity is available for persistence › Checkpoint persistence fails
  test('a rejected persistence refuses dependent sends, is observable, and the stop reports the raw cause', async () => {
    const { f, p } = await persisting()
    const waiting = f.d.send('later', { continuation: 'queue' })
    await tick()
    const cause = new Error('disk full')
    const queriesBefore = f.queries.length
    p.calls[0]!.reject(cause)
    const refused = await outcome(waiting)
    expect(refused).toBeInstanceOf(AgentRuntimeError)
    expect((refused as AgentRuntimeError).category).toBe('checkpoint')
    expect((refused as AgentRuntimeError).causes[0]).toBe(cause)
    expect(errorCategories(f)).toContain('checkpoint')
    // The driver asked for its own terminal stop; no fresh conversation was started.
    expect(['stopping', 'stopped']).toContain(f.d.state)
    expect(f.queries.length).toBe(queriesBefore)
    expect(f.q().prompts).toHaveLength(1)
    const later = await outcome(f.d.send('again'))
    expect((later as AgentRuntimeError).category).toBe('checkpoint')
    let stopError: unknown
    try {
      await f.d.kill()
    } catch (error) {
      stopError = error
    }
    expect(stopError).toBeInstanceOf(AgentRuntimeError)
    expect((stopError as AgentRuntimeError).category).toBe('stop')
    expect((stopError as AgentRuntimeError).causes).toContain(cause)
  })

  test('a synchronous throw in onCheckpoint counts as a rejection', async () => {
    const cause = new Error('sync')
    const f = await idle({
      onCheckpoint: () => {
        throw cause
      },
    })
    const t0 = await f.d.send('first')
    f.q().push(frames.init('sess-new'), frames.result([t0.messageUuid], 'zero'))
    await t0.result
    await tick()
    const refused = await outcome(f.d.send('later'))
    expect((refused as AgentRuntimeError).category).toBe('checkpoint')
    expect((refused as AgentRuntimeError).causes[0]).toBe(cause)
    let stopError: unknown
    try {
      await f.d.shutdown()
    } catch (error) {
      stopError = error
    }
    expect((stopError as AgentRuntimeError).causes).toContain(cause)
  })

  test('a stop while persisting closes admission at once and waits for the persistence; success never reopens', async () => {
    const { f, p } = await persisting()
    const waiting = f.d.send('later', { continuation: 'queue' })
    await tick()
    const stop = f.d.kill()
    expect(f.d.state).toBe('stopping')
    expect(await outcome(stop)).toBe('pending') // the owned persistence is joined
    p.calls[0]!.resolve()
    const receipt = await stop
    expect(receipt.js).toBe('settled')
    const refused = await outcome(waiting)
    expect((refused as AgentRuntimeError).category).toBe('stopped')
    expect(f.d.state).toBe('stopped')
    expect(f.q().prompts).toHaveLength(1)
  })

  test('a persistence that rejects during a stop stays a failure the stop reports, while waiters are stopped', async () => {
    const { f, p } = await persisting()
    const waiting = f.d.send('later', { continuation: 'queue' })
    await tick()
    const stop = f.d.kill()
    const cause = new Error('late')
    p.calls[0]!.reject(cause)
    let stopError: unknown
    try {
      await stop
    } catch (error) {
      stopError = error
    }
    expect((stopError as AgentRuntimeError).category).toBe('stop')
    expect((stopError as AgentRuntimeError).causes).toContain(cause)
    expect(((await outcome(waiting)) as AgentRuntimeError).category).toBe('stopped')
  })
})

describe('Claude checkpoints: reentrancy (no self-join)', () => {
  test('send() inside onCheckpoint is refused at once, while an unrelated send waits', async () => {
    let inner = null as Promise<unknown> | null
    let release!: () => void
    let f!: Driver
    f = await idle({
      onCheckpoint: () => {
        inner = f.d.send('from inside', { continuation: 'queue' }).catch((error: unknown) => error)
        return new Promise<void>((resolve) => (release = resolve))
      },
    })
    const t0 = await f.d.send('first')
    f.q().push(frames.init('sess-new'))
    await f.q().drain()
    const refused = (await inner) as AgentRuntimeError
    expect(refused).toBeInstanceOf(AgentRuntimeError)
    expect(refused.category).toBe('internal')
    const outside = f.d.send('outside', { continuation: 'queue' })
    expect(await outcome(outside)).toBe('pending')
    release()
    const handle = await outside
    await tick()
    expect(prompts(f)).toEqual([t0.messageUuid, handle.messageUuid])
    await f.d.kill()
  })

  test('kill() inside onCheckpoint is refused for that caller, the stop still begins, and an outside stop joins it', async () => {
    let inner = null as Promise<unknown> | null
    let release!: () => void
    let f!: Driver
    f = await idle({
      onCheckpoint: () => {
        inner = f.d.kill().catch((error: unknown) => error)
        return new Promise<void>((resolve) => (release = resolve))
      },
    })
    await f.d.send('first')
    f.q().push(frames.init('sess-new'))
    await f.q().drain()
    expect(((await inner) as AgentRuntimeError).category).toBe('internal')
    expect(f.d.state).toBe('stopping')
    const outside = f.d.kill()
    expect(await outcome(outside)).toBe('pending')
    release()
    expect((await outside).js).toBe('settled')
  })
})
