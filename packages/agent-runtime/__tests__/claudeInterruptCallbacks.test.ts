// @reads: packages/agent-runtime/__tests__/fixtures/**
// Interrupt versus waiting sends when host callbacks reenter (task 4.4 Claude
// unit, R3 A4; rows C01-C04, B01-B04, P01-P02 of interruptWaitersSupplement.ts,
// results from interruptWaitersOutputs.ts). Waiting sends an interrupt cancels
// are decided before any callback it triggers; a send made from such a
// callback is new work. beforeSubmit runs before acceptance, which is
// revalidated after it. State publications are held while a turn opens or
// settles, so a callback sees a finished step. The admission rows X03 and X05
// need an exit inside a one-microtask window that the driver cannot schedule,
// so they run on the gate and the lifecycle it shares with the driver.
import { describe, expect, test } from 'bun:test'
import type { InterruptReceipt, TurnHandle } from '../src/contract.js'
import { CheckpointGate } from '../src/lifecycle/checkpoints.js'
import { DriverLifecycle } from '../src/lifecycle/lifecycle.js'
import type { Driver, DriverHooks } from './helpers/claudeDriverHarness.js'
import {
  NO_ACTIVE_TURN, REQUESTED, assigned, expectInterrupted, expectRefused, idle, interruptedTurns, outcome, persisting, prompts, rejection,
  startedTurns, tick, userMessages,
} from './helpers/checkpointHarness.js'
import { frames } from './helpers/controlledQuery.js'

/** Hooks that may call the driver they belong to. */
function late(): { box: { f?: Driver } } {
  return { box: {} }
}

describe('callbacks the interrupt triggers (C01-C04)', () => {
  test('C01: a send from onState(idle) during the interrupt is new work: A gets C, B waits for the persistence and is accepted after it', async () => {
    const { box } = late()
    let armed = false
    let b: Promise<TurnHandle> | null = null
    const hooks: DriverHooks = {
      onState: (state) => {
        if (armed && state === 'idle' && b === null) b = box.f!.d.send('b')
      },
    }
    const { f, p, t0 } = await persisting('sess-new', hooks)
    box.f = f
    const a = f.d.send('a', { continuation: 'queue' })
    await tick()
    armed = true
    expect(await f.d.interrupt()).toEqual(REQUESTED)
    expectInterrupted(await outcome(a))
    expect(b).not.toBeNull()
    expect(await outcome(b!)).toBe('pending')
    p.calls[0]!.resolve()
    const hb = await b!
    await tick()
    expect(prompts(f)).toEqual([t0.messageUuid, hb.messageUuid])
    expect(f.d.lifecycle.activeTurnId).toBe(hb.turnId)
    await f.d.kill()
  })

  test('C02: a nested interrupt from onState(idle) cancels nothing new; A is refused once and the turn is interrupted once', async () => {
    const { box } = late()
    let armed = false
    let nested: Promise<InterruptReceipt> | null = null
    const hooks: DriverHooks = {
      onState: (state) => {
        if (armed && state === 'idle' && nested === null) nested = box.f!.d.interrupt()
      },
    }
    const { f, p, t0 } = await persisting('sess-new', hooks)
    box.f = f
    const a = f.d.send('a', { continuation: 'queue' })
    await tick()
    armed = true
    expect(await f.d.interrupt()).toEqual(REQUESTED)
    expect(await assigned(nested)).toEqual(NO_ACTIVE_TURN)
    expectInterrupted(await outcome(a))
    expect(interruptedTurns(f)).toEqual([t0.turnId])
    expect(f.results.filter((r) => r.turnId === t0.turnId)).toHaveLength(1)
    p.calls[0]!.resolve()
    await tick()
    expect(prompts(f)).toEqual([t0.messageUuid])
    await f.d.kill()
  })

  test('C03: a kill from onState(idle) begins the stop without taking over A: A gets C, later sends are stopped, nothing returns to idle', async () => {
    const { box } = late()
    let armed = false
    let stop: Promise<unknown> | null = null
    const hooks: DriverHooks = {
      onState: (state) => {
        if (armed && state === 'idle' && stop === null) stop = box.f!.d.kill()
      },
    }
    const { f, p, t0 } = await persisting('sess-new', hooks)
    box.f = f
    const a = f.d.send('a', { continuation: 'queue' })
    await tick()
    armed = true
    const statesBefore = f.states.length
    expect(await f.d.interrupt()).toEqual(REQUESTED)
    expectInterrupted(await outcome(a))
    expect(stop).not.toBeNull()
    expectRefused(await rejection(f.d.send('later')), 'stopped')
    p.calls[0]!.resolve()
    await stop
    const after = f.states.slice(statesBefore)
    expect(after.slice(after.indexOf('stopping'))).toEqual(['stopping', 'stopped'])
    expect(prompts(f)).toEqual([t0.messageUuid])
  })

  test('C04: a queued send from onEvent(turn_interrupted) during the interrupt is new work: it waits for the persistence and is accepted', async () => {
    const { box } = late()
    let b: Promise<TurnHandle> | null = null
    const hooks: DriverHooks = {
      onEvent: (event) => {
        if (event.type === 'turn_interrupted' && b === null) b = box.f!.d.send('b', { continuation: 'queue' })
      },
    }
    const { f, p, t0 } = await persisting('sess-new', hooks)
    box.f = f
    const a = f.d.send('a', { continuation: 'queue' })
    await tick()
    expect(await f.d.interrupt()).toEqual(REQUESTED)
    expectInterrupted(await outcome(a))
    expect(await outcome(b!)).toBe('pending')
    p.calls[0]!.resolve()
    const hb = await b!
    await tick()
    expect(prompts(f)).toEqual([t0.messageUuid, hb.messageUuid])
    expect(startedTurns(f)).toEqual([t0.turnId, hb.turnId])
    await f.d.kill()
  })
})

describe('beforeSubmit after admission (B01-B04)', () => {
  /** An idle driver whose beforeSubmit runs `first` on its first call only, then answers with `decision`. */
  async function withBeforeSubmit(first: (f: Driver) => void, decision: { accepted: true } | { accepted: false; reason: string } = { accepted: true }) {
    const { box } = late()
    let calls = 0
    const f = await idle({
      beforeSubmit: () => {
        if (calls++ === 0) first(box.f!)
        return decision
      },
    })
    box.f = f
    return f
  }

  test('B01: beforeSubmit interrupts and then accepts: A gets C, nothing is enqueued and no handle returned; requested', async () => {
    let receipt: Promise<InterruptReceipt> | null = null
    const f = await withBeforeSubmit((d) => (receipt = d.d.interrupt()))
    const a = f.d.send('a')
    expectInterrupted(await outcome(a))
    expect(await assigned(receipt)).toEqual(REQUESTED)
    expect(prompts(f)).toEqual([])
    expect(userMessages(f)).toEqual([])
    expect(startedTurns(f)).toEqual([])
    expect(f.d.state).toBe('idle')
    await f.d.kill()
  })

  test('B02: beforeSubmit kills and then accepts: A is refused stopped and nothing is enqueued', async () => {
    let stop: Promise<unknown> | null = null
    const f = await withBeforeSubmit((d) => (stop = d.d.kill()))
    expectRefused(await outcome(f.d.send('a')), 'stopped')
    await stop
    expect(prompts(f)).toEqual([])
    expect(userMessages(f)).toEqual([])
  })

  test('B03: beforeSubmit sends W and interrupts: A and W were both waiting, both get C; requested', async () => {
    let w: Promise<TurnHandle> | null = null
    let receipt: Promise<InterruptReceipt> | null = null
    const f = await withBeforeSubmit((d) => {
      w = d.d.send('w')
      w.catch(() => {}) // decided at once; observed below
      receipt = d.d.interrupt()
    })
    const a = f.d.send('a')
    expectInterrupted(await outcome(a))
    expectInterrupted(await outcome(w!))
    expect(await assigned(receipt)).toEqual(REQUESTED)
    expect(prompts(f)).toEqual([])
    await f.d.kill()
  })

  test('B04: beforeSubmit refuses: A is refused with category context; the following interrupt finds no waiter', async () => {
    const f = await withBeforeSubmit(() => {}, { accepted: false, reason: 'no' })
    expectRefused(await outcome(f.d.send('a')), 'context')
    expect(await f.d.interrupt()).toEqual(NO_ACTIVE_TURN)
    expect(prompts(f)).toEqual([])
    await f.d.kill()
  })
})

describe('publications of an accepted send (P01, P02) and of turn settlement', () => {
  async function interruptedFrom(hooks: (call: () => void) => DriverHooks) {
    const { box } = late()
    let receipt: Promise<InterruptReceipt> | null = null
    let armed = false
    const call = () => {
      if (armed && receipt === null) receipt = box.f!.d.interrupt()
    }
    const f = await idle(hooks(call))
    box.f = f
    armed = true
    const handle = await f.d.send('a')
    await tick()
    return { f, handle, receipt: await assigned(receipt) }
  }

  function expectCoherent(f: Driver, handle: TurnHandle) {
    const own = f.events.filter((e) => 'turnId' in e && e.turnId === handle.turnId).map((e) => e.type)
    expect(own).toEqual(['turn_started', 'user_message', 'turn_interrupted'])
    expect(f.results.filter((r) => r.turnId === handle.turnId)).toHaveLength(1)
  }

  test('P01: an interrupt from onState(active) while A opens: A keeps its handle, its turn settles interrupted once, events in order', async () => {
    const { f, handle, receipt } = await interruptedFrom((call) => ({ onState: (state) => (state === 'active' ? call() : undefined) }))
    expect(receipt).toEqual(REQUESTED)
    expect(await handle.result).toMatchObject({ turnId: handle.turnId, messageUuid: handle.messageUuid, outcome: 'interrupted' })
    expectCoherent(f, handle)
    expect(f.d.state).toBe('idle')
    await f.d.kill()
  })

  test('P02: an interrupt from onEvent(user_message) for A: as P01', async () => {
    const { f, handle, receipt } = await interruptedFrom((call) => ({ onEvent: (event) => (event.type === 'user_message' ? call() : undefined) }))
    expect(receipt).toEqual(REQUESTED)
    expect(await handle.result).toMatchObject({ turnId: handle.turnId, outcome: 'interrupted' })
    expectCoherent(f, handle)
    expect(f.d.state).toBe('idle')
    await f.d.kill()
  })

  test('an interrupt from onState(idle) while a result settles its turn finds a finished turn: success, no-active-turn', async () => {
    const { box } = late()
    let receipt: Promise<InterruptReceipt> | null = null
    let armed = false
    const f = await idle({
      onState: (state) => {
        if (armed && state === 'idle' && receipt === null) receipt = box.f!.d.interrupt()
      },
    })
    box.f = f
    const t0 = await f.d.send('first')
    armed = true
    f.q().push(frames.result([t0.messageUuid], 'zero'))
    expect(await t0.result).toMatchObject({ outcome: 'success', finalText: 'zero' })
    expect(await assigned(receipt)).toEqual(NO_ACTIVE_TURN)
    expect(f.types()).toEqual(['turn_started', 'user_message', 'turn_completed'])
    await f.d.kill()
  })

  test('an interrupt from onState(active) while an agent-started turn opens sees it opened: turn_started before turn_interrupted', async () => {
    const { box } = late()
    let receipt: Promise<InterruptReceipt> | null = null
    const f = await idle({
      onState: (state) => {
        if (state === 'active' && receipt === null) receipt = box.f!.d.interrupt()
      },
    })
    box.f = f
    f.q().push(frames.init('sess-saved'))
    await f.q().drain()
    expect(await assigned(receipt)).toEqual(REQUESTED)
    expect(f.types()).toEqual(['turn_started', 'turn_interrupted'])
    expect(f.results).toEqual([expect.objectContaining({ outcome: 'interrupted' })])
    expect(f.d.state).toBe('idle')
    await f.d.kill()
  })
})

describe('admission rows on the gate and the shared lifecycle (X03, X05)', () => {
  /** The driver's interrupt order: cancel waiters, then the lifecycle step. */
  function interrupt(gate: CheckpointGate, lifecycle: DriverLifecycle): InterruptReceipt {
    const cancelled = gate.cancelWaiting()
    const receipt = lifecycle.interrupt()
    return cancelled > 0 ? REQUESTED : receipt
  }

  async function opened() {
    const lifecycle = new DriverLifecycle({ continuations: new Set(['queue']) })
    const gate = new CheckpointGate({ lifecycle, persist: undefined, failed: () => {} }, null)
    await lifecycle.start(async () => {})
    expect(lifecycle.state).toBe('idle')
    const committed: string[] = []
    const send = (text: string) => gate.admit(undefined, { prepare: () => text, commit: (_admission, prepared) => (committed.push(prepared), prepared) })
    return { lifecycle, gate, committed, send }
  }

  test('X03: a send admitted while idle, the process ended before it resumed: C; requested; stays exited', async () => {
    const { lifecycle, gate, committed, send } = await opened()
    const a = send('a')
    expect(lifecycle.processExit(1)).toBe('unexpected')
    expect(interrupt(gate, lifecycle)).toEqual(REQUESTED)
    expectInterrupted(await outcome(a))
    expect(committed).toEqual([])
    expect(lifecycle.state).toBe('exited')
  })

  test('X05: admitted while idle, the process ended and a restart began before it resumed: C; requested; the restart stays owned', async () => {
    const { lifecycle, gate, committed, send } = await opened()
    const a = send('a')
    lifecycle.processExit(1)
    let ready!: () => void
    const restart = lifecycle.start(() => new Promise<void>((resolve) => (ready = resolve)))
    expect(lifecycle.state).toBe('starting')
    expect(interrupt(gate, lifecycle)).toEqual(REQUESTED)
    expectInterrupted(await outcome(a))
    ready()
    await restart
    expect(lifecycle.state).toBe('idle')
    expect(committed).toEqual([])
    const receipt = await lifecycle.stop('kill', async () => [])
    expect(receipt.js).toBe('settled')
  })
})
