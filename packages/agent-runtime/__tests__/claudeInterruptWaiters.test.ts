// @reads: packages/agent-runtime/__tests__/fixtures/**
// Interrupt versus waiting sends on the production Claude session (task 4.4
// Claude unit, R3 A4): one test per bound row of interruptWaitersInputs.ts
// and interruptWaitersSupplement.ts, the expected result taken from
// interruptWaitersOutputs.ts (named in each title). C = the waiting send is
// refused not-ready/interrupted at once, before the held start or
// persistence is released, and it never enqueues, emits user_message or
// turn_started, or returns a handle afterwards. Callback-triggered rows (C,
// B, P) and the gate-level admission rows are in claudeInterruptCallbacks.test.ts.
import { describe, expect, test } from 'bun:test'
import { driver } from './helpers/claudeDriverHarness.js'
import {
  NO_ACTIVE_TURN, REQUESTED, allPrompts, errorCategories, exitProcess, expectInterrupted, expectRefused, idle, idleWhilePersisting, interruptedTurns,
  assigned, outcome, persistence, persisting, prompts, rejection, startedTurns, starting, stopError, tick, userMessages,
} from './helpers/checkpointHarness.js'
import { frames } from './helpers/controlledQuery.js'

describe('interrupt while idle (A4: the two fresh traces and the true-idle no-op)', () => {
  // @covers: agent-runtime › Cooperative interrupt is distinct from forced stop › Interrupt while a submission awaits checkpoint persistence
  test('W08/WA1: a queued send waiting on persistence after the turn before it ended is refused at once; the release sends nothing', async () => {
    const { f, p, t0 } = await persisting()
    const q = f.d.send('q', { continuation: 'queue' })
    await tick()
    f.q().push(frames.result([t0.messageUuid], 'zero'))
    await t0.result
    expect(f.d.state).toBe('idle')
    expect(await f.d.interrupt()).toEqual(REQUESTED)
    // Refused before the persistence is released.
    expectInterrupted(await outcome(q))
    expect(p.calls[0]).toBeDefined()
    p.calls[0]!.resolve()
    await tick()
    expect(prompts(f)).toEqual([t0.messageUuid])
    expect(userMessages(f)).toEqual([t0.messageUuid])
    expect(startedTurns(f)).toHaveLength(1)
    expect(f.d.state).toBe('idle')
    // WA1: later sends are accepted under the usual rules.
    const later = await f.d.send('later')
    await tick()
    expect(prompts(f)).toEqual([t0.messageUuid, later.messageUuid])
    await f.d.kill()
  })

  test('W09: a default send first called while idle with a persistence pending is refused at once; receipt requested', async () => {
    const { f, p, t0 } = await idleWhilePersisting()
    const a = f.d.send('a')
    await tick()
    expect(await outcome(a)).toBe('pending')
    expect(await f.d.interrupt()).toEqual(REQUESTED)
    expectInterrupted(await outcome(a))
    p.calls[0]!.resolve()
    await tick()
    expect(prompts(f)).toEqual([t0.messageUuid])
    expect(f.d.state).toBe('idle')
    await f.d.kill()
  })

  test('W01: true idle, unstarted and exited with no waiting send stay no-active-turn, even with a persistence held', async () => {
    const unstarted = driver()
    expect(await unstarted.d.interrupt()).toEqual(NO_ACTIVE_TURN)
    const { f, p } = await idleWhilePersisting()
    expect(await f.d.interrupt()).toEqual(NO_ACTIVE_TURN)
    expect(f.d.state).toBe('idle')
    p.calls[0]!.resolve() // the stop below joins it
    const plain = await idle({})
    expect(await plain.d.interrupt()).toEqual(NO_ACTIVE_TURN)
    await exitProcess(plain)
    expect(await plain.d.interrupt()).toEqual(NO_ACTIVE_TURN)
    expect(plain.d.state).toBe('exited')
    await Promise.all([unstarted.d.kill(), f.d.kill(), plain.d.kill()])
  })
})

describe('interrupt while active, starting or exited (A4)', () => {
  test('W07: a queued send waiting on persistence while active is refused at once; the active turn is interrupted; idle', async () => {
    const { f, p, t0 } = await persisting()
    const q = f.d.send('q', { continuation: 'queue' })
    await tick()
    expect(await f.d.interrupt()).toEqual(REQUESTED)
    expectInterrupted(await outcome(q))
    expect((await t0.result).outcome).toBe('interrupted')
    expect(f.d.state).toBe('idle')
    p.calls[0]!.resolve()
    await tick()
    expect(prompts(f)).toEqual([t0.messageUuid])
    await f.d.kill()
  })

  test('W10: a default send waiting while an agent-started turn opened is cancelled, not refused busy; the turn is interrupted', async () => {
    const { f, p, t0 } = await idleWhilePersisting()
    const a = f.d.send('a')
    await tick()
    f.q().push(frames.init('sess-new'))
    await f.q().drain()
    expect(f.d.state).toBe('active')
    const agentTurn = startedTurns(f)[1]
    expect(agentTurn).toBeDefined()
    expect(await f.d.interrupt()).toEqual(REQUESTED)
    expectInterrupted(await outcome(a))
    expect(interruptedTurns(f)).toEqual([agentTurn!])
    expect(f.d.state).toBe('idle')
    p.calls[0]!.resolve()
    await tick()
    expect(prompts(f)).toEqual([t0.messageUuid])
    await f.d.kill()
  })

  test('W02/W05: while starting, a receipt is requested; a send waiting on the start is refused at once and the start continues', async () => {
    const f = await starting({})
    expect(await f.d.interrupt()).toEqual(REQUESTED) // W02: the existing starting policy
    const a = f.d.send('a')
    expect(await outcome(a)).toBe('pending')
    expect(await f.d.interrupt()).toEqual(REQUESTED)
    expectInterrupted(await outcome(a))
    expect(f.d.state).toBe('starting')
    f.q().ready()
    await f.start
    await tick()
    expect(f.d.state).toBe('idle')
    expect(prompts(f)).toEqual([])
    await f.d.kill()
  })

  test('W06: stopping with a send waiting on the start: interrupt is refused stopped; the send is refused stopped once the start settles', async () => {
    const f = await starting({})
    const a = f.d.send('a')
    expect(await outcome(a)).toBe('pending')
    const stop = f.d.kill()
    expect(f.d.state).toBe('stopping')
    expectRefused(await rejection(f.d.interrupt()), 'stopped')
    expectRefused(await outcome(a), 'stopped')
    await stopError(stop)
    expect(allPrompts(f)).toEqual([])
  })

  test('W11: a send waiting on persistence while a restart is starting is refused at once; the restart continues as owned work', async () => {
    const { f, p, t0 } = await idleWhilePersisting()
    const a = f.d.send('a')
    await tick()
    await exitProcess(f)
    const restart = f.d.start()
    while (f.queries.length < 2) await tick()
    expect(f.d.state).toBe('starting')
    expect(await f.d.interrupt()).toEqual(REQUESTED)
    expectInterrupted(await outcome(a))
    expect(f.d.state).toBe('starting')
    f.q().ready()
    await restart
    p.calls[0]!.resolve()
    await tick()
    expect(f.d.state).toBe('idle')
    expect(allPrompts(f)).toEqual([t0.messageUuid])
    await f.d.kill()
  })

  test('W12: a send waiting on persistence after the process exited is refused at once; receipt requested; stays exited', async () => {
    const { f, p, t0 } = await idleWhilePersisting()
    const a = f.d.send('a')
    await tick()
    await exitProcess(f)
    expect(await f.d.interrupt()).toEqual(REQUESTED)
    expectInterrupted(await outcome(a))
    p.calls[0]!.resolve()
    await tick()
    expect(f.d.state).toBe('exited')
    expect(f.queries).toHaveLength(1)
    expect(allPrompts(f)).toEqual([t0.messageUuid])
    await f.d.kill()
  })

  test('W14: a send whose start finished but which has not resumed is refused at once (interrupt from onState(idle))', async () => {
    let receipt: Promise<unknown> | null = null
    const box: { f?: Awaited<ReturnType<typeof starting>> } = {}
    const f = await starting({
      onState: (state) => {
        if (state === 'idle' && receipt === null) receipt = box.f!.d.interrupt()
      },
    })
    box.f = f
    const a = f.d.send('a')
    f.q().ready()
    await f.start
    expect(await assigned(receipt)).toEqual(REQUESTED)
    expectInterrupted(await outcome(a))
    expect(prompts(f)).toEqual([])
    await f.d.kill()
  })
})

describe('interrupt while stopping or stopped (L13, A3)', () => {
  test('W13/W15/W04/X06: interrupt is refused stopped before any mutation; the waiting send is refused stopped after the joined persistence', async () => {
    const { f, p, t0 } = await idleWhilePersisting()
    const a = f.d.send('a')
    await tick()
    const stop = f.d.kill()
    expectRefused(await rejection(f.d.interrupt()), 'stopped')
    // The waiting send is not cancelled by the refused interrupt: it waits with the stop.
    expect(await outcome(a)).toBe('pending')
    p.calls[0]!.resolve()
    expectRefused(await outcome(a), 'stopped')
    expect((await stop).js).toBe('settled')
    expectRefused(await rejection(f.d.interrupt()), 'stopped')
    expectRefused(await rejection(f.d.send('after')), 'stopped')
    expect(prompts(f)).toEqual([t0.messageUuid])
  })

  test('X04: a send admitted in the same tick as kill is refused stopped; interrupt is refused stopped', async () => {
    const f = await idle({})
    const a = f.d.send('a')
    const stop = f.d.kill()
    expectRefused(await rejection(f.d.interrupt()), 'stopped')
    expectRefused(await outcome(a), 'stopped')
    await stop
    expect(prompts(f)).toEqual([])
  })
})

describe('the admission yield and failed starts (X01, X02, F01-F03)', () => {
  test('X01: without onCheckpoint, a default send and an interrupt in the same tick while idle: C, requested', async () => {
    const f = await idle({})
    const a = f.d.send('a')
    expect(await f.d.interrupt()).toEqual(REQUESTED)
    expectInterrupted(await outcome(a))
    expect(prompts(f)).toEqual([])
    expect(userMessages(f)).toEqual([])
    expect(f.d.state).toBe('idle')
    await f.d.kill()
  })

  test('X02: without onCheckpoint, a queued send and an interrupt in the same tick while active: C; the active turn is interrupted', async () => {
    const f = await idle({})
    const t0 = await f.d.send('first')
    const q = f.d.send('q', { continuation: 'queue' })
    expect(await f.d.interrupt()).toEqual(REQUESTED)
    expectInterrupted(await outcome(q))
    expect((await t0.result).outcome).toBe('interrupted')
    expect(prompts(f)).toEqual([t0.messageUuid])
    await f.d.kill()
  })

  test('F01/W16: the first start rejects and an interrupt comes before the waiting send observed it: C; start keeps its own rejection', async () => {
    let receipt: Promise<unknown> | null = null
    const box: { f?: Awaited<ReturnType<typeof starting>> } = {}
    const f = await starting({
      onState: (state) => {
        if (state === 'unstarted' && receipt === null) receipt = box.f!.d.interrupt()
      },
    })
    box.f = f
    const a = f.d.send('a')
    const cause = new Error('init failed')
    f.q().failInit(cause)
    const startError = await rejection(f.start)
    expect(startError.category).toBe('transport')
    expect(await assigned(receipt)).toEqual(REQUESTED)
    expectInterrupted(await outcome(a))
    await stopError(f.d.kill())
  })

  test('F02: a restart after an exit rejects and an interrupt comes before the waiting send observed it: C; requested', async () => {
    let armed = false
    let receipt: Promise<unknown> | null = null
    const box: { f?: Awaited<ReturnType<typeof idle>> } = {}
    const f = await idle({
      onState: (state) => {
        if (armed && state === 'exited' && receipt === null) receipt = box.f!.d.interrupt()
      },
    })
    box.f = f
    await exitProcess(f)
    const restart = f.d.start()
    restart.catch(() => {})
    while (f.queries.length < 2) await tick()
    const a = f.d.send('a')
    armed = true
    f.q().failInit(new Error('restart failed'))
    await rejection(restart)
    expect(await assigned(receipt)).toEqual(REQUESTED)
    expectInterrupted(await outcome(a))
    expect(f.d.state).toBe('exited')
    await stopError(f.d.kill())
  })

  test('F03: a send already refused by the failed start stays refused; the interrupt finds no waiter', async () => {
    const f = await starting({})
    const a = f.d.send('a')
    f.q().failInit(new Error('init failed'))
    expectRefused(await rejection(a), 'not-ready')
    expect(await f.d.interrupt()).toEqual(NO_ACTIVE_TURN)
    await stopError(f.d.kill())
  })
})

describe('the original wait reason after its cause settled (R01, R02)', () => {
  test('R01: the persistence resolved but the send has not resumed: C; requested; never enqueued', async () => {
    const { f, p, t0 } = await idleWhilePersisting()
    const a = f.d.send('a')
    await tick()
    p.calls[0]!.resolve()
    expect(await f.d.interrupt()).toEqual(REQUESTED)
    expectInterrupted(await outcome(a))
    await tick()
    expect(prompts(f)).toEqual([t0.messageUuid])
    await f.d.kill()
  })

  test('R02/WA2: the persistence rejected but the send has not resumed: C; the rejection stays sticky, observable and disposing; the stop reports the raw cause', async () => {
    const { f, p, t0 } = await idleWhilePersisting()
    const a = f.d.send('a')
    await tick()
    const cause = new Error('disk full')
    p.calls[0]!.reject(cause)
    expect(await f.d.interrupt()).toEqual(REQUESTED)
    expectInterrupted(await outcome(a))
    expect(errorCategories(f)).toContain('checkpoint')
    expect(['stopping', 'stopped']).toContain(f.d.state)
    const later = await rejection(f.d.send('later'))
    expectRefused(later, 'checkpoint')
    expect(later.causes[0]).toBe(cause)
    const stop = await stopError(f.d.kill())
    expect(stop?.category).toBe('stop')
    expect(stop?.causes).toContain(cause)
    expect(prompts(f)).toEqual([t0.messageUuid])
  })
})

describe('after the interrupt (WA3-WA6)', () => {
  test('WA3: a send made after the interrupt is new work: it waits for the persistence and is accepted after it, with queue accounting intact', async () => {
    const { f, p, t0 } = await persisting()
    const a = f.d.send('a', { continuation: 'queue' })
    await tick()
    expect(await f.d.interrupt()).toEqual(REQUESTED)
    expectInterrupted(await outcome(a))
    const b = f.d.send('b')
    expect(await outcome(b)).toBe('pending')
    p.calls[0]!.resolve()
    const hb = await b
    await tick()
    expect(prompts(f)).toEqual([t0.messageUuid, hb.messageUuid])
    expect(f.d.lifecycle.activeTurnId).toBe(hb.turnId)
    const c = await f.d.send('c', { continuation: 'queue' })
    f.q().push(frames.result([t0.messageUuid], 'late'), frames.result([hb.messageUuid], 'rb'))
    expect(await hb.result).toMatchObject({ turnId: hb.turnId, finalText: 'rb' })
    await f.q().drain()
    expect(f.d.lifecycle.activeTurnId).toBe(c.turnId)
    f.q().push(frames.result([c.messageUuid], 'rc'))
    expect(await c.result).toMatchObject({ turnId: c.turnId, finalText: 'rc' })
    expect(f.d.state).toBe('idle')
    await f.d.kill()
  })

  test('WA4: a stop after the interrupt waits for the persistence and fails with its raw cause', async () => {
    const { f, p } = await idleWhilePersisting()
    const a = f.d.send('a')
    await tick()
    expect(await f.d.interrupt()).toEqual(REQUESTED)
    expectInterrupted(await outcome(a))
    const stop = f.d.kill()
    expect(await outcome(stop)).toBe('pending')
    const cause = new Error('late')
    p.calls[0]!.reject(cause)
    const error = await stopError(stop)
    expect(error?.category).toBe('stop')
    expect(error?.causes).toContain(cause)
  })

  test('WA5: a second interrupt cancels only what exists when it is entered: no-active-turn', async () => {
    const { f, p } = await idleWhilePersisting()
    const a = f.d.send('a')
    await tick()
    expect(await f.d.interrupt()).toEqual(REQUESTED)
    expect(await f.d.interrupt()).toEqual(NO_ACTIVE_TURN)
    expectInterrupted(await outcome(a))
    p.calls[0]!.resolve()
    await f.d.kill()
  })

  test('WA6: an interrupt inside onCheckpoint cancels the outside waiter at once and never waits on its own persistence', async () => {
    const p = persistence()
    let inner: Promise<unknown> | null = null
    const box: { f?: Awaited<ReturnType<typeof idle>> } = {}
    const f = await idle({
      resume: null,
      onCheckpoint: (checkpoint) => {
        if (checkpoint.runtimeSessionId === 'sess-b') inner = box.f!.d.interrupt()
        return p.onCheckpoint(checkpoint)
      },
    })
    box.f = f
    const t0 = await f.d.send('first')
    f.q().push(frames.init('sess-a'), frames.init('sess-b'), frames.result([t0.messageUuid], 'zero'))
    await t0.result
    const w = f.d.send('w')
    w.catch(() => {}) // decided inside onCheckpoint; observed below
    await tick()
    p.calls[0]!.resolve()
    while (inner === null) await tick()
    expect(await assigned(inner)).toEqual(REQUESTED)
    expectInterrupted(await outcome(w))
    // The second persistence is still held: the interrupt did not wait for it.
    expect(p.calls).toHaveLength(2)
    p.calls[1]!.resolve()
    await tick()
    expect(prompts(f)).toEqual([t0.messageUuid])
    await f.d.kill()
  })
})
